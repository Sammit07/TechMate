"""Password protection and per-request workspace selection.

Sign-in: one shared app password (APP_PASSWORD). A correct password gets a signed session
cookie (`techmate_session`: expiry + HMAC-SHA256), checked on every /api request except the
sign-in endpoints. The cookie is HttpOnly, SameSite=Lax and Secure over HTTPS, so page
scripts can't read it. With no APP_PASSWORD set, sign-in is off (local development).

Workspace: the `techmate_ws` cookie names the workspace; the request runs against its graph.
Both live in one pure-ASGI middleware, so the workspace also applies to streamed responses.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from http.cookies import SimpleCookie

from .config import get_settings
from .context import reset_graph, set_graph

SESSION_COOKIE = "techmate_session"
WORKSPACE_COOKIE = "techmate_ws"
OPEN_SESSION = "open"  # set when sign-in is off, so the frontend's sign-in check passes
PUBLIC_PATHS = {"/api/auth/login", "/api/auth/session", "/api/auth/logout", "/api/health"}


def auth_required() -> bool:
    return bool(get_settings().app_password)


def _secret() -> bytes:
    s = get_settings()
    return (s.auth_secret or hashlib.sha256(f"techmate-session:{s.app_password}".encode()).hexdigest()).encode()


def make_token(now: float | None = None) -> str:
    expires = int((now or time.time()) + get_settings().session_days * 86400)
    sig = hmac.new(_secret(), str(expires).encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}"


def valid_token(token: str | None) -> bool:
    if not auth_required():
        return True
    if not token or "." not in token:
        return False
    expires, sig = token.split(".", 1)
    if not expires.isdigit() or int(expires) < time.time():
        return False
    expected = hmac.new(_secret(), expires.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def check_password(password: str) -> bool:
    return auth_required() and hmac.compare_digest(password.encode(), get_settings().app_password.encode())


def cookies_of(scope: dict) -> dict[str, str]:
    jar = SimpleCookie()
    for name, value in scope.get("headers", []):
        if name == b"cookie":
            try:
                jar.load(value.decode("latin-1"))
            except Exception:  # noqa: BLE001 - malformed cookie header: treat as none
                pass
    return {k: m.value for k, m in jar.items()}


class AccessMiddleware:
    """Pure ASGI: enforce sign-in on /api and select the workspace graph for the request."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        cookies = cookies_of(scope)
        path = scope.get("path", "")
        if (path.startswith("/api/") and path not in PUBLIC_PATHS and scope.get("method") != "OPTIONS"
                and not valid_token(cookies.get(SESSION_COOKIE))):
            body = json.dumps({"detail": "Sign in required"}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        from .services.workspaces import graph_for  # late import: services import this package

        token = set_graph(graph_for(cookies.get(WORKSPACE_COOKIE)))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_graph(token)
