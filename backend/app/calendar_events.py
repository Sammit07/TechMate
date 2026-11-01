"""Business calendar: public holidays and Patch Tuesday, used by the forecaster.

Holidays are the Indian public holidays the offices observe. Update this list yearly
(dates of festivals such as Holi and Diwali move each year).
"""

from __future__ import annotations

from datetime import date, timedelta

HOLIDAYS = {
    # 2025
    date(2025, 10, 2), date(2025, 10, 20), date(2025, 10, 21), date(2025, 12, 25),
    # 2026
    date(2026, 1, 1), date(2026, 1, 26), date(2026, 3, 4), date(2026, 4, 3), date(2026, 5, 1),
    date(2026, 8, 15), date(2026, 9, 14), date(2026, 10, 2), date(2026, 10, 20), date(2026, 11, 9),
    date(2026, 12, 25),
    # 2027
    date(2027, 1, 1), date(2027, 1, 26), date(2027, 3, 22), date(2027, 3, 26), date(2027, 5, 1),
}


HOLIDAY_NAMES = {
    date(2025, 10, 2): "Gandhi Jayanti", date(2025, 10, 20): "Diwali", date(2025, 10, 21): "Diwali (day 2)",
    date(2025, 12, 25): "Christmas", date(2026, 1, 1): "New Year's Day", date(2026, 1, 26): "Republic Day",
    date(2026, 3, 4): "Holi", date(2026, 4, 3): "Good Friday", date(2026, 5, 1): "Maharashtra Day",
    date(2026, 8, 15): "Independence Day", date(2026, 9, 14): "Ganesh Chaturthi", date(2026, 10, 2): "Gandhi Jayanti",
    date(2026, 10, 20): "Dussehra", date(2026, 11, 9): "Diwali", date(2026, 12, 25): "Christmas",
    date(2027, 1, 1): "New Year's Day", date(2027, 1, 26): "Republic Day", date(2027, 3, 22): "Holi",
    date(2027, 3, 26): "Good Friday", date(2027, 5, 1): "Maharashtra Day",
}


def patch_tuesday(year: int, month: int) -> date:
    """Microsoft's monthly security updates: the second Tuesday of the month."""
    first = date(year, month, 1)
    return first + timedelta(days=(1 - first.weekday()) % 7 + 7)


def patch_offset(d: date) -> int | None:
    """Days since this month's Patch Tuesday, if within the 0-3 day window that drives tickets."""
    offset = (d - patch_tuesday(d.year, d.month)).days
    return offset if 0 <= offset <= 3 else None


def events_on(d: date) -> list[str]:
    out = []
    if d in HOLIDAYS:
        out.append("Public holiday")
    off = patch_offset(d)
    if off is not None:
        out.append("Patch Tuesday" if off == 0 else f"Patch Tuesday +{off}")
    return out
