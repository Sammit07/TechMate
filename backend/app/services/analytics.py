"""Dashboard metrics over the ticket history.

Ticket facts are fetched in pages (FalkorDB caps a single result set) and aggregated in
Python, which keeps the metric definitions readable. Results are cached briefly so a
dashboard polling every few seconds doesn't reload everything each time.
"""

from __future__ import annotations

import statistics
import time
from collections import Counter, defaultdict
from datetime import date, timedelta

from .. import db, timeutil
from ..context import current_graph

PAGE = 5000
CACHE_SECONDS = 30
_caches: dict[str, dict] = {}  # per workspace (graph)


def _cache() -> dict:
    return _caches.setdefault(current_graph(), {"at": 0.0, "rows": None})

FIELDS = """t.number AS number, t.opened_ts AS opened, t.resolved_ts AS resolved, t.state AS state,
       t.active AS active, t.priority AS priority, t.category AS category, t.subcategory AS subcategory,
       t.assignment_group AS grp, t.contact_type AS channel, t.sla_breached AS breached,
       t.sla_target_minutes AS sla, t.first_contact_resolution AS fcr, t.reassignment_count AS reassigned,
       t.resolution_minutes AS minutes, t.short_description AS short_description"""


def invalidate() -> None:
    """Drop cached facts so the next dashboard request reflects a just-made change."""
    _cache().update(at=0.0, rows=None)


def ticket_facts(force: bool = False) -> list[dict]:
    """All tickets' metric fields, cached for a few seconds."""
    cache = _cache()
    if not force and cache["rows"] is not None and time.time() - cache["at"] < CACHE_SECONDS:
        return cache["rows"]
    rows, skip = [], 0
    while True:
        page = db.read(f"MATCH (t:Ticket) RETURN {FIELDS} ORDER BY t.opened_ts SKIP $skip LIMIT $limit",
                       {"skip": skip, "limit": PAGE}, timeout_ms=30_000)
        rows += page
        if len(page) < PAGE:
            break
        skip += PAGE
    cache.update(at=time.time(), rows=rows)
    return rows


def _pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def _daily_series(rows: list[dict], start: date, end: date, key: str) -> dict[date, int]:
    counts = Counter(timeutil.local_date(r[key]) for r in rows if r[key])
    return {start + timedelta(days=i): counts.get(start + timedelta(days=i), 0) for i in range((end - start).days + 1)}


def spikes(rows: list[dict], now_ts: int, weeks: int = 8) -> list[dict]:
    """Subcategories with unusually many tickets in the last 24 h, compared with the same
    24-hour window on the same weekday in previous weeks (a simple z-score)."""
    day = 86400
    recent = Counter(r["subcategory"] for r in rows if r["opened"] and now_ts - day <= r["opened"] <= now_ts)
    history: dict[str, list[int]] = defaultdict(lambda: [0] * weeks)
    for r in rows:
        if not r["opened"]:
            continue
        age = now_ts - r["opened"]
        for w in range(1, weeks + 1):
            if w * 7 * day <= age < w * 7 * day + day:
                history[r["subcategory"]][w - 1] += 1
    out = []
    for sub, n in recent.items():
        past = history.get(sub, [0] * weeks)
        mean = statistics.mean(past)
        sd = statistics.pstdev(past) or 1.0
        z = (n - mean) / sd
        if n >= 4 and z >= 3:
            out.append({"subcategory": sub, "last_24h": n, "typical": round(mean, 1), "z_score": round(z, 1)})
    return sorted(out, key=lambda s: -s["z_score"])


