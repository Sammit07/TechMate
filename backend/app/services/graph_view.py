"""Network-graph views of how a ticket was raised, routed and resolved, and what affected it.

Nodes are laid out left to right in layers so the routing reads as a flow:

  0 inputs           caller, location, channel, device, and events that affected the ticket
  1 ticket
  2 classification   subcategory, category, entities mentioned
  3 routing          Service Desk L1 -> reassignments -> assigned group -> agent
  4 outcome          resolution, KB article used, similar resolved tickets

Node `type` (colour in the UI): ticket, event, context, classification, routing, outcome.
"""

from __future__ import annotations

import re

from .. import db
from ..retrieval import similar_to_ticket
from . import events
from .taxonomy import TRIAGE_GROUP
from .tickets import get_ticket

LAYERS = ["Inputs", "Ticket", "Classification", "Routing", "Outcome"]
EVENT_LAYERS = ["Where & what", "Event", "Incidents", "Routing", "Outcome"]
REASSIGN_RE = re.compile(r"(?:Reassigned to|Routed from Service Desk L1 to) ([^;.\n]+)")
OPEN_STATES = ("New", "In Progress", "On Hold")


class _Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.links: list[dict] = []

    def node(self, node_id: str, type_: str, kind: str, label: str, layer: int, *, detail: str | None = None,
             href: str | None = None) -> str:
        if node_id not in self.nodes:
            self.nodes[node_id] = {"id": node_id, "type": type_, "kind": kind, "label": label, "layer": layer,
                                   "detail": detail, "href": href}
        return node_id

    def link(self, source: str, target: str, label: str, *, dashed: bool = False, detail: str | None = None) -> None:
        if source != target and not any(l["source"] == source and l["target"] == target for l in self.links):
            self.links.append({"source": source, "target": target, "label": label, "dashed": dashed, "detail": detail})

    def result(self, focus: dict, layers: list[str] = LAYERS) -> dict:
        return {"focus": focus, "layers": layers, "nodes": list(self.nodes.values()), "links": self.links}


def _event_node(g: _Graph, e: dict, layer: int) -> str:
    when = f"{e['start_at'][:16]} → {e['end_at'][:16]}"
    return g.node(f"event:{e['event_id']}", "event", e["type"], e["title"], layer,
                  detail=f"{e['type']} · {when}", href=f"/graph?event={e['event_id']}")


