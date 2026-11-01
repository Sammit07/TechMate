"""Service-desk taxonomy (categories, subcategories, routing) read from the graph.

The graph is the source of truth for routing: (Subcategory)-[:ROUTED_TO]->(SupportGroup).
Cached in-process for a few minutes because it rarely changes.
"""

from __future__ import annotations

import difflib
import re
import time

from .. import db
from ..context import current_graph

_CACHES: dict[str, dict] = {}  # per workspace (graph)


def _cache() -> dict:
    return _CACHES.setdefault(current_graph(), {"at": 0.0, "data": None})
TTL_SECONDS = 300
TRIAGE_GROUP = "Service Desk L1"


def taxonomy() -> dict:
    cache = _cache()
    if cache["data"] is not None and time.time() - cache["at"] < TTL_SECONDS:
        return cache["data"]
    subs = db.read(
        """
        MATCH (sc:Subcategory)-[:IN_CATEGORY]->(c:Category)
        OPTIONAL MATCH (sc)-[:ROUTED_TO]->(g:SupportGroup)
        RETURN sc.name AS name, sc.key AS key, c.name AS category, g.name AS group, sc.examples AS examples
        ORDER BY category, name
        """)
    groups = db.read("MATCH (g:SupportGroup) RETURN g.name AS name, g.description AS description ORDER BY name")
    data = {"subcategories": subs, "groups": groups,
            "categories": sorted({s["category"] for s in subs}),
            "by_name": {s["name"].lower(): s for s in subs}}
    cache.update(at=time.time(), data=data)
    return data


def invalidate() -> None:
    _cache().update(at=0.0, data=None)


def find_subcategory(name: str | None) -> dict | None:
    """Look up a subcategory by name, tolerating small variations in model output,
    e.g. "Account locked (Access & Identity)" or "Account lock" -> "Account locked"."""
    if not name:
        return None
    by_name = taxonomy()["by_name"]
    key = re.sub(r"\s*\(.*\)\s*$", "", name).strip().lower()
    if key in by_name:
        return by_name[key]
    close = difflib.get_close_matches(key, list(by_name), n=1, cutoff=0.8)
    return by_name[close[0]] if close else None


def group_exists(name: str) -> bool:
    return any(g["name"] == name for g in taxonomy()["groups"])
