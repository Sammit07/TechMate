"""Storage for uploaded original files (knowledge documents, notices).

Files are kept on local disk (UPLOAD_DIR) and served by GET /api/files/{kind}/{name}.
Serverless platforms such as Vercel have no persistent disk, so there `save` returns
None: the extracted text still lives in the graph and the UI shows that instead.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .config import get_settings
from .context import current_graph

KINDS = ("kb", "notices")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$")


def persistent() -> bool:
    return not os.getenv("VERCEL")


def safe_name(name: str) -> str:
    stem, ext = os.path.splitext(os.path.basename(name))
    stem = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()[:80] or "file"
    return f"{stem}{ext.lower()[:10]}"


def save(kind: str, name: str, data: bytes) -> str | None:
    """Store a file; returns the URL it is served from, or None if there is no persistent storage."""
    assert kind in KINDS
    if not persistent():
        return None
    folder = get_settings().upload_dir / current_graph() / kind
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(data)
    return f"/api/files/{kind}/{name}"


CATALOG_DIR = Path(__file__).resolve().parent.parent / "static" / "kb"  # the standard KB's PDFs (deployed)


def path_for(kind: str, name: str) -> Path | None:
    """Local path of a stored file, or None (unknown kind, unsafe name or missing file)."""
    if (kind not in KINDS and kind != "catalog") or not SAFE_NAME.match(name):
        return None
    folder = CATALOG_DIR if kind == "catalog" else (get_settings().upload_dir / current_graph() / kind).resolve()
    path = (folder / name).resolve()
    return path if path.parent == folder and path.is_file() else None


def delete(url: str | None) -> None:
    if not url or not url.startswith("/api/files/"):
        return
    kind, _, name = url.removeprefix("/api/files/").partition("/")
    path = path_for(kind, name)
    if path:
        path.unlink(missing_ok=True)
