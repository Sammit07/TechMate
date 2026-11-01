"""Ticket operations: create, list, get, update. All queries are fixed and parameterised."""

from __future__ import annotations

import logging
import time
from datetime import datetime

from .. import db, timeutil
from ..config import get_settings
from ..retrieval import match_entities, search_terms
from ..schemas import OPEN_STATES, CreateTicketRequest, TicketDraft, UpdateTicketRequest
from . import analytics, events, forecast
from .taxonomy import TRIAGE_GROUP, find_subcategory, group_exists

log = logging.getLogger(__name__)

SLA_MINUTES = {"1 - Critical": 240, "2 - High": 480, "3 - Moderate": 1440, "4 - Low": 4320}
LEVELS = {1: "1 - High", 2: "2 - Medium", 3: "3 - Low"}
# ServiceNow service offering per category (same values as the ticket history export).
SERVICE_OFFERING = {"Access & Identity": "Identity Services", "Network & Connectivity": "Network Services",
                    "Hardware": "End User Computing", "Operating System": "End User Computing",
                    "Software & Applications": "Business Applications",
                    "Email & Collaboration": "Messaging Services", "Printing & Scanning": "Print Services",
                    "Mobile Devices": "Mobile Services", "Security": "Security Services"}
OUTAGE_WINDOW_SECONDS = 2 * 3600
OUTAGE_THRESHOLD = 4  # open tickets in one subcategory within the window -> possible major incident

SUMMARY_FIELDS = """t.number AS number, t.short_description AS short_description, t.state AS state,
       t.priority AS priority, t.category AS category, t.subcategory AS subcategory,
       t.assignment_group AS assignment_group, t.opened_at AS opened_at, t.sla_breached AS sla_breached"""


class TicketNotFound(LookupError):
    pass


def _now() -> datetime:
    return timeutil.now()


def _fmt(dt: datetime) -> str:
    return timeutil.fmt(dt)


def next_number() -> str:
    """Atomic ticket number from a counter node, seeded from the highest existing number."""
    top = db.read("MATCH (c:Counter {name: 'ticket'}) RETURN c.value AS v")
    seed = 0 if top else (db.read("MATCH (t:Ticket) RETURN max(toInteger(substring(t.number, 3))) AS n")[0]["n"]
                          or 2000000)
    return f"INC{db.increment_counter('ticket', seed=seed)}"


def create_ticket(req: CreateTicketRequest, draft: TicketDraft | None = None) -> dict:
    """Create a ticket. Routing, priority and SLA come from the draft/classification."""
    sub = find_subcategory(req.subcategory or (draft.subcategory if draft else None))
    priority = req.priority or (draft.priority if draft else "3 - Moderate")
    impact, urgency = (draft.impact, draft.urgency) if draft else (3, 2)
    group = (draft.assignment_group if draft and group_exists(draft.assignment_group)
             else (sub["group"] if sub else TRIAGE_GROUP))
    category = sub["category"] if sub else (draft.category if draft else "Unclassified")
    opened = _now()
    number = next_number()
    props = {
        "number": number, "opened_at": _fmt(opened), "opened_ts": int(opened.timestamp()), "updated_at": _fmt(opened),
        "state": "New", "active": True, "priority": priority,
        "impact": LEVELS[impact], "urgency": LEVELS[urgency],
        "category": category, "service_offering": SERVICE_OFFERING.get(category),
        "subcategory": sub["name"] if sub else None,
        "short_description": req.short_description.strip(), "description": req.description.strip(),
        "contact_type": req.contact_type, "assignment_group": group, "reassignment_count": 0,
        "opened_by": req.caller_name.strip() if req.contact_type in ("Chat", "Self-service") else "Service Desk L1",
        "first_contact_resolution": False, "sla_target_minutes": SLA_MINUTES[priority], "sla_breached": False,
        "source": "assistant" if req.contact_type == "Chat" else "portal",
        "classification_confidence": draft.confidence if draft else None,
    }
    if req.location:
        props["location"] = req.location.strip()
    db.write(
        """
        CREATE (t:Ticket) SET t = $props
        WITH t
        MERGE (u:User {email: $email}) SET u.name = $name
        CREATE (t)-[:RAISED_BY]->(u)
        WITH t, u
        MERGE (g:SupportGroup {name: $group})
        CREATE (t)-[:ASSIGNED_TO]->(g)
        WITH t, u
        OPTIONAL MATCH (sc:Subcategory {name: $sub})
        FOREACH (_ IN CASE WHEN sc IS NULL THEN [] ELSE [1] END | CREATE (t)-[:IN_SUBCATEGORY]->(sc))
        FOREACH (d IN CASE WHEN $department IS NULL THEN [] ELSE [$department] END |
                 MERGE (dep:Department {name: d}) MERGE (u)-[:WORKS_IN]->(dep))
        FOREACH (l IN CASE WHEN $location IS NULL THEN [] ELSE [$location] END |
                 MERGE (loc:Location {name: l}) MERGE (u)-[:BASED_AT]->(loc))
        """,
        {"props": props, "email": req.caller_email.lower(), "name": req.caller_name.strip(), "group": group,
         "sub": props["subcategory"], "department": req.department, "location": req.location})

    # Link the entities the ticket mentions (GraphRAG), so it shows up as a similar ticket later.
    text = f"{req.short_description} {req.description}"
    keys = [e["key"] for e in match_entities(search_terms(text, 20), text)
            if e["type"] in ("Product", "Component", "ErrorCode")]
    if keys:
        db.write("MATCH (t:Ticket {number: $n}) UNWIND $keys AS k MATCH (e:Entity {key: k}) "
                 "MERGE (t)-[:MENTIONS]->(e)", {"n": number, "keys": keys})

    # Maintenance, power work or an outage happening now may explain it: link and tell the caller.
    events.link_tickets_to_events([number])
    analytics.invalidate()
    forecast.invalidate()
    ticket = get_ticket(number)
    ticket["possible_major_incident"] = _outage_signal(props["subcategory"])
    log.info("created %s (%s, %s -> %s)", number, props["subcategory"], priority, group)
    return ticket


