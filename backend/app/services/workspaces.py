"""Workspaces: separate service desks, each in its own FalkorDB graph.

A workspace's tickets, knowledge base, events and uploads live in its own graph, so they
never mix. The registry of workspaces is a small graph of its own (META_GRAPH). The default
workspace is the graph in GRAPH_NAME (the demo data). New workspaces start either

  blank       the standard taxonomy (categories, subcategories, support groups) and the
              calendar (holidays, Patch Tuesday); bring your own tickets and documents
  knowledge   the above plus the standard IT knowledge base (106 articles)
"""

from __future__ import annotations

import logging
import re
import secrets
import shutil
import time
from datetime import timedelta

from .. import db, timeutil
from ..config import get_settings
from ..context import reset_graph, set_graph
from ..graph_schema import ensure_indexes
from . import events, taxonomy

log = logging.getLogger(__name__)

DEFAULT_ID = "default"
TEMPLATES = ("blank", "knowledge")
MAX_WORKSPACES = 12
MAX_MEMORY_SHARE = 0.75  # refuse new workspaces once the database is this full
CACHE_SECONDS = 30
_cache: dict = {"at": 0.0, "items": None}

# Operational data removed when a workspace is made from a copy of the default graph.
OPERATIONAL_LABELS = ("Ticket", "User", "Agent", "Department", "Location", "ConfigItem", "Device", "OS", "Import",
                      "Counter", "RateLimit")


def _meta() -> str:
    return get_settings().meta_graph


def ensure_registry() -> None:
    db.write("""MERGE (w:Workspace {id: $id})
                ON CREATE SET w.name = $name, w.graph = $graph, w.template = 'demo', w.created_at = $now""",
             {"id": DEFAULT_ID, "name": get_settings().default_workspace_name, "graph": get_settings().graph_name,
              "now": timeutil.fmt(timeutil.now())}, graph=_meta())


