"""Ingest the PDF knowledge base into FalkorDB as a GraphRAG knowledge graph.

For each article: extract text -> chunk -> embed -> extract entities and relations with
MODEL_FAST -> write KBArticle/KBChunk/Entity nodes and their links. Tickets are then
linked to the entities their text mentions and to the article that resolved them.
Uses the same pipeline as document uploads (backend/app/ingest/knowledge.py).

Entity extraction results are cached in data/graph_cache/, so re-runs are cheap
(--reextract asks the model again). Safe to re-run: KB nodes are rebuilt each time
(documents uploaded through the app are kept).

    python scripts/load_kb.py
    python scripts/load_kb.py --limit 5        # quick test on the first 5 articles
    python scripts/load_kb.py --link-only      # after reloading tickets
"""

import argparse
import csv
import time
from collections import Counter
from pathlib import Path

from pypdf import PdfReader

import _bootstrap  # noqa: F401
from app import db, llm
from app.config import get_settings
from app.graph_schema import ensure_indexes
from app.ingest import knowledge

ROOT = Path(__file__).resolve().parent.parent
KB_DIR = ROOT / "backend" / "static" / "kb"     # the KB PDFs (also served by the API)
MANIFEST = ROOT / "data" / "kb" / "manifest.csv"
CACHE_DIR = ROOT / "data" / "graph_cache" / "entities"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--reextract", action="store_true", help="re-run entity extraction even if cached")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--link-only", action="store_true",
                   help="only re-link tickets to existing KB articles/entities (after reloading tickets)")
    a = p.parse_args()
    if a.link_only:
        t = time.perf_counter()
        n = knowledge.link_ticket_entities()
        print(f"linked tickets: {n} MENTIONS in {time.perf_counter() - t:.0f}s")
        print(f"Memory: {db.memory_usage_mb()}")
        return
    started = time.perf_counter()
    settings = get_settings()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    with open(MANIFEST, encoding="utf-8", newline="") as f:
        manifest = list(csv.DictReader(f))[: a.limit or None]

    # 1. Extract and chunk.
    articles, chunks = [], []
    for m in manifest:
        pages = knowledge.pdf_pages(KB_DIR / m["file_name"])
        if not pages:
            print(f"  WARNING: {m['file_name']} has no extractable text; skipped")
            continue
        articles.append({**m, "pages": len(PdfReader(KB_DIR / m["file_name"]).pages), "source": "catalog"})
        chunks += knowledge.chunk_article(m["kb_id"], m["title"], pages)
    print(f"1. {len(articles)} articles -> {len(chunks)} chunks")

    # 2. Embed.
    t = time.perf_counter()
    for c, vec in zip(chunks, llm.embed([c["embed_text"] for c in chunks])):
        c["embedding"] = vec
    print(f"2. embedded {len(chunks)} chunks ({settings.embed_dimensions} dims) in {time.perf_counter() - t:.0f}s")

    # 3. Extract entities and relations (cached).
    t = time.perf_counter()
    extractions, failed = knowledge.extract_all(chunks, a.workers, CACHE_DIR, a.reextract)
    print(f"3. entity extraction for {len(extractions)} chunks in {time.perf_counter() - t:.0f}s"
          + (f" ({len(failed)} failed, re-run to retry)" if failed else ""))
    entities, mentions, relations = knowledge.merge_extractions(extractions)

    # 4. Write the graph (rebuild the catalog KB; keep uploaded documents).
    t = time.perf_counter()
    ensure_indexes()
    while db.write("MATCH (k:KBArticle) WHERE coalesce(k.source, 'catalog') = 'catalog' "
                   "OPTIONAL MATCH (k)-[:HAS_CHUNK]->(c:KBChunk) WITH k, c LIMIT 2000 "
                   "DETACH DELETE c, k RETURN count(*) AS n")[0]["n"]:
        pass
    db.write("MATCH (e:Entity) WHERE NOT (e)<-[:MENTIONS]-(:KBChunk) DETACH DELETE e")
    knowledge.write_knowledge(articles, chunks, entities, mentions, relations)
    print(f"4. wrote {len(articles)} articles, {len(chunks)} chunks, {len(entities)} entities, "
          f"{len(mentions)} mentions, {len(relations)} relations in {time.perf_counter() - t:.0f}s")

    t = time.perf_counter()
    n = knowledge.link_ticket_entities()
    print(f"5. linked tickets: {n} MENTIONS in {time.perf_counter() - t:.0f}s")

    by_type = Counter(e["type"] for e in entities)
    print(f"Done in {time.perf_counter() - started:.0f}s. Entities by type: {dict(by_type)}")
    print(f"Memory: {db.memory_usage_mb()}")


if __name__ == "__main__":
    main()