def _outage_signal(subcategory: str | None) -> dict | None:
    if not subcategory:
        return None
    since = int(time.time()) - OUTAGE_WINDOW_SECONDS
    n = db.read("MATCH (t:Ticket) WHERE t.subcategory = $s AND t.active = true AND t.opened_ts >= $since "
                "RETURN count(t) AS n", {"s": subcategory, "since": since})[0]["n"]
    if n >= OUTAGE_THRESHOLD:
        return {"subcategory": subcategory, "open_tickets_last_2h": n,
                "message": f"{n} open '{subcategory}' tickets in the last 2 hours: possible major incident."}
    return None


def get_ticket(number: str) -> dict:
    rows = db.read(
        """
        MATCH (t:Ticket {number: $n})
        OPTIONAL MATCH (t)-[:RAISED_BY]->(u:User)
        OPTIONAL MATCH (u)-[:WORKS_IN]->(d:Department)
        OPTIONAL MATCH (u)-[:BASED_AT]->(l:Location)
        WITH t, u, d, head(collect(l.name)) AS user_location
        OPTIONAL MATCH (t)-[:HANDLED_BY]->(a:Agent)
        OPTIONAL MATCH (t)-[:RESOLVED_WITH]->(k:KBArticle)
        OPTIONAL MATCH (t)-[:ON_DEVICE]->(dev:Device)
        RETURN properties(t) AS ticket, u.name AS caller, u.email AS caller_email, d.name AS department,
               coalesce(t.location, user_location) AS location, a.name AS assigned_to, dev.model AS device,
               CASE WHEN k IS NULL THEN NULL ELSE {kb_id: k.kb_id, title: k.title, file_name: k.file_name, file_url: k.file_url} END
                 AS kb_article
        """, {"n": number.strip().upper()})
    if not rows:
        raise TicketNotFound(number)
    row = rows[0]
    ticket = row.pop("ticket")
    ticket.pop("kb_article", None)
    ticket = {**ticket, **row}
    ticket["events"] = events.events_for_ticket(ticket["number"])
    return ticket


