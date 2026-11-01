"""Upload history: every CSV import, document and notice upload is an (:Import) node,
so an upload can be listed and undone."""

from __future__ import annotations

import logging

from .. import db, storage, timeutil
from ..services import analytics, forecast, taxonomy

log = logging.getLogger(__name__)

KINDS = ("tickets", "document", "notice")


def new_import_id() -> str:
    return f"IMP{db.increment_counter('import', seed=1000):05d}"


def record(import_id: str, kind: str, file_name: str, summary: dict) -> dict:
    now = timeutil.now()
    props = {"import_id": import_id, "kind": kind, "file_name": file_name, "created_at": timeutil.fmt(now),
             "created_ts": int(now.timestamp()), **{k: v for k, v in summary.items() if v is not None}}
    db.write("CREATE (i:Import) SET i = $props", {"props": props})
    return props


def list_imports(limit: int = 50) -> list[dict]:
    return [r["i"] for r in db.read("MATCH (i:Import) RETURN properties(i) AS i ORDER BY i.created_ts DESC LIMIT $n",
                                    {"n": limit})]


def _remove_orphans() -> None:
    """After removing imported tickets: drop people, places and taxonomy that only they used."""
    db.write("MATCH (sc:Subcategory {source: 'import'}) WHERE NOT (sc)<-[:IN_SUBCATEGORY]-(:Ticket) "
             "AND NOT (sc)<-[:COVERS]-(:KBArticle) AND NOT (sc)<-[:IMPACTS]-(:Event) DETACH DELETE sc")
    db.write("MATCH (c:Category) WHERE NOT (c)<-[:IN_CATEGORY]-(:Subcategory) DETACH DELETE c")
    db.write("MATCH (u:User) WHERE NOT (u)<-[:RAISED_BY]-(:Ticket) DETACH DELETE u", timeout_ms=60_000)
    db.write("MATCH (a:Agent) WHERE NOT (a)<-[:HANDLED_BY]-(:Ticket) DETACH DELETE a")
    db.write("MATCH (g:SupportGroup) WHERE g.description IS NULL AND NOT (g)<-[:ASSIGNED_TO]-(:Ticket) "
             "AND NOT (g)<-[:ROUTED_TO]-(:Subcategory) AND NOT (g)<-[:OWNED_BY]-(:KBArticle) DETACH DELETE g")
    for label, rel in (("Location", "BASED_AT"), ("ConfigItem", "AFFECTS"), ("Device", "ON_DEVICE"), ("OS", "RUNS")):
        db.write(f"MATCH (n:{label}) WHERE NOT (n)<-[:{rel}]-() AND NOT (n)<-[:AT]-(:Event) DETACH DELETE n",
                 timeout_ms=60_000)


def delete_import(import_id: str) -> dict:
    """Undo an upload: remove the tickets, knowledge article or events it created."""
    rows = db.read("MATCH (i:Import {import_id: $id}) RETURN properties(i) AS i", {"id": import_id})
    if not rows:
        raise LookupError(import_id)
    imp = rows[0]["i"]
    removed = 0
    if imp["kind"] == "tickets":
        while n := db.write("MATCH (t:Ticket {import_id: $id}) WITH t LIMIT 2000 DETACH DELETE t RETURN count(*) AS n",
                            {"id": import_id})[0]["n"]:
            removed += n
        _remove_orphans()
        analytics.invalidate()
        forecast.invalidate()
    elif imp["kind"] == "document":
        for r in db.read("MATCH (k:KBArticle {import_id: $id}) RETURN k.file_url AS url", {"id": import_id}):
            storage.delete(r["url"])
        removed = db.write("MATCH (k:KBArticle {import_id: $id}) OPTIONAL MATCH (k)-[:HAS_CHUNK]->(c:KBChunk) "
                           "DETACH DELETE c, k RETURN count(DISTINCT k) AS n", {"id": import_id})[0]["n"]
        # Entities only this document mentioned are now orphans.
        db.write("MATCH (e:Entity) WHERE NOT (e)<-[:MENTIONS]-(:KBChunk) DETACH DELETE e")
    elif imp["kind"] == "notice":
        if imp.get("file_url"):
            storage.delete(imp["file_url"])
        removed = db.write("MATCH (e:Event {import_id: $id}) DETACH DELETE e RETURN count(e) AS n",
                           {"id": import_id})[0]["n"]
    db.write("MATCH (i:Import {import_id: $id}) DELETE i", {"id": import_id})
    taxonomy.invalidate()
    log.info("undid import %s (%s): removed %d", import_id, imp["kind"], removed)
    return {"import_id": import_id, "kind": imp["kind"], "removed": removed}
