"""Hybrid GraphRAG retrieval over the knowledge base and ticket history.

Three retrievers run on every question and are fused with reciprocal-rank fusion (RRF):

  1. vector    - KB chunks closest to the question embedding (semantic match)
  2. keyword   - full-text search on KB chunks (exact error codes, product names)
  3. graph     - entities named in the question (and their causes/fixes one hop away)
                 -> the chunks that mention them (GraphRAG local search)

Besides ranked chunks, it returns graph context the assistant can reason with: known
symptom -> cause -> fix paths for the matched entities, and similar resolved tickets.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

from . import db, llm

log = logging.getLogger(__name__)

RRF_K = 60  # standard RRF constant: dampens the weight of top ranks
# Retriever weights, tuned with scripts/eval_retrieval.py on 150 real ticket descriptions
# (2026-10-28): vector alone hit@5 97.3 %, equal weights 94.7 %, these weights 96.7 %.
# Vector search leads; keyword and graph act as boosters for exact error codes and
# product names, and the graph also supplies structured context (entities, fix paths).
RETRIEVER_WEIGHTS = {"vector": 1.0, "keyword": 0.15, "graph": 0.15}
STOPWORDS = {
    "the", "and", "for", "from", "with", "not", "cannot", "can", "can't", "does", "doesn't", "don't", "this",
    "that", "have", "has", "was", "are", "when", "after", "please", "issue", "problem", "unable", "able", "still",
    "help", "need", "want", "how", "what", "why", "my", "our", "your", "it's", "keeps", "since", "today",
    "morning", "again", "working", "work", "get", "getting", "any", "some", "there", "they", "them", "just",
}


@dataclass
class Retrieved:
    chunks: list[dict] = field(default_factory=list)          # fused, best first
    entities: list[dict] = field(default_factory=list)        # entities matched in the question
    fix_paths: list[dict] = field(default_factory=list)       # symptom/error -> cause -> fix
    similar_tickets: list[dict] = field(default_factory=list)
    timings_ms: dict = field(default_factory=dict)


def search_terms(text: str, limit: int = 12) -> list[str]:
    """Plain words safe for the full-text engine (it treats - | @ etc. as operators)."""
    words = [w.lower() for w in re.findall(r"[A-Za-z0-9]+", text)]
    seen, out = set(), []
    for w in words:
        if len(w) > 2 and w not in STOPWORDS and w not in seen:
            seen.add(w)
            out.append(w)
    return out[:limit]


def _fulltext_chunk_scores(terms: list[str]) -> dict[str, float]:
    """Per-term scores summed (one OR query over many words ranks poorly)."""
    scores: dict[str, float] = {}
    for term in terms:
        for r in db.read("CALL db.idx.fulltext.queryNodes('KBChunk', $q) YIELD node, score "
                         "RETURN node.chunk_id AS id, score LIMIT 30", {"q": term}):
            scores[r["id"]] = scores.get(r["id"], 0.0) + r["score"]
    return scores


def _vector_chunk_ranking(query_vector: list[float], k: int = 25) -> list[str]:
    rows = db.read("CALL db.idx.vector.queryNodes('KBChunk', 'embedding', $k, vecf32($v)) YIELD node, score "
                   "RETURN node.chunk_id AS id, score ORDER BY score ASC", {"k": k, "v": query_vector})
    return [r["id"] for r in rows]  # score is cosine distance: smaller = closer


def match_entities(terms: list[str], question: str, limit: int = 12) -> list[dict]:
    """Entities whose names appear in the question (full-text on Entity.name, then verified)."""
    candidates: dict[str, dict] = {}
    for term in terms:
        for r in db.read("CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score "
                         "RETURN node.key AS key, node.name AS name, node.type AS type, score LIMIT 25", {"q": term}):
            c = candidates.setdefault(r["key"], {**r, "score": 0.0, "hits": 0})
            c["score"] += r["score"]
            c["hits"] += 1
    q = question.lower()
    words = set(terms)
    matched = []
    for c in candidates.values():
        name_words = set(search_terms(c["name"], 20))
        if not name_words:
            continue
        overlap = len(name_words & words) / len(name_words)
        # Exact phrase in the question, or most of the entity's words present.
        if c["name"].lower() in q or overlap >= 0.6:
            matched.append({**c, "overlap": round(overlap, 2)})
    matched.sort(key=lambda c: (-c["overlap"], -c["hits"], -c["score"]))
    return matched[:limit]


def _graph_chunk_ranking(entity_keys: list[str], k: int = 25) -> list[str]:
    """Chunks mentioning the matched entities or their direct causes/fixes, most links first."""
    if not entity_keys:
        return []
    rows = db.read(
        """
        MATCH (e:Entity) WHERE e.key IN $keys
        OPTIONAL MATCH (e)-[:CAUSED_BY|FIXED_BY|INDICATES]-(n:Entity)
        WITH collect(DISTINCT e) + collect(DISTINCT n) AS ents
        UNWIND ents AS x
        MATCH (c:KBChunk)-[:MENTIONS]->(x)
        RETURN c.chunk_id AS id, count(DISTINCT x) AS links
        ORDER BY links DESC LIMIT $k
        """, {"keys": entity_keys, "k": k})
    return [r["id"] for r in rows]


def fix_paths(entity_keys: list[str], limit: int = 8) -> list[dict]:
    """Known symptom/error -> cause -> fix chains for the matched entities."""
    if not entity_keys:
        return []
    return db.read(
        """
        MATCH (s:Entity) WHERE s.key IN $keys AND s.type IN ['Symptom', 'ErrorCode', 'Cause']
        OPTIONAL MATCH (s)-[:CAUSED_BY|INDICATES]->(c:Entity {type: 'Cause'})
        WITH s, coalesce(c, CASE WHEN s.type = 'Cause' THEN s END) AS cause
        WHERE cause IS NOT NULL
        MATCH (cause)-[f:FIXED_BY]->(fix:Entity)
        RETURN s.name AS symptom, cause.name AS cause, fix.name AS fix, f.weight AS weight
        ORDER BY weight DESC LIMIT $limit
        """, {"keys": entity_keys, "limit": limit})


def similar_tickets(terms: list[str], entity_keys: list[str], preferred_subcategories: list[str] | None = None,
                    limit: int = 5) -> list[dict]:
    """Resolved tickets most like the question, with how they were fixed.

    Score = shared entities (graph) + full-text match (words) + a boost when the ticket is
    in the same subcategory as the top KB results, so one shared generic entity
    (e.g. "Outlook") can't pull in an unrelated ticket on its own.
    """
    scores: dict[str, float] = {}
    if entity_keys:
        for r in db.read(
                """MATCH (t:Ticket)-[:MENTIONS]->(e:Entity) WHERE e.key IN $keys AND t.resolution_code STARTS WITH 'Solved'
                   RETURN t.number AS n, count(e) AS shared ORDER BY shared DESC LIMIT 60""", {"keys": entity_keys}):
            scores[r["n"]] = scores.get(r["n"], 0.0) + 1.0 * r["shared"]
    text: dict[str, float] = {}
    for term in terms[:8]:
        for r in db.read("CALL db.idx.fulltext.queryNodes('Ticket', $q) YIELD node, score "
                         "WHERE node.resolution_code STARTS WITH 'Solved' RETURN node.number AS n, score LIMIT 60", {"q": term}):
            text[r["n"]] = text.get(r["n"], 0.0) + r["score"]
    top_text = max(text.values(), default=1.0) or 1.0
    for n, v in text.items():
        scores[n] = scores.get(n, 0.0) + 2.0 * v / top_text   # normalise to 0..2
    if not scores:
        return []
    candidates = sorted(scores, key=lambda n: -scores[n])[:60]
    rows = db.read(
        """
        MATCH (t:Ticket)-[:IN_SUBCATEGORY]->(sc) WHERE t.number IN $nums
        RETURN t.number AS number, t.short_description AS short_description, t.resolution_notes AS resolution,
               sc.name AS subcategory, t.kb_article AS kb_article, t.opened_ts AS opened_ts
        """, {"nums": candidates})
    preferred = set(preferred_subcategories or [])
    for r in rows:
        r["score"] = round(scores[r["number"]] + (1.5 if r["subcategory"] in preferred else 0.0), 3)
    rows.sort(key=lambda r: (-r["score"], -(r["opened_ts"] or 0)))
    # One example per distinct resolution keeps the list informative.
    out, seen = [], set()
    for r in rows:
        if r["resolution"] in seen:
            continue
        seen.add(r["resolution"])
        r.pop("opened_ts")
        out.append(r)
        if len(out) == limit:
            break
    return out


def similar_to_ticket(ticket: dict, limit: int = 5) -> list[dict]:
    """Resolved tickets most like an existing ticket: its graph entities, its words, its subcategory."""
    keys = [r["key"] for r in db.read("MATCH (:Ticket {number: $n})-[:MENTIONS]->(e:Entity) RETURN e.key AS key",
                                      {"n": ticket["number"]})]
    text = f"{ticket['short_description']}. {(ticket.get('description') or '').split(' Device:')[0]}"
    rows = similar_tickets(search_terms(text), keys, [ticket["subcategory"]] if ticket.get("subcategory") else None,
                           limit=limit + 1)
    return [r for r in rows if r["number"] != ticket["number"]][:limit]


def rrf(rankings: dict[str, list[str]], weights: dict[str, float] | None = None) -> list[tuple[str, float, dict]]:
    """Reciprocal-rank fusion: score = sum(weight / (RRF_K + rank)) over each retriever."""
    fused: dict[str, float] = {}
    ranks: dict[str, dict] = {}
    for name, ids in rankings.items():
        w = (weights or {}).get(name, 1.0)
        for rank, cid in enumerate(ids, 1):
            fused[cid] = fused.get(cid, 0.0) + w / (RRF_K + rank)
            ranks.setdefault(cid, {})[name] = rank
    return [(cid, score, ranks[cid]) for cid, score in sorted(fused.items(), key=lambda kv: -kv[1])]


def hybrid_search(question: str, *, k: int = 6, with_tickets: bool = True) -> Retrieved:
    out = Retrieved()
    t0 = time.perf_counter()
    terms = search_terms(question)

    t = time.perf_counter()
    vector_ids = _vector_chunk_ranking(llm.embed([question])[0])
    out.timings_ms["vector"] = round((time.perf_counter() - t) * 1000)

    t = time.perf_counter()
    kw = _fulltext_chunk_scores(terms)
    keyword_ids = [cid for cid, _ in sorted(kw.items(), key=lambda kv: -kv[1])[:25]]
    out.timings_ms["keyword"] = round((time.perf_counter() - t) * 1000)

    t = time.perf_counter()
    out.entities = match_entities(terms, question)
    keys = [e["key"] for e in out.entities]
    graph_ids = _graph_chunk_ranking(keys)
    out.timings_ms["graph"] = round((time.perf_counter() - t) * 1000)

    fused = rrf({"vector": vector_ids, "keyword": keyword_ids, "graph": graph_ids}, RETRIEVER_WEIGHTS)[: k * 3]
    if fused:
        rows = db.read(
            """
            MATCH (a:KBArticle)-[:HAS_CHUNK]->(c:KBChunk) WHERE c.chunk_id IN $ids
            RETURN c.chunk_id AS chunk_id, c.text AS text, c.page AS page, a.kb_id AS kb_id, a.title AS title,
                   a.subcategory AS subcategory, a.file_name AS file_name, a.file_url AS file_url
            """, {"ids": [cid for cid, _, _ in fused]})
        by_id = {r["chunk_id"]: r for r in rows}
        per_article: dict[str, int] = {}
        for cid, score, ranks in fused:
            r = by_id.get(cid)
            if not r or per_article.get(r["kb_id"], 0) >= 2:  # at most 2 chunks per article, for variety
                continue
            per_article[r["kb_id"]] = per_article.get(r["kb_id"], 0) + 1
            out.chunks.append({**r, "score": round(score, 4), "ranks": ranks})
            if len(out.chunks) == k:
                break

    out.fix_paths = fix_paths(keys)
    if with_tickets:
        top_subcategories = list(dict.fromkeys(c["subcategory"] for c in out.chunks[:3]))
        out.similar_tickets = similar_tickets(terms, keys, top_subcategories)
    out.timings_ms["total"] = round((time.perf_counter() - t0) * 1000)
    return out
