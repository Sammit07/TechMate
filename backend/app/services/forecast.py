"""Ticket-volume forecasting (pure Python, no numpy).

Model: additive Holt-Winters with a weekly season and a damped trend, plus calendar
effects learned from history (public holidays, the days after Patch Tuesday).
Parameters are picked by grid search on one-step-ahead error. Accuracy is measured by a
backtest on the most recent 28 days (held out from fitting) and compared with a
"same day last week" baseline.

Metric: WAPE (sum of absolute errors / sum of actuals). Unlike MAPE it stays meaningful
on low-volume weekend days.
"""

from __future__ import annotations

import itertools
import math
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from .. import db, timeutil
from ..context import current_graph
from ..calendar_events import HOLIDAYS, events_on, patch_offset
from .analytics import ticket_facts

SEASON = 7
BACKTEST_DAYS = 28
MIN_HISTORY_DAYS = 56   # 8 weeks: enough for weekly seasonality plus a 4-week backtest
GRID = {"alpha": (0.05, 0.1, 0.2, 0.35, 0.5), "beta": (0.0, 0.02, 0.05), "gamma": (0.05, 0.1, 0.2, 0.3),
        "phi": (0.9, 0.98)}
CACHE_SECONDS = 900
_cache: dict = {}


def invalidate() -> None:
    """Drop cached forecasts so the next request refits on the latest tickets."""
    for key in [k for k in _cache if k.startswith(f"{current_graph()}:")]:
        _cache.pop(key, None)


@dataclass
class Fit:
    params: tuple[float, float, float, float]
    level: float
    trend: float
    season: list[float]           # last SEASON seasonal values, aligned so season[i] is for (n + i) % 7
    resid_sd: float
    sse: float


def _holt_winters(y: list[float], alpha: float, beta: float, gamma: float, phi: float) -> Fit:
    m = SEASON
    level = statistics.mean(y[:m])
    trend = (statistics.mean(y[m:2 * m]) - level) / m if len(y) >= 2 * m else 0.0
    season = [y[i] - level for i in range(m)]
    sse, resid = 0.0, []
    for t in range(m, len(y)):
        s = season[t % m]
        pred = level + phi * trend + s
        err = y[t] - pred
        sse += err * err
        resid.append(err)
        new_level = alpha * (y[t] - s) + (1 - alpha) * (level + phi * trend)
        trend = beta * (new_level - level) + (1 - beta) * phi * trend
        season[t % m] = gamma * (y[t] - new_level) + (1 - gamma) * s
        level = new_level
    n = len(y)
    aligned = [season[(n + i) % m] for i in range(m)]
    return Fit((alpha, beta, gamma, phi), level, trend, aligned,
               statistics.pstdev(resid) if resid else 0.0, sse)


def _fit(y: list[float]) -> Fit:
    best = None
    for a, b, g, p in itertools.product(GRID["alpha"], GRID["beta"], GRID["gamma"], GRID["phi"]):
        f = _holt_winters(y, a, b, g, p)
        if best is None or f.sse < best.sse:
            best = f
    return best


def _predict(fit: Fit, horizon: int) -> list[float]:
    alpha, _, _, phi = fit.params
    out, damp = [], 0.0
    for h in range(1, horizon + 1):
        damp += phi ** h
        out.append(fit.level + damp * fit.trend + fit.season[(h - 1) % SEASON])
    return out


def _clean_for_fit(days: list[date], y: list[float]) -> list[float]:
    """Holidays distort the weekly pattern: replace them with the same weekday a week earlier."""
    cleaned = list(y)
    for i, d in enumerate(days):
        if d in HOLIDAYS and i >= SEASON:
            cleaned[i] = cleaned[i - SEASON]
    return cleaned


def _calendar_factors(days: list[date], y: list[float]) -> dict[str, float]:
    """Multiplicative effects: actual / (mean of the same weekday in the two prior weeks)."""
    ratios: dict[str, list[float]] = defaultdict(list)
    for i, d in enumerate(days):
        if i < 2 * SEASON:
            continue
        expected = (y[i - SEASON] + y[i - 2 * SEASON]) / 2
        if expected < 1:
            continue
        if d in HOLIDAYS:
            ratios["holiday"].append(y[i] / expected)
        off = patch_offset(d)
        if off is not None and d not in HOLIDAYS:
            ratios[f"patch_{off}"].append(y[i] / expected)
    # Median is robust to outage days; ignore effects with too little evidence.
    return {k: round(statistics.median(v), 3) for k, v in ratios.items() if len(v) >= 3}


def _apply_calendar(d: date, value: float, factors: dict[str, float]) -> float:
    if d in HOLIDAYS:
        return value * factors.get("holiday", 1.0)
    off = patch_offset(d)
    if off is not None:
        return value * factors.get(f"patch_{off}", 1.0)
    return value


def _series(rows: list[dict], key=None) -> tuple[list[date], dict[str, list[float]]]:
    """Daily counts up to yesterday (today is incomplete), overall or grouped by `key`."""
    yesterday = timeutil.now().date() - timedelta(days=1)
    dated = [(timeutil.local_date(r["opened"]), r) for r in rows if r["opened"]]
    first = min(d for d, _ in dated)
    days = [first + timedelta(days=i) for i in range((yesterday - first).days + 1)]
    index = {d: i for i, d in enumerate(days)}
    out: dict[str, list[float]] = defaultdict(lambda: [0.0] * len(days))
    for d, r in dated:
        if d in index:
            out["all" if key is None else (r[key] or "Unknown")][index[d]] += 1
    return days, dict(out)


