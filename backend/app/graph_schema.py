"""Graph schema (documentation) and index setup for the `it_support` graph.

Nodes
  (:Ticket {number, opened_at, opened_ts, resolved_at, resolved_ts, state, active, priority,
            short_description, description, resolution_notes, ...})
  (:User {email, name}) (:Department {name}) (:Location {name})
  (:Category {name}) (:Subcategory {name, key}) (:SupportGroup {name, description}) (:Agent {name})
  (:ConfigItem {name}) (:Device {model}) (:OS {name})
  (:KBArticle {kb_id, title, file_name, pages}) (:KBChunk {chunk_id, text, page, idx, embedding})
  (:Counter {name, value})            atomic counters (ticket numbers)
  (:RateLimit {key, count, expires})  per-IP request counters
  (:Entity {key, name, type})          GraphRAG entities: Product, Component, ErrorCode,
                                       Symptom, Cause, Fix
  (:Event {event_id, title, type, start_ts, end_ts, all_locations, link_rule, after_hours, ...})
                                       maintenance, power work, network change, update, outage,
                                       public holiday, Patch Tuesday
  (:Import {import_id, kind, file_name, created_ts, ...})   upload history (undo)

Relationships
  (Ticket)-[:RAISED_BY]->(User)-[:WORKS_IN]->(Department), (User)-[:BASED_AT]->(Location)
  (Ticket)-[:IN_SUBCATEGORY]->(Subcategory)-[:IN_CATEGORY]->(Category)
  (Subcategory)-[:ROUTED_TO]->(SupportGroup)          default routing for new tickets
  (Ticket)-[:ASSIGNED_TO]->(SupportGroup), (Ticket)-[:HANDLED_BY]->(Agent)-[:MEMBER_OF]->(SupportGroup)
  (Ticket)-[:AFFECTS]->(ConfigItem), (Ticket)-[:ON_DEVICE]->(Device), (Ticket)-[:RUNS]->(OS)
  (Ticket)-[:RESOLVED_WITH]->(KBArticle)
  (KBArticle)-[:COVERS]->(Subcategory), (KBArticle)-[:OWNED_BY]->(SupportGroup)
  (KBArticle)-[:HAS_CHUNK]->(KBChunk)-[:MENTIONS]->(Entity)
  (Ticket)-[:MENTIONS]->(Entity)
  (Entity)-[:CAUSED_BY|FIXED_BY|INDICATES|AFFECTS|PART_OF]->(Entity)
  (Event)-[:AT]->(Location), (Event)-[:IMPACTS]->(Subcategory)
  (Ticket)-[:AFFECTED_BY {reason}]->(Event)
"""

from . import db
from .config import get_settings

ENTITY_TYPES = ("Product", "Component", "ErrorCode", "Symptom", "Cause", "Fix")
ENTITY_RELATIONS = ("CAUSED_BY", "FIXED_BY", "INDICATES", "AFFECTS", "PART_OF")

RANGE_INDEXES = [
    ("Ticket", "number"), ("Ticket", "opened_ts"), ("Ticket", "state"), ("Ticket", "active"),
    ("User", "email"), ("Department", "name"), ("Location", "name"), ("Category", "name"),
    ("Subcategory", "name"), ("SupportGroup", "name"), ("Agent", "name"), ("ConfigItem", "name"),
    ("Device", "model"), ("OS", "name"), ("KBArticle", "kb_id"), ("KBChunk", "chunk_id"), ("Entity", "key"),
    ("Counter", "name"), ("RateLimit", "key"), ("Ticket", "import_id"), ("Ticket", "location"),
    ("Event", "event_id"), ("Event", "start_ts"), ("Event", "import_id"), ("Import", "import_id"),
    ("KBArticle", "import_id"),
]


def ensure_indexes(graph: str | None = None) -> None:
    """Create every index the app relies on (current workspace, or `graph`). Safe to run repeatedly."""
    for label, prop in RANGE_INDEXES:
        db.ensure_index(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})", graph)
    db.ensure_index("CREATE FULLTEXT INDEX FOR (t:Ticket) ON (t.short_description, t.description, t.resolution_notes)",
                    graph)
    db.ensure_index("CREATE FULLTEXT INDEX FOR (c:KBChunk) ON (c.text)", graph)
    db.ensure_index("CREATE FULLTEXT INDEX FOR (e:Entity) ON (e.name)", graph)
    dims = get_settings().embed_dimensions
    db.ensure_index(f"CREATE VECTOR INDEX FOR (c:KBChunk) ON (c.embedding) "
                    f"OPTIONS {{dimension: {dims}, similarityFunction: 'cosine'}}", graph)
