"""Seed calendar and historical events and link them to tickets.

Creates (:Event) nodes for public holidays, Patch Tuesdays and the known past outages in
the ticket history, then links every event (including notices uploaded through the app)
to the incidents it affected. Also fills in `Ticket.location` for tickets loaded before
tickets carried their own location. Safe to re-run: seeded events are rebuilt; uploaded
notices are kept and re-linked. Works on the default workspace (GRAPH_NAME).

    python scripts/load_events.py
"""

import time
from datetime import date, timedelta

import _bootstrap  # noqa: F401
from app import db, timeutil
from app.graph_schema import ensure_indexes
from app.services import events

# Outages in the demo ticket history (data/tickets/l1_tickets.csv).
OUTAGES = [
    {"title": "VPN gateway certificate outage", "type": "Service outage", "start": "2026-02-17 08:00",
     "end": "2026-02-17 20:00", "subcategories": ["VPN"], "services": ["VPN gateway", "GlobalProtect"],
     "user_impact": "Remote users could not connect to the VPN.",
     "advice": "Reconnect once the gateway certificate was renewed; no action needed on laptops."},
    {"title": "Exchange Online service degradation", "type": "Service outage", "start": "2026-06-09 08:00",
     "end": "2026-06-09 20:00", "subcategories": ["Outlook"], "services": ["Exchange Online", "Outlook"],
     "user_impact": "Outlook was slow to send and receive mail.",
     "advice": "Wait for Microsoft's fix; use Outlook on the web for urgent mail."},
    {"title": "Office wireless controller failure", "type": "Service outage", "start": "2026-08-26 08:00",
     "end": "2026-08-26 20:00", "subcategories": ["Wi-Fi"], "services": ["Wireless controller", "ACME-Corp Wi-Fi"],
     "user_impact": "Laptops could not join the corporate Wi-Fi.",
     "advice": "Use a wired connection until the controller was replaced."},
]


def main() -> None:
    started = time.perf_counter()
    ensure_indexes()

    # Tickets carry their own location (events match on it).
    n = db.write("""MATCH (t:Ticket) WHERE t.location IS NULL AND t.description CONTAINS 'Location: '
                    WITH t, split(split(t.description, 'Location: ')[1], '.')[0] AS loc
                    SET t.location = trim(loc) RETURN count(t) AS n""", timeout_ms=120_000)[0]["n"]
    n += db.write("""MATCH (t:Ticket)-[:RAISED_BY]->(:User)-[:BASED_AT]->(l:Location) WHERE t.location IS NULL
                     WITH t, head(collect(l.name)) AS loc SET t.location = loc RETURN count(t) AS n""",
                  timeout_ms=120_000)[0]["n"]
    print(f"1. set location on {n} tickets")

    span = db.read("MATCH (t:Ticket) RETURN min(t.opened_at) AS lo, max(t.opened_at) AS hi")[0]
    today = timeutil.now().date()
    first = date.fromisoformat(span["lo"][:10]) if span["lo"] else today - timedelta(days=365)
    last = max(date.fromisoformat(span["hi"][:10]) if span["hi"] else today, today) + timedelta(days=90)

    t = time.perf_counter()
    calendar, calendar_links = events.seed_calendar(first, last)
    db.write("MATCH (e:Event {source: 'history'}) DETACH DELETE e")
    outage_links = sum(events.create_event({**o, "all_locations": True}, source="history")["linked_tickets"]
                       for o in OUTAGES)
    print(f"2. created {calendar} calendar and {len(OUTAGES)} outage events with "
          f"{calendar_links + outage_links} ticket links in {time.perf_counter() - t:.0f}s")

    # Re-link uploaded notices (e.g. after reloading tickets).
    notices = db.read("MATCH (e:Event) WHERE NOT e.source IN ['calendar', 'history'] RETURN e.event_id AS id")
    relinked = sum(events.link_event(r["id"]) for r in notices)
    print(f"3. re-linked {len(notices)} uploaded events ({relinked} ticket links)")

    by_type = db.read("MATCH (e:Event) OPTIONAL MATCH (t:Ticket)-[:AFFECTED_BY]->(e) "
                      "RETURN e.type AS type, count(DISTINCT e) AS events, count(t) AS links ORDER BY type")
    print(f"Done in {time.perf_counter() - started:.0f}s: {by_type}")
    print(f"Memory: {db.memory_usage_mb()}")


if __name__ == "__main__":
    main()
