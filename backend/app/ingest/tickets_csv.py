"""Ticket import from a ServiceNow incident export (CSV).

Expected columns (same names and order as the service desk's export; matching ignores case):
Number, User, Location, Service offering, CMDB CI, Category, Reporting category,
Reporting category 2, Assignment group, Priority, State, Short description, Description,
Assigned to, Opened at, System updated on, Opened by, Work notes, Close code, Close notes,
Resolved by, Calendar duration, Comments, Reassignment count, Active, Resolved at, Closed at,
Category item, Contact type.

Only Number, Short description, Priority, State and Opened at are required. Fields the
export has no column for are derived: device/OS from the description, the KB article from
the work notes, impact/urgency from priority, SLA from priority and duration. Rows whose
Number already exists replace the existing ticket. Unknown subcategories are added to the
taxonomy and routed to the row's assignment group.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from dataclasses import dataclass, field

from .. import db, timeutil
from ..services import analytics, events, forecast, taxonomy
from ..services.taxonomy import TRIAGE_GROUP, find_subcategory
from . import imports, knowledge

log = logging.getLogger(__name__)

COLUMNS = ["Number", "User", "Location", "Service offering", "CMDB CI", "Category", "Reporting category",
           "Reporting category 2", "Assignment group", "Priority", "State", "Short description", "Description",
           "Assigned to", "Opened at", "System updated on", "Opened by", "Work notes", "Close code", "Close notes",
           "Resolved by", "Calendar duration", "Comments", "Reassignment count", "Active", "Resolved at",
           "Closed at", "Category item", "Contact type"]
REQUIRED = ("Number", "Short description", "Priority", "State", "Opened at")
MAX_ROWS = 20_000
MAX_ERRORS = 50
BATCH = 250

SLA_MINUTES = {"1 - Critical": 240, "2 - High": 480, "3 - Moderate": 1440, "4 - Low": 4320}
PRIORITIES = {"1": "1 - Critical", "2": "2 - High", "3": "3 - Moderate", "4": "4 - Low", "5": "4 - Low"}
STATES = {"new": "New", "in progress": "In Progress", "work in progress": "In Progress", "active": "In Progress",
          "on hold": "On Hold", "pending": "On Hold", "awaiting caller": "On Hold", "resolved": "Resolved",
          "closed": "Closed", "canceled": "Closed", "cancelled": "Closed"}
IMPACT_URGENCY = {"1 - Critical": ("1 - High", "1 - High"), "2 - High": ("1 - High", "2 - Medium"),
                  "3 - Moderate": ("2 - Medium", "2 - Medium"), "4 - Low": ("3 - Low", "3 - Low")}
NUMBER_RE = re.compile(r"^[A-Z]{2,6}\d{4,10}$")
DEVICE_RE = re.compile(r"Device: (.+?) \((.+?)\)\.")
LOCATION_RE = re.compile(r"Location: ([^.]+)\.")
KB_RE = re.compile(r"\bKB\d{7}\b")


@dataclass
class Parsed:
    rows: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    total: int = 0


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("Could not read the file as text; save it as CSV (UTF-8)")


def _int(value: str | None) -> int | None:
    try:
        return int(float(value)) if value not in (None, "") else None
    except ValueError:
        return None


def parse(data: bytes) -> Parsed:
    """Read and validate the CSV. Bad rows are reported, not imported."""
    reader = csv.DictReader(io.StringIO(_decode(data)))
    if not reader.fieldnames:
        raise ValueError("The file is empty")
    canonical = {c.lower(): c for c in COLUMNS}
    header = {h: canonical.get((h or "").strip().lower()) for h in reader.fieldnames}
    missing = [c for c in REQUIRED if c not in header.values()]
    if missing:
        raise ValueError(f"Missing required column(s): {', '.join(missing)}. Expected the ServiceNow incident "
                         f"export columns ({', '.join(COLUMNS[:6])}, ...).")
    out = Parsed()
    unknown = [h for h, c in header.items() if c is None and h]
    if unknown:
        out.warnings.append(f"Ignored {len(unknown)} unknown column(s): {', '.join(unknown[:8])}")
    absent = [c for c in COLUMNS if c not in header.values()]
    if absent:
        out.warnings.append(f"{len(absent)} optional column(s) not in the file: {', '.join(absent[:8])}")

    seen: set[str] = set()
    for line, raw in enumerate(reader, start=2):
        out.total += 1
        if out.total > MAX_ROWS:
            raise ValueError(f"Too many rows: the limit is {MAX_ROWS:,} per file")
        r = {c: "" for c in COLUMNS}
        for h, c in header.items():
            if c:
                r[c] = (raw.get(h) or "").strip()
        try:
            out.rows.append(_normalise(r, seen))
        except ValueError as e:
            if len(out.errors) < MAX_ERRORS:
                out.errors.append({"row": line, "number": r["Number"] or None, "error": str(e)})
    if out.total == 0:
        raise ValueError("The file has a header but no rows")
    return out


def _normalise(r: dict, seen: set[str]) -> dict:
    number = r["Number"].upper()
    if not NUMBER_RE.match(number):
        raise ValueError(f"invalid Number '{r['Number'][:20]}' (expected e.g. INC1001001)")
    if number in seen:
        raise ValueError(f"duplicate Number {number}")
    seen.add(number)
    if not r["Short description"]:
        raise ValueError("Short description is empty")
    priority = PRIORITIES.get(r["Priority"][:1])
    if not priority:
        raise ValueError(f"invalid Priority '{r['Priority'][:20]}' (expected 1 - Critical ... 4 - Low)")
    state = STATES.get(r["State"].lower())
    if not state:
        raise ValueError(f"invalid State '{r['State'][:20]}'")
    r.update(Number=number, Priority=priority, State=state,
             **{c: timeutil.parse_local(r[c]) for c in ("Opened at", "Resolved at", "Closed at", "System updated on")})
    if not r["Opened at"]:
        raise ValueError("Opened at is empty")
    return r


def ticket_row(r: dict, subcategory: str, category: str | None, now_ts: int, *, source: str,
               import_id: str | None) -> dict:
    """One parsed CSV row -> parameters for the write query."""
    active = (r["Active"].lower() == "true") if r["Active"] else r["State"] in ("New", "In Progress", "On Hold")
    device = DEVICE_RE.search(r["Description"])
    kb = KB_RE.search(r["Work notes"])
    location = r["Location"] or (m.group(1).strip() if (m := LOCATION_RE.search(r["Description"])) else None)
    opened_ts, resolved_ts = timeutil.to_ts(r["Opened at"]), timeutil.to_ts(r["Resolved at"])
    seconds = _int(r["Calendar duration"])
    if seconds is None and resolved_ts:
        seconds = resolved_ts - opened_ts
    minutes = round(seconds / 60) if seconds is not None else None
    sla = SLA_MINUTES[r["Priority"]]
    age = minutes if minutes is not None else (now_ts - opened_ts) / 60
    impact, urgency = IMPACT_URGENCY[r["Priority"]]
    caller = r["User"] or "Unknown caller"
    return {
        "subcategory": subcategory, "caller": caller, "caller_email": email_for(caller), "location": location,
        "group": r["Assignment group"] or TRIAGE_GROUP, "agent": r["Assigned to"] or None,
        "ci": r["CMDB CI"] or None, "device": device.group(1) if device else None,
        "os": device.group(2) if device else None,
        "props": {k: v for k, v in {
            "number": r["Number"], "opened_at": r["Opened at"], "opened_ts": opened_ts,
            "resolved_at": r["Resolved at"], "resolved_ts": resolved_ts, "closed_at": r["Closed at"],
            "updated_at": r["System updated on"], "state": r["State"], "active": active, "priority": r["Priority"],
            "impact": impact, "urgency": urgency, "category": category, "subcategory": subcategory,
            "location": location, "service_offering": r["Service offering"] or None,
            "opened_by": r["Opened by"] or None, "short_description": r["Short description"],
            "description": r["Description"] or r["Short description"],
            "contact_type": r["Contact type"] or "Self-service", "assignment_group": r["Assignment group"] or TRIAGE_GROUP,
            "reassignment_count": _int(r["Reassignment count"]) or 0,
            "first_contact_resolution": "first contact" in r["Work notes"].lower(),
            "resolution_minutes": minutes if resolved_ts else None, "sla_target_minutes": sla, "sla_breached": age > sla,
            "resolution_code": r["Close code"] or None, "resolution_notes": r["Close notes"] or None,
            "resolved_by": r["Resolved by"] or None, "work_notes": r["Work notes"] or None,
            "comments": r["Comments"] or None, "kb_article": kb.group(0) if kb else None,
            "source": source, "import_id": import_id,
        }.items() if v is not None},
    }


def email_for(name: str) -> str:
    return ".".join(re.sub(r"[^a-z]", "", part) for part in name.lower().split()) + "@company.example"


WRITE_TICKETS = """
UNWIND $rows AS r
CREATE (t:Ticket) SET t = r.props
WITH t, r
MATCH (sc:Subcategory {name: r.subcategory})
MERGE (g:SupportGroup {name: r.group})
MERGE (u:User {email: r.caller_email}) ON CREATE SET u.name = r.caller
CREATE (t)-[:IN_SUBCATEGORY]->(sc), (t)-[:ASSIGNED_TO]->(g), (t)-[:RAISED_BY]->(u)
FOREACH (x IN CASE WHEN r.location IS NULL THEN [] ELSE [r.location] END |
         MERGE (l:Location {name: x}) MERGE (u)-[:BASED_AT]->(l))
