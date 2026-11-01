"""Per-IP rate limiting (the app has no sign-in, and the URL is public).

Counters live in the graph as (:RateLimit) nodes, so limits hold across all Vercel
function instances. (FalkorDB Cloud users can't run plain SET/INCR commands, only graph
queries.) Fixed one-minute windows; expired counters are cleaned up occasionally.
If the store is unreachable, requests are allowed (fail open) and logged, so a database
blip doesn't take the whole API down.
"""

from __future__ import annotations

import hmac
import logging
import random
import time

from fastapi import HTTPException, Request

from . import db
from .config import get_settings

log = logging.getLogger(__name__)

COUNT_QUERY = """
MERGE (r:RateLimit {key: $key})
ON CREATE SET r.count = 0, r.expires = $expires
SET r.count = r.count + 1
RETURN r.count AS count
"""


def client_ip(request: Request) -> str:
    # Vercel sets x-forwarded-for; the first address is the original client.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")


def check(request: Request, bucket: str, limit: int) -> None:
    now = int(time.time())
    window = now // 60
    key = f"{bucket}:{client_ip(request)}:{window}"
    try:
        count = db.write(COUNT_QUERY, {"key": key, "expires": (window + 2) * 60})[0]["count"]
        if random.random() < 0.02:  # occasional cleanup keeps the graph small
            db.write("MATCH (r:RateLimit) WHERE r.expires < $now WITH r LIMIT 1000 DELETE r", {"now": now})
    except Exception as e:  # noqa: BLE001 - fail open on any store error
        log.warning("rate limit store unavailable: %s", e)
        return
    if count > limit:
        raise HTTPException(status_code=429, detail=f"Too many requests. Limit is {limit} per minute; "
                                                    "please wait a moment and try again.",
                            headers={"Retry-After": str(60 - now % 60)})


def chat_limit(request: Request) -> None:
    check(request, "chat", get_settings().rate_limit_chat_per_minute)


def write_limit(request: Request) -> None:
    check(request, "write", get_settings().rate_limit_write_per_minute)


def upload_limit(request: Request) -> None:
    """Uploads run the models over whole documents: a few per minute is plenty."""
    check(request, "upload", 6)


def require_admin(request: Request) -> None:
    """Uploads and deletes change shared data. If ADMIN_TOKEN is set, they need it in X-Admin-Token."""
    token = get_settings().admin_token
    if token and not hmac.compare_digest(request.headers.get("x-admin-token", ""), token):
        raise HTTPException(status_code=403, detail="Upload key required: enter the upload key on the Data page.")
