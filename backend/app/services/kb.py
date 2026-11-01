"""Knowledge-base browsing: list/search articles and read one article."""

from __future__ import annotations

from .. import db
from ..retrieval import search_terms


def list_articles(q: str | None = None, category: str | None = None) -> list[dict]:
    """All articles (alphabetical by category), or search results ranked by relevance."""
    params: dict = {}
    where = []
    if category:
        where.append("k.category = $category")
        params["category"] = category
    scores: dict[str, float] = {}
    if q:
        terms = search_terms(q, 8)
        for term in terms:
            # Best-matching chunk per article for this word, summed across words.
            for r in db.read(
                    "CALL db.idx.fulltext.queryNodes('KBChunk', $q) YIELD node, score "
                    "MATCH (k:KBArticle)-[:HAS_CHUNK]->(node) RETURN k.kb_id AS id, max(score) AS score", {"q": term}):
                scores[r["id"]] = scores.get(r["id"], 0.0) + r["score"]
        # Words in the title count extra: a title match is the strongest signal.
        for r in db.read("MATCH (k:KBArticle) RETURN k.kb_id AS id, toLower(k.title) AS title"):
            hits = sum(1 for t in terms if t in r["title"])
            if hits:
                scores[r["id"]] = scores.get(r["id"], 0.0) + 2.0 * hits
        where.append("k.kb_id IN $ids")
        params["ids"] = list(scores)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = db.read(
        f"""
        MATCH (k:KBArticle) {clause}
        OPTIONAL MATCH (k)-[:OWNED_BY]->(g:SupportGroup)
        OPTIONAL MATCH (t:Ticket)-[:RESOLVED_WITH]->(k)
        RETURN k.kb_id AS kb_id, k.title AS title, k.category AS category, k.subcategory AS subcategory,
               k.pages AS pages, k.file_name AS file_name, k.file_url AS file_url, k.source AS source,
               k.summary AS summary, g.name AS owner, count(t) AS tickets_resolved
        ORDER BY category, title
        """, params)
    if q:
        rows.sort(key=lambda r: -scores.get(r["kb_id"], 0.0))
        rows = rows[:25]
    return rows


def get_article(kb_id: str) -> dict | None:
    rows = db.read(
        """
        MATCH (k:KBArticle {kb_id: $id})
        OPTIONAL MATCH (k)-[:OWNED_BY]->(g:SupportGroup)
        RETURN k.kb_id AS kb_id, k.title AS title, k.category AS category, k.subcategory AS subcategory,
               k.pages AS pages, k.file_name AS file_name, k.file_url AS file_url, k.source AS source,
               k.summary AS summary, g.name AS owner
        """, {"id": kb_id})
    if not rows:
        return None
    article = rows[0]
    article["chunks"] = db.read("MATCH (:KBArticle {kb_id: $id})-[:HAS_CHUNK]->(c:KBChunk) "
                                "RETURN c.idx AS idx, c.page AS page, c.text AS text ORDER BY c.idx", {"id": kb_id})
    article["entities"] = db.read(
        """
        MATCH (:KBArticle {kb_id: $id})-[:HAS_CHUNK]->(:KBChunk)-[:MENTIONS]->(e:Entity)
        RETURN e.name AS name, e.type AS type, count(*) AS mentions ORDER BY mentions DESC LIMIT 40
        """, {"id": kb_id})
    article["tickets_resolved"] = db.read(
        "MATCH (t:Ticket)-[:RESOLVED_WITH]->(:KBArticle {kb_id: $id}) RETURN count(t) AS n", {"id": kb_id})[0]["n"]
    return article