def ticket_graph(number: str) -> dict:
    t = get_ticket(number)
    g = _Graph()
    tid = g.node(f"ticket:{t['number']}", "ticket", f"{t['priority'][4:]} · {t['state']}", t["number"], 1,
                 detail=f"{t['short_description']} · {t['priority']} · {t['state']}", href=f"/tickets/{t['number']}")

    # Inputs
    if t.get("caller"):
        g.link(g.node(f"user:{t.get('caller_email') or t['caller']}", "context", "Caller", t["caller"], 0),
               tid, "raised")
    location = t.get("location")
    if location:
        g.link(g.node(f"location:{location}", "context", "Location", location, 0), tid, "at")
    if t.get("contact_type"):
        g.link(g.node(f"channel:{t['contact_type']}", "context", "Channel", t["contact_type"], 0), tid, "via")
    if t.get("device"):
        g.link(g.node(f"device:{t['device']}", "context", "Device", t["device"], 0), tid, "on")
    for e in events.events_for_ticket(t["number"]):
        g.link(_event_node(g, e, 0), tid, "affected", dashed=True, detail=e.get("reason"))

    # Classification
    sub = t.get("subcategory")
    sid = None
    if sub:
        sid = g.node(f"sub:{sub}", "classification", "Subcategory", sub, 2)
        g.link(tid, sid, "classified as")
        if t.get("category"):
            g.link(sid, g.node(f"cat:{t['category']}", "classification", "Category", t["category"], 2), "in")
    for e in db.read("MATCH (:Ticket {number: $n})-[:MENTIONS]->(e:Entity) RETURN e.name AS name, e.type AS type "
                     "LIMIT 6", {"n": t["number"]}):
        if sub and e["name"].lower() == sub.lower():  # same as the subcategory: don't draw it twice
            continue
        g.link(tid, g.node(f"entity:{e['type']}:{e['name']}", "classification", e["type"], e["name"], 2), "mentions")

    # Routing: logged with the service desk, then routed/reassigned to the group that owns it.
    triage = g.node(f"group:{TRIAGE_GROUP}", "routing", "Support group", TRIAGE_GROUP, 3, detail="Triage (L1)")
    g.link(tid, triage, "logged with")
    hops = [h.strip() for h in REASSIGN_RE.findall(t.get("work_notes") or "")]
    if t["assignment_group"] != TRIAGE_GROUP and t["assignment_group"] not in hops:
        hops.append(t["assignment_group"])
    previous = triage
    for i, hop in enumerate(hops):
        gid = g.node(f"group:{hop}", "routing", "Support group", hop, 3)
        g.link(previous, gid, "routed to" if i == 0 else "reassigned to")
        previous = gid
    assigned = g.node(f"group:{t['assignment_group']}", "routing", "Support group", t["assignment_group"], 3,
                      detail="Current owner")
    if sid:
        default = db.read("MATCH (:Subcategory {name: $s})-[:ROUTED_TO]->(g:SupportGroup) RETURN g.name AS name",
                          {"s": sub})
        if default:
            g.link(sid, g.node(f"group:{default[0]['name']}", "routing", "Support group", default[0]["name"], 3),
                   "default route", dashed=True)
    handler = assigned
    if t.get("assigned_to"):
        handler = g.node(f"agent:{t['assigned_to']}", "routing", "Agent", t["assigned_to"], 3)
        g.link(assigned, handler, "assigned to")

    # Outcome
    if t["state"] in OPEN_STATES:
        g.link(handler, g.node("outcome:open", "outcome", "Status", t["state"], 4, detail="Not resolved yet"),
               "working")
    else:
        rid = g.node("outcome:resolution", "outcome", "Resolution", t.get("resolution_code") or t["state"], 4,
                     detail=t.get("resolution_notes"))
        g.link(handler, rid, "resolved")
        if t.get("kb_article"):
            k = t["kb_article"]
            g.link(g.node(f"kb:{k['kb_id']}", "outcome", "KB article", k["title"], 4, detail=k["kb_id"],
                          href=f"/kb/{k['kb_id']}"), rid, "used")
    for s in similar_to_ticket(t, limit=3):
        g.link(tid, g.node(f"ticket:{s['number']}", "outcome", "Similar ticket", s["number"], 4,
                           detail=f"{s['short_description']} → {s['resolution']}", href=f"/graph?ticket={s['number']}"),
               "similar to", dashed=True)

    return g.result({"kind": "ticket", "id": t["number"], "title": t["short_description"], "state": t["state"],
                     "priority": t["priority"], "assignment_group": t["assignment_group"],
                     "reassignments": t.get("reassignment_count") or 0,
                     "events": sum(1 for n in g.nodes.values() if n["type"] == "event")})


def event_graph(event_id: str, max_tickets: int = 12) -> dict | None:
    e = events.get_event(event_id)
    if not e:
        return None
    g = _Graph()
    eid = _event_node(g, e, 1)
    if e["all_locations"]:
        g.link(g.node("location:*", "context", "Location", events.ALL_LOCATIONS, 0), eid, "at")
    for loc in e["locations"]:
        g.link(g.node(f"location:{loc}", "context", "Location", loc, 0), eid, "at")
    for sub in e["subcategories"]:
        g.link(eid, g.node(f"sub:{sub}", "classification", "Subcategory", sub, 0), "impacts", dashed=True)

    states: dict[str, int] = {}
    for t in e["tickets"][:max_tickets]:
        tid = g.node(f"ticket:{t['number']}", "ticket", f"{t['subcategory']} · {t['state']}", t["number"], 2,
                     detail=f"{t['short_description']} · {t['state']} · {t['reason']}", href=f"/graph?ticket={t['number']}")
        g.link(eid, tid, "affected", dashed=True, detail=t["reason"])
        gid = g.node(f"group:{t['assignment_group']}", "routing", "Support group", t["assignment_group"], 3)
        g.link(tid, gid, "routed to")
        outcome = "Open" if t["state"] in OPEN_STATES else "Resolved"
        states[outcome] = states.get(outcome, 0) + 1
        g.link(gid, g.node(f"outcome:{outcome}", "outcome", "Status", outcome, 4), outcome.lower())
    for outcome, n in states.items():
        g.nodes[f"outcome:{outcome}"]["detail"] = f"{n} of the tickets shown"
    hidden = e["linked_tickets"] - min(max_tickets, len(e["tickets"]))
    if hidden > 0:
        g.link(eid, g.node("ticket:more", "ticket", "More incidents", f"+{hidden} more", 2,
                           detail="See the full list on the event", href=f"/events?focus={e['event_id']}"),
               "affected", dashed=True)

    return g.result({"kind": "event", "id": e["event_id"], "title": e["title"], "type": e["type"],
                     "start_at": e["start_at"], "end_at": e["end_at"], "status": e["status"],
                     "linked_tickets": e["linked_tickets"], "shown_tickets": min(max_tickets, len(e["tickets"]))},
                    EVENT_LAYERS)
