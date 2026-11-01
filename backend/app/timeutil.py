"""Business time zone handling.

Ticket timestamps are stored twice: a human-readable local string (`opened_at`,
"YYYY-MM-DD HH:MM:SS" in APP_TIMEZONE) and a Unix epoch (`opened_ts`). Servers may run in
UTC (Vercel does), so every conversion goes through the configured zone explicitly.
"""

from __future__ import annotations

import os
from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

FMT = "%Y-%m-%d %H:%M:%S"


@lru_cache(maxsize=1)
def tz() -> ZoneInfo:
    return ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Kolkata").strip() or "Asia/Kolkata")


def now() -> datetime:
    return datetime.now(tz()).replace(microsecond=0)


def fmt(dt: datetime) -> str:
    return dt.astimezone(tz()).strftime(FMT)


def to_ts(local_string: str | None) -> int | None:
    """'YYYY-MM-DD HH:MM:SS' in the business zone -> Unix seconds."""
    if not local_string:
        return None
    return int(datetime.strptime(local_string, FMT).replace(tzinfo=tz()).timestamp())


INPUT_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d",
                 "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y",
                 "%d-%b-%Y %H:%M:%S", "%d %b %Y %H:%M")


def parse_local(value: str | None) -> str | None:
    """Normalise a date/time typed by people or exported by tools to 'YYYY-MM-DD HH:MM:SS'.

    Day-first for ambiguous slash dates (the business is in India). Returns None for blanks;
    raises ValueError if the value can't be read.
    """
    value = (value or "").strip()
    if not value:
        return None
    for f in INPUT_FORMATS:
        try:
            return datetime.strptime(value, f).strftime(FMT)
        except ValueError:
            continue
    raise ValueError(f"unrecognised date/time '{value[:40]}'")


def local_date(ts: int) -> date:
    return datetime.fromtimestamp(ts, tz()).date()


def local_datetime(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz())