def dashboard(days: int = 30) -> dict:
    rows = ticket_facts()
    now = timeutil.now()
    now_ts = int(now.timestamp())
    today = now.date()
    start = today - timedelta(days=days - 1)
    start_ts = int(timeutil.to_ts(f"{start} 00:00:00"))
    today_ts = int(timeutil.to_ts(f"{today} 00:00:00"))

    period = [r for r in rows if r["opened"] and r["opened"] >= start_ts]
    resolved_period = [r for r in rows if r["resolved"] and r["resolved"] >= start_ts and r["minutes"] is not None]
    open_rows = [r for r in rows if r["active"]]
    open_overdue = [r for r in open_rows if r["sla"] and (now_ts - r["opened"]) / 60 > r["sla"]]
    minutes = sorted(r["minutes"] for r in resolved_period)

    kpis = {
        "open": len(open_rows),
        "open_by_state": dict(Counter(r["state"] for r in open_rows)),
        "open_by_priority": dict(Counter(r["priority"] for r in open_rows)),
        "open_past_sla": len(open_overdue),
        "created_today": sum(1 for r in rows if r["opened"] and r["opened"] >= today_ts),
        "resolved_today": sum(1 for r in rows if r["resolved"] and r["resolved"] >= today_ts),
        "created_period": len(period),
        "resolved_period": len(resolved_period),
        "sla_breach_rate": _pct(sum(1 for r in resolved_period if r["breached"]), len(resolved_period)),
        "first_contact_resolution_rate": _pct(sum(1 for r in resolved_period if r["fcr"]), len(resolved_period)),
        "median_resolution_hours": round(statistics.median(minutes) / 60, 1) if minutes else None,
        "p90_resolution_hours": round(minutes[int(len(minutes) * 0.9) - 1] / 60, 1) if minutes else None,
        "reassignment_rate": _pct(sum(1 for r in resolved_period if r["reassigned"]), len(resolved_period)),
    }

    created = _daily_series(period, start, today, "opened")
    resolved = _daily_series(resolved_period, start, today, "resolved")
    trend = [{"date": d.isoformat(), "created": created[d], "resolved": resolved[d]} for d in created]

    by_group = []
    for grp in sorted({r["grp"] for r in rows if r["grp"]}):
        g_open = [r for r in open_rows if r["grp"] == grp]
        g_res = [r for r in resolved_period if r["grp"] == grp]
        g_min = sorted(r["minutes"] for r in g_res)
        by_group.append({"group": grp, "open": len(g_open),
                         "open_past_sla": sum(1 for r in open_overdue if r["grp"] == grp),
                         "created_period": sum(1 for r in period if r["grp"] == grp),
                         "resolved_period": len(g_res),
                         "median_resolution_hours": round(statistics.median(g_min) / 60, 1) if g_min else None,
                         "sla_breach_rate": _pct(sum(1 for r in g_res if r["breached"]), len(g_res))})

    heat = Counter((timeutil.local_datetime(r["opened"]).weekday(), timeutil.local_datetime(r["opened"]).hour)
                   for r in period)
    recent = sorted(rows, key=lambda r: r["opened"] or 0, reverse=True)[:10]

    return {
        "generated_at": timeutil.fmt(now), "period_days": days, "kpis": kpis, "trend": trend,
        "by_category": [{"category": k, "count": v} for k, v in Counter(r["category"] for r in period).most_common()],
        "top_subcategories": [{"subcategory": k, "count": v}
                              for k, v in Counter(r["subcategory"] for r in period if r["subcategory"]).most_common(10)],
        "by_group": by_group,
        "by_channel": [{"channel": k, "count": v} for k, v in Counter(r["channel"] for r in period).most_common()],
        "by_priority": [{"priority": k, "count": v} for k, v in sorted(Counter(r["priority"] for r in period).items())],
        "heatmap": [{"weekday": wd, "hour": h, "count": heat.get((wd, h), 0)} for wd in range(7) for h in range(24)],
        "spikes": spikes(rows, now_ts),
        "open_past_sla": [{"number": r["number"], "short_description": r["short_description"],
                           "priority": r["priority"], "group": r["grp"],
                           "hours_open": round((now_ts - r["opened"]) / 3600, 1)}
                          for r in sorted(open_overdue, key=lambda r: r["opened"])[:10]],
        "recent": [{"number": r["number"], "short_description": r["short_description"], "state": r["state"],
                    "priority": r["priority"], "group": r["grp"],
                    "opened_at": timeutil.fmt(timeutil.local_datetime(r["opened"]))} for r in recent],
    }