def list_tickets(*, state: str | None = None, group: str | None = None, subcategory: str | None = None,
                 priority: str | None = None, q: str | None = None, limit: int = 50, offset: int = 0) -> dict:
    where, params = [], {"limit": limit, "offset": offset}
    if state == "open":
        where.append("t.active = true")
    elif state == "closed":
        where.append("NOT t.active")  # FalkorDB: `active = false` matches nothing (boolean index quirk)
    elif state:
        where.append("t.state = $state")
        params["state"] = state
    for field, value in (("assignment_group", group), ("subcategory", subcategory), ("priority", priority)):
        if value:
            where.append(f"t.{field} = ${field}")
            params[field] = value
    if q:
        terms = search_terms(q, 6)
        if terms:  # full-text candidates first, then the filters above apply
            nums = set()
            for term in terms:
                nums |= {r["n"] for r in db.read("CALL db.idx.fulltext.queryNodes('Ticket', $q) YIELD node "
                                                 "RETURN node.number AS n LIMIT 500", {"q": term})}
            if q.strip().upper().startswith("INC"):
                nums.add(q.strip().upper())
            where.append("t.number IN $nums")
            params["nums"] = list(nums)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = db.read(f"MATCH (t:Ticket) {clause} RETURN count(t) AS n", params)[0]["n"]
    items = db.read(f"MATCH (t:Ticket) {clause} WITH t ORDER BY t.opened_ts DESC SKIP $offset LIMIT $limit "
                    f"OPTIONAL MATCH (t)-[:AFFECTED_BY]->(e:Event) WHERE NOT e.type IN ['Public holiday'] "
                    f"RETURN {SUMMARY_FIELDS}, collect(e.title)[..2] AS events ORDER BY opened_at DESC, number DESC", params)
    return {"total": total, "items": items, "limit": limit, "offset": offset}


def update_ticket(number: str, req: UpdateTicketRequest) -> dict:
    current = get_ticket(number)
    changes: dict = {}
    now = _now()
    notes: list[str] = []

    if req.priority and req.priority != current["priority"]:
        changes.update(priority=req.priority, sla_target_minutes=SLA_MINUTES[req.priority])
        notes.append(f"Priority {current['priority']} -> {req.priority}")
    if req.assignment_group and req.assignment_group != current["assignment_group"]:
        if not group_exists(req.assignment_group):
            raise ValueError(f"Unknown support group '{req.assignment_group}'")
        changes.update(assignment_group=req.assignment_group,
                       reassignment_count=(current.get("reassignment_count") or 0) + 1)
        notes.append(f"Reassigned to {req.assignment_group}")
    if req.resolution_notes:
        changes["resolution_notes"] = req.resolution_notes.strip()
    if req.state and req.state != current["state"]:
        changes.update(state=req.state, active=req.state in OPEN_STATES)
        notes.append(f"State {current['state']} -> {req.state}")
        if req.state in ("Resolved", "Closed") and not current.get("resolved_ts"):
            minutes = round((now.timestamp() - current["opened_ts"]) / 60)
            target = changes.get("sla_target_minutes", current["sla_target_minutes"])
            changes.update(resolved_at=_fmt(now), resolved_ts=int(now.timestamp()), resolution_minutes=minutes,
                           sla_breached=minutes > target, resolution_code="Solved (Permanently)",
                           resolved_by=req.assigned_to or current.get("assigned_to"))
            if not (req.resolution_notes or current.get("resolution_notes")):
                raise ValueError("Resolution notes are required to resolve a ticket")
        if req.state == "Closed":
            changes["closed_at"] = _fmt(now)
        if req.state in OPEN_STATES and current.get("resolved_ts"):  # reopened
            changes.update(resolved_at=None, resolved_ts=None, resolution_minutes=None, closed_at=None)
    if req.work_note:
        notes.append(req.work_note.strip())

    if notes:
        line = f"[{_fmt(now)}] " + "; ".join(notes)
        changes["work_notes"] = f"{current.get('work_notes') or ''}\n{line}".strip()
    if not changes and not req.assigned_to:
        return current
    changes["updated_at"] = _fmt(now)

    db.write("MATCH (t:Ticket {number: $n}) SET t += $changes", {"n": current["number"], "changes": changes})
    analytics.invalidate()
    if "assignment_group" in changes:
        db.write("""MATCH (t:Ticket {number: $n})-[r:ASSIGNED_TO]->() DELETE r
                    WITH DISTINCT 1 AS _ MATCH (t:Ticket {number: $n}), (g:SupportGroup {name: $g})
                    CREATE (t)-[:ASSIGNED_TO]->(g)""", {"n": current["number"], "g": changes["assignment_group"]})
    if req.assigned_to:
        db.write("""MATCH (t:Ticket {number: $n}) OPTIONAL MATCH (t)-[r:HANDLED_BY]->() DELETE r
                    WITH DISTINCT 1 AS _ MATCH (t:Ticket {number: $n})
                    MERGE (a:Agent {name: $a}) CREATE (t)-[:HANDLED_BY]->(a)""",
                 {"n": current["number"], "a": req.assigned_to.strip()})
    return get_ticket(current["number"])