def list_workspaces(force: bool = False) -> list[dict]:
    if not force and _cache["items"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["items"]
    ensure_registry()
    items = db.read("MATCH (w:Workspace) RETURN w.id AS id, w.name AS name, w.graph AS graph, w.template AS template, "
                    "w.created_at AS created_at ORDER BY w.id = $default DESC, w.created_at",
                    {"default": DEFAULT_ID}, graph=_meta())
    _cache.update(at=time.time(), items=items)
    return items


def graph_for(workspace_id: str | None) -> str:
    """Graph name for a workspace id (from the cookie); unknown or missing -> the default workspace."""
    default = get_settings().graph_name
    if not workspace_id or workspace_id == DEFAULT_ID:
        return default
    try:
        return next((w["graph"] for w in list_workspaces() if w["id"] == workspace_id), default)
    except Exception:  # noqa: BLE001 - registry unreachable: fall back rather than fail every request
        log.warning("workspace registry unavailable; using the default workspace")
        return default


def get(workspace_id: str) -> dict | None:
    return next((w for w in list_workspaces() if w["id"] == workspace_id), None)


def summary(w: dict) -> dict:
    counts = db.read("OPTIONAL MATCH (t:Ticket) WITH count(t) AS tickets "
                     "OPTIONAL MATCH (k:KBArticle) RETURN tickets, count(k) AS articles", graph=w["graph"])[0]
    return {k: w[k] for k in ("id", "name", "template", "created_at")} | counts


def create(name: str, template: str) -> dict:
    name = re.sub(r"\s+", " ", name).strip()
    if not 2 <= len(name) <= 60:
        raise ValueError("Workspace name must be 2-60 characters")
    if template not in TEMPLATES:
        raise ValueError(f"Template must be one of {', '.join(TEMPLATES)}")
    existing = list_workspaces(force=True)
    if len(existing) >= MAX_WORKSPACES:
        raise ValueError(f"There are already {MAX_WORKSPACES} workspaces; delete one first")
    if any(w["name"].lower() == name.lower() for w in existing):
        raise ValueError("A workspace with that name already exists")
    mem = db.memory_usage_mb()
    if mem["max_mb"] and mem["used_mb"] / mem["max_mb"] > MAX_MEMORY_SHARE:
        raise ValueError(f"The database is {mem['used_mb']:.0f} of {mem['max_mb']:.0f} MB full; "
                         "delete a workspace or upgrade the database plan first")

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "workspace"
    ws_id = f"{slug}-{secrets.token_hex(2)}"
    graph = "tm_" + ws_id.replace("-", "_")
    source = get_settings().graph_name
    started = time.perf_counter()

    if template == "knowledge":
        db.get_db().connection.execute_command("GRAPH.COPY", source, graph)
    token = set_graph(graph)
    try:
        if template == "knowledge":
            _strip_to_knowledge()
        else:
            _seed_blank(source)
        ensure_indexes()
        today = timeutil.now().date()
        events.seed_calendar(today - timedelta(days=400), today + timedelta(days=180))
        taxonomy.invalidate()
    except Exception:
        db.get_graph(graph).delete()  # don't leave a half-made workspace behind
        raise
    finally:
        reset_graph(token)

    now = timeutil.fmt(timeutil.now())
    db.write("CREATE (:Workspace {id: $id, name: $name, graph: $graph, template: $template, created_at: $now})",
             {"id": ws_id, "name": name, "graph": graph, "template": template, "now": now}, graph=_meta())
    _cache.update(at=0.0, items=None)
    log.info("created workspace %s (%s, %s) in %.1fs", ws_id, name, template, time.perf_counter() - started)
    return summary({"id": ws_id, "name": name, "graph": graph, "template": template, "created_at": now})


def _strip_to_knowledge() -> None:
    """In a fresh copy of the default graph: keep taxonomy + standard KB, drop everything operational."""
    for label in OPERATIONAL_LABELS:
        while db.write(f"MATCH (n:{label}) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS n",
                       timeout_ms=120_000)[0]["n"]:
            pass
    db.write("MATCH (e:Event) DETACH DELETE e")
    db.write("MATCH (k:KBArticle) WHERE k.source = 'upload' OPTIONAL MATCH (k)-[:HAS_CHUNK]->(c:KBChunk) "
             "DETACH DELETE c, k")
    db.write("MATCH (e:Entity) WHERE NOT (e)<-[:MENTIONS]-(:KBChunk) DETACH DELETE e")
    db.write("MATCH (sc:Subcategory {source: 'import'}) DETACH DELETE sc")


def _seed_blank(source: str) -> None:
    """Copy the taxonomy (categories, subcategories, routing, groups) from the default workspace."""
    subs = db.read("""MATCH (sc:Subcategory)-[:IN_CATEGORY]->(c:Category) WHERE coalesce(sc.source, '') <> 'import'
                      OPTIONAL MATCH (sc)-[:ROUTED_TO]->(g:SupportGroup)
                      RETURN sc.name AS name, sc.key AS key, sc.ci_type AS ci_type, sc.examples AS examples,
                             sc.typical_minutes AS typical_minutes, c.name AS category, g.name AS grp""", graph=source)
    groups = db.read("MATCH (g:SupportGroup) WHERE g.description IS NOT NULL "
                     "RETURN g.name AS name, g.description AS description", graph=source)
    db.write("UNWIND $groups AS g MERGE (sg:SupportGroup {name: g.name}) SET sg.description = g.description",
             {"groups": groups})
    db.write("""UNWIND $subs AS s
                MERGE (c:Category {name: s.category})
                MERGE (sc:Subcategory {name: s.name})
                SET sc.key = s.key, sc.ci_type = s.ci_type, sc.examples = s.examples, sc.typical_minutes = s.typical_minutes
                MERGE (sc)-[:IN_CATEGORY]->(c)
                WITH sc, s WHERE s.grp IS NOT NULL
                MERGE (g:SupportGroup {name: s.grp})
                MERGE (sc)-[:ROUTED_TO]->(g)""", {"subs": subs})


def delete(workspace_id: str) -> None:
    if workspace_id == DEFAULT_ID:
        raise ValueError("The default workspace can't be deleted")
    w = get(workspace_id)
    if not w:
        raise LookupError(f"Workspace {workspace_id}")
    if db.graph_exists(w["graph"]):
        db.get_graph(w["graph"]).delete()
    db.write("MATCH (w:Workspace {id: $id}) DELETE w", {"id": workspace_id}, graph=_meta())
    shutil.rmtree(get_settings().upload_dir / w["graph"], ignore_errors=True)
    _cache.update(at=0.0, items=None)
    log.info("deleted workspace %s (%s)", workspace_id, w["name"])