def _forecast_series(days: list[date], y: list[float], horizon: int) -> dict:
    fit = _fit(_clean_for_fit(days, y))
    factors = _calendar_factors(days, y)
    future = [days[-1] + timedelta(days=h) for h in range(1, horizon + 1)]
    alpha = fit.params[0]
    points = []
    for h, (d, base) in enumerate(zip(future, _predict(fit, horizon)), 1):
        value = max(0.0, _apply_calendar(d, base, factors))
        spread = 1.28 * fit.resid_sd * math.sqrt(1 + (h - 1) * alpha ** 2)  # ~80 % interval
        points.append({"date": d.isoformat(), "expected": round(value, 1),
                       "low": round(max(0.0, value - spread), 1), "high": round(value + spread, 1),
                       "events": events_on(d)})
    return {"points": points, "params": dict(zip(("alpha", "beta", "gamma", "phi"), fit.params)),
            "calendar_factors": factors}


def _backtest(days: list[date], y: list[float]) -> dict:
    """Fit on everything except the last BACKTEST_DAYS, forecast them, and score."""
    cut = len(y) - BACKTEST_DAYS
    model = _forecast_series(days[:cut], y[:cut], BACKTEST_DAYS)
    predicted = [p["expected"] for p in model["points"]]
    actual = y[cut:]
    baseline = [y[cut - SEASON + (i % SEASON)] for i in range(BACKTEST_DAYS)]  # same weekday last week
    total = sum(actual) or 1.0
    wape = sum(abs(a - p) for a, p in zip(actual, predicted)) / total
    base_wape = sum(abs(a - b) for a, b in zip(actual, baseline)) / total
    # Weekly totals matter most for staffing: error of each 7-day sum.
    weekly = [(sum(actual[i:i + 7]), sum(predicted[i:i + 7])) for i in range(0, BACKTEST_DAYS - 6, 7)]
    weekly_err = [abs(a - p) / a for a, p in weekly if a]
    return {"holdout_days": BACKTEST_DAYS, "wape_pct": round(100 * wape, 1),
            "weekly_total_error_pct": round(100 * statistics.mean(weekly_err), 1) if weekly_err else None,
            "baseline_wape_pct": round(100 * base_wape, 1),
            "mae": round(sum(abs(a - p) for a, p in zip(actual, predicted)) / len(actual), 2),
            "improvement_vs_baseline_pct": round(100 * (base_wape - wape) / base_wape, 1) if base_wape else None,
            "actual_total": int(sum(actual)), "predicted_total": round(sum(predicted), 1),
            "points": [{"date": d.isoformat(), "actual": int(a), "predicted": p}
                       for d, a, p in zip(days[cut:], actual, predicted)]}


def forecast(horizon: int = 14) -> dict:
    key = f"{current_graph()}:h{horizon}"  # per workspace
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    started = time.perf_counter()
    rows = ticket_facts()
    history_days = len({timeutil.local_date(r["opened"]) for r in rows if r["opened"]})
    if history_days < MIN_HISTORY_DAYS:
        # A new workspace: weekly seasonality and a backtest need several weeks of tickets.
        return {"generated_at": timeutil.fmt(timeutil.now()), "horizon_days": horizon, "insufficient_data": True,
                "history_days": history_days, "min_history_days": MIN_HISTORY_DAYS, "tickets": len(rows)}
    days, series = _series(rows)
    y = series["all"]
    overall = _forecast_series(days, y, horizon)

    def breakdown(field: str) -> list[dict]:
        _, groups = _series(rows, field)
        out = []
        for name, values in groups.items():
            if sum(values[-56:]) < 10:  # too little recent data for a meaningful forecast
                continue
            pts = _forecast_series(days, values, horizon)["points"]
            out.append({"name": name, "next_7_days": round(sum(p["expected"] for p in pts[:7]), 1),
                        "next_horizon": round(sum(p["expected"] for p in pts), 1),
                        "last_7_days": int(sum(values[-7:]))})
        return sorted(out, key=lambda r: -r["next_7_days"])

    # Planned operational events in the horizon (holidays/Patch Tuesday are already calendar effects).
    operational = []
    if overall["points"]:
        lo = overall["points"][0]["date"] + " 00:00:00"
        hi = overall["points"][-1]["date"] + " 23:59:59"
        operational = db.read(
            "MATCH (e:Event) WHERE NOT e.type IN ['Public holiday', 'Patch Tuesday'] AND e.start_ts <= $hi "
            "AND e.end_ts >= $lo RETURN e.event_id AS event_id, e.title AS title, e.type AS type, "
            "e.start_at AS start_at, e.end_at AS end_at ORDER BY e.start_ts",
            {"lo": timeutil.to_ts(lo), "hi": timeutil.to_ts(hi)})
        for p in overall["points"]:
            p["events"] = p["events"] + [e["title"] for e in operational
                                         if e["start_at"][:10] <= p["date"] <= e["end_at"][:10]]

    result = {
        "generated_at": timeutil.fmt(timeutil.now()),
        "horizon_days": horizon,
        "operational_events": operational,
        "history": [{"date": d.isoformat(), "actual": int(v)} for d, v in zip(days[-56:], y[-56:])],
        "forecast": overall["points"],
        "next_7_days_total": round(sum(p["expected"] for p in overall["points"][:7]), 1),
        "last_7_days_total": int(sum(y[-7:])),
        "model": {"type": "Holt-Winters (additive, weekly season, damped trend) + calendar effects",
                  **overall["params"], "calendar_factors": overall["calendar_factors"],
                  "training_days": len(y)},
        "backtest": _backtest(days, y),
        "by_category": breakdown("category"),
        "by_group": breakdown("grp"),
        "compute_ms": round((time.perf_counter() - started) * 1000),
    }
    _cache[key] = (time.time(), result)
    return result
