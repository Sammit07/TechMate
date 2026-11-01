"""Measure retrieval quality: does the KB article that resolved a ticket come back?

Takes resolved tickets that reference a KB article, uses the user's wording as the
query, and reports hit@1, hit@5 and MRR (article level) for each retriever alone and
for the fused hybrid. Then prints full hybrid results for a few example questions.

    python scripts/eval_retrieval.py --n 150
"""

import argparse
import random
import time

import _bootstrap  # noqa: F401
from app import db, llm
from app.retrieval import (_fulltext_chunk_scores, _graph_chunk_ranking, _vector_chunk_ranking, hybrid_search,
                           match_entities, rrf, search_terms)

EXAMPLES = [
    "My VPN says the certificate has expired and I can't connect from home",
    "Windows update keeps failing with error 0x800f0922",
    "I got a new phone and Microsoft Authenticator has no accounts",
    "Outlook is stuck on disconnected and no new emails arrive",
]


def article_ranking(chunk_ids: list[str], chunk_article: dict[str, str]) -> list[str]:
    seen, out = set(), []
    for cid in chunk_ids:
        a = chunk_article.get(cid)
        if a and a not in seen:
            seen.add(a)
            out.append(a)
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=150)
    p.add_argument("--seed", type=int, default=3)
    a = p.parse_args()

    chunk_article = {r["c"]: r["a"] for r in db.read(
        "MATCH (a:KBArticle)-[:HAS_CHUNK]->(c:KBChunk) RETURN c.chunk_id AS c, a.kb_id AS a")}
    tickets = db.read("""MATCH (t:Ticket)-[:RESOLVED_WITH]->(k:KBArticle)
                         RETURN t.short_description AS short, t.description AS description, k.kb_id AS kb_id""")
    random.Random(a.seed).shuffle(tickets)
    sample = tickets[: a.n]
    # The user's own words only (drop the "Device: ... Location: ..." suffix).
    queries = [f"{t['short']}. {t['description'].split(' Device:')[0]}" for t in sample]

    started = time.perf_counter()
    vectors = llm.embed(queries)
    sub_of = {r["a"]: r["s"] for r in db.read("MATCH (a:KBArticle) RETURN a.kb_id AS a, a.subcategory AS s")}
    ticket_sub = {r["kb"]: r["s"] for r in db.read("MATCH (a:KBArticle) RETURN a.kb_id AS kb, a.subcategory AS s")}
    runs = []  # per query: rankings by retriever, plus the expected article
    for q, vec, t in zip(queries, vectors, sample):
        terms = search_terms(q)
        kw = _fulltext_chunk_scores(terms)
        runs.append(({"vector": _vector_chunk_ranking(vec),
                      "keyword": [c for c, _ in sorted(kw.items(), key=lambda kv: -kv[1])[:25]],
                      "graph": _graph_chunk_ranking([e["key"] for e in match_entities(terms, q)])}, t["kb_id"]))

    def score(rank_fn) -> dict:
        s = {"hit1": 0, "hit5": 0, "rr": 0.0, "sub1": 0}
        for rankings, expected in runs:
            arts = article_ranking(rank_fn(rankings), chunk_article)
            s["hit1"] += arts[:1] == [expected]
            # "relevant first": top article is about the same subcategory as the right one
            s["sub1"] += bool(arts) and sub_of.get(arts[0]) == ticket_sub.get(expected)
            if expected in arts[:5]:
                s["hit5"] += 1
                s["rr"] += 1 / (arts.index(expected) + 1)
        return s

    n = len(runs)
    print(f"Retrieval on {n} real ticket descriptions ({time.perf_counter() - started:.0f}s)")
    print(f"{'retriever':<34} {'hit@1':>7} {'hit@5':>7} {'MRR@5':>7} {'relevant@1':>11}")
    configs = {name: (lambda r, name=name: r[name]) for name in ("vector", "keyword", "graph")}
    for w in ((1, 1, 1), (1, 0.5, 0.5), (1, 0.3, 0.3), (1, 0.2, 0.4), (1, 0.4, 0.2), (1, 0.15, 0.15)):
        weights = {"vector": w[0], "keyword": w[1], "graph": w[2]}
        configs[f"hybrid v={w[0]} k={w[1]} g={w[2]}"] = (lambda r, weights=weights:
                                                         [c for c, _, _ in rrf(r, weights)])
    for name, fn in configs.items():
        s = score(fn)
        print(f"{name:<34} {s['hit1'] / n:>7.1%} {s['hit5'] / n:>7.1%} {s['rr'] / n:>7.3f} {s['sub1'] / n:>11.1%}")

    for q in EXAMPLES:
        r = hybrid_search(q, k=4)
        print(f"\nQ: {q}   ({r.timings_ms})")
        print("  entities:", [f"{e['type']}:{e['name']}" for e in r.entities[:6]])
        for c in r.chunks:
            print(f"  - {c['kb_id']} {c['title'][:60]} (p.{c['page']}) ranks={c['ranks']}")
        for fp in r.fix_paths[:3]:
            print(f"  fix path: {fp['symptom']} -> {fp['cause']} -> {fp['fix']}")
        for t in r.similar_tickets[:2]:
            print(f"  similar: {t['number']} {t['short_description']} -> {t['resolution'][:70]}")


if __name__ == "__main__":
    main()
