"""Load the service-desk taxonomy and the full ticket history into FalkorDB.

Safe to re-run: ticket data is cleared and rebuilt; taxonomy nodes are MERGEd so the
knowledge base's links to subcategories and support groups survive a reload. Uses the
same CSV importer as the app's upload page (backend/app/ingest/tickets_csv.py).
Afterwards run `python scripts/load_kb.py --link-only` and `python scripts/load_events.py`.

    python scripts/load_tickets.py
"""

import argparse
import time
from pathlib import Path

import _bootstrap  # noqa: F401  (adds backend/ to the import path)
from app import db
from app.graph_schema import ensure_indexes
from app.ingest import tickets_csv
from app.services import taxonomy
from catalog import SUBCATEGORIES, SUPPORT_GROUPS

ROOT = Path(__file__).resolve().parent.parent

TAXONOMY = """
UNWIND $subs AS s
MERGE (c:Category {name: s.category})
MERGE (sc:Subcategory {name: s.name})
SET sc.key = s.key, sc.ci_type = s.ci_type, sc.typical_minutes = s.median_minutes,
    sc.examples = s.examples
MERGE (g:SupportGroup {name: s.group})
MERGE (sc)-[:IN_CATEGORY]->(c)
MERGE (sc)-[:ROUTED_TO]->(g)
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", default=str(ROOT / "data" / "tickets" / "l1_tickets.csv"))
    a = p.parse_args()
    started = time.perf_counter()

    ensure_indexes()
    subs = [{"key": s.key, "name": s.name, "category": s.category, "group": s.group, "ci_type": s.ci_type,
             "median_minutes": s.median_minutes, "examples": list(s.short_descriptions)} for s in SUBCATEGORIES]
    db.write(TAXONOMY, {"subs": subs})
    db.write("UNWIND $groups AS g MERGE (sg:SupportGroup {name: g.name}) SET sg.description = g.description",
             {"groups": [{"name": k, "description": v} for k, v in SUPPORT_GROUPS.items()]})
    taxonomy.invalidate()

    # Clear previous ticket data (people/devices are only referenced by tickets) and upload history.
    for label in ("Ticket", "User", "Agent", "Department", "Location", "ConfigItem", "Device", "OS", "Import"):
        while db.write(f"MATCH (n:{label}) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS n")[0]["n"]:
            pass

    parsed = tickets_csv.parse(Path(a.csv).read_bytes())
    if parsed.errors:
        print(f"  {len(parsed.errors)} invalid rows skipped, e.g. {parsed.errors[:3]}")
    numbers, new_subs = tickets_csv.write_tickets(
        parsed.rows, source="history", import_id=None,
        progress=lambda done, total: print(f"  tickets {done}/{total}", end="\r"))
    print()
    tickets_csv.bump_ticket_counter(numbers)
    if new_subs:
        print(f"  added {len(new_subs)} subcategories not in the catalog: {[s['name'] for s in new_subs][:10]}")

    counts = {label: db.read(f"MATCH (n:{label}) RETURN count(n) AS n")[0]["n"]
              for label in ("Ticket", "User", "Category", "Subcategory", "SupportGroup", "Agent", "Device", "Location")}
    print(f"Loaded in {time.perf_counter() - started:.1f}s: {counts}")
    print(f"Memory: {db.memory_usage_mb()}")


if __name__ == "__main__":
    main()