FOREACH (x IN CASE WHEN r.ci IS NULL THEN [] ELSE [r.ci] END |
         MERGE (ci:ConfigItem {name: x}) CREATE (t)-[:AFFECTS]->(ci))
FOREACH (x IN CASE WHEN r.device IS NULL THEN [] ELSE [r.device] END |
         MERGE (d:Device {model: x}) CREATE (t)-[:ON_DEVICE]->(d))
FOREACH (x IN CASE WHEN r.os IS NULL THEN [] ELSE [r.os] END |
         MERGE (o:OS {name: x}) CREATE (t)-[:RUNS]->(o))
FOREACH (x IN CASE WHEN r.agent IS NULL THEN [] ELSE [r.agent] END |
         MERGE (a:Agent {name: x}) MERGE (a)-[:MEMBER_OF]->(g) CREATE (t)-[:HANDLED_BY]->(a))
"""

NEW_SUBCATEGORIES = """
UNWIND $subs AS s
MERGE (c:Category {name: s.category})
MERGE (sc:Subcategory {name: s.name})
ON CREATE SET sc.key = s.key, sc.ci_type = s.ci_type, sc.examples = s.examples, sc.source = 'import'
MERGE (g:SupportGroup {name: s.group})
MERGE (sc)-[:IN_CATEGORY]->(c)
MERGE (sc)-[:ROUTED_TO]->(g)
"""


def _label(r: dict) -> str:
    return r["Category item"] or r["Reporting category 2"] or r["Category"] or "General"


def resolve_subcategories(rows: list[dict]) -> tuple[dict[str, str], list[dict]]:
    """Map each row's 'Category item' (or 'Reporting category 2') to a taxonomy subcategory.

    Returns (row label -> subcategory name, new subcategories to create)."""
    mapping: dict[str, str] = {}
    new: dict[str, dict] = {}
    for r in rows:
        label = _label(r)
        if label in mapping:
            continue
        found = find_subcategory(label) or (find_subcategory(r["Reporting category 2"])
                                            if r["Reporting category 2"] else None)
        if found:
            mapping[label] = found["name"]
            continue
        mapping[label] = label
        new.setdefault(label, {"name": label, "key": re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_"),
                               "category": r["Category"] or "Other", "group": r["Assignment group"] or TRIAGE_GROUP,
                               "ci_type": r["CMDB CI"] or "Other", "examples": []})
        if len(new[label]["examples"]) < 5:
            new[label]["examples"].append(r["Short description"])
    return mapping, list(new.values())


def write_tickets(rows: list[dict], *, source: str, import_id: str | None,
                  progress=None) -> tuple[list[str], list[dict]]:
    """Write parsed rows (replacing tickets with the same number). Returns (numbers, new subcategories)."""
    mapping, new_subs = resolve_subcategories(rows)
    for subs in knowledge.batched(new_subs, 200):
        db.write(NEW_SUBCATEGORIES, {"subs": subs})
    if new_subs:
        taxonomy.invalidate()

    numbers = [r["Number"] for r in rows]
    for b in knowledge.batched(numbers, 1000):
        db.write("MATCH (t:Ticket) WHERE t.number IN $n DETACH DELETE t", {"n": b}, timeout_ms=60_000)
    now_ts = int(timeutil.now().timestamp())
    by_name = taxonomy.taxonomy()["by_name"]
    params = []
    for r in rows:
        sub = mapping[_label(r)]
        category = by_name[sub.lower()]["category"] if sub.lower() in by_name else (r["Category"] or "Other")
        params.append(ticket_row(r, sub, category, now_ts, source=source, import_id=import_id))
    for i, b in enumerate(knowledge.batched(params, BATCH)):
        db.write(WRITE_TICKETS, {"rows": b}, timeout_ms=60_000)
        if progress:
            progress(min((i + 1) * BATCH, len(params)), len(params))
    return numbers, new_subs


def bump_ticket_counter(numbers: list[str]) -> None:
    """Keep new ticket numbers above every imported INC number."""
    top = max((int(n[3:]) for n in numbers if n.startswith("INC") and n[3:].isdigit()), default=0)
    if top:
        db.write("MERGE (c:Counter {name: 'ticket'}) ON CREATE SET c.value = $v "
                 "SET c.value = CASE WHEN c.value < $v THEN $v ELSE c.value END", {"v": top})


def import_csv(file_name: str, data: bytes, *, dry_run: bool = False) -> dict:
    parsed = parse(data)
    existing = set()
    for b in knowledge.batched([r["Number"] for r in parsed.rows], 2000):
        existing |= {r["n"] for r in db.read("MATCH (t:Ticket) WHERE t.number IN $n RETURN t.number AS n", {"n": b})}
    mapping, new_subs = resolve_subcategories(parsed.rows)
    summary = {"rows_total": parsed.total, "rows_valid": len(parsed.rows), "rows_invalid": parsed.total - len(parsed.rows),
               "new_tickets": len(parsed.rows) - len(existing), "replaced_tickets": len(existing),
               "new_subcategories": [s["name"] for s in new_subs][:30],
               "opened_from": min((r["Opened at"] for r in parsed.rows), default=None),
               "opened_to": max((r["Opened at"] for r in parsed.rows), default=None)}
    result = {**summary, "errors": parsed.errors, "warnings": parsed.warnings, "dry_run": dry_run,
              "preview": [{"number": r["Number"], "short_description": r["Short description"], "priority": r["Priority"],
                           "state": r["State"], "assignment_group": r["Assignment group"], "opened_at": r["Opened at"],
                           "subcategory": mapping[_label(r)]}
                          for r in parsed.rows[:5]]}
    if dry_run or not parsed.rows:
        return result

    import_id = imports.new_import_id()
    numbers, _ = write_tickets(parsed.rows, source="import", import_id=import_id)
    mentions = knowledge.link_ticket_entities(numbers)
    linked = events.link_tickets_to_events(numbers)
    bump_ticket_counter(numbers)
    analytics.invalidate()
    forecast.invalidate()
    imports.record(import_id, "tickets", file_name, {
        "rows": len(numbers), "new_tickets": summary["new_tickets"], "replaced_tickets": summary["replaced_tickets"],
        "rows_invalid": summary["rows_invalid"], "new_subcategories": len(new_subs)})
    log.info("imported %d tickets from %s as %s (%d entity links, %d event links)",
             len(numbers), file_name, import_id, mentions, linked)
    return {**result, "import_id": import_id, "entity_links": mentions, "event_links": linked}
