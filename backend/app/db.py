"""FalkorDB connection and small query helpers.

One connection pool per process (Vercel reuses warm instances, so it is created once
and shared across requests). All Cypher in the app is fixed and parameterised; user or
model text is only ever passed as a parameter, never formatted into a query.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache
from typing import Any

from falkordb import FalkorDB, Graph
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import ResponseError, TimeoutError as RedisTimeoutError

from .config import get_settings
from .context import current_graph

log = logging.getLogger(__name__)

RETRYABLE = (RedisConnectionError, RedisTimeoutError)


@lru_cache(maxsize=1)
def get_db() -> FalkorDB:
    s = get_settings()
    return FalkorDB(host=s.falkordb_host, port=s.falkordb_port, username=s.falkordb_username,
                    password=s.falkordb_password, ssl=s.falkordb_ssl, socket_timeout=20,
                    socket_connect_timeout=10, health_check_interval=30)


def get_graph(name: str | None = None) -> Graph:
    """The graph of the current workspace (or `name`)."""
    return get_db().select_graph(name or current_graph())


def _with_retry(fn, *args, **kwargs):
    """Retry briefly on dropped connections (cloud instances close idle sockets)."""
    for attempt in range(3):
        try:
            return fn(*args, **kwargs)
        except RETRYABLE as e:
            if attempt == 2:
                raise
            log.warning("FalkorDB connection error (%s); retrying", e)
            time.sleep(0.3 * (attempt + 1))


def _rows(result) -> list[dict[str, Any]]:
    columns = [h[1] if isinstance(h, (list, tuple)) else h for h in result.header]
    return [dict(zip(columns, row)) for row in result.result_set]


def read(query: str, params: dict | None = None, timeout_ms: int | None = None,
         graph: str | None = None) -> list[dict[str, Any]]:
    """Run a read-only query; rows come back as dicts keyed by column name."""
    return _rows(_with_retry(get_graph(graph).ro_query, query, params or {}, timeout=timeout_ms))


def write(query: str, params: dict | None = None, timeout_ms: int | None = None,
          graph: str | None = None) -> list[dict[str, Any]]:
    return _rows(_with_retry(get_graph(graph).query, query, params or {}, timeout=timeout_ms))


def ensure_index(ddl: str, graph: str | None = None) -> None:
    """Create an index, ignoring 'already exists' errors so setup can be re-run."""
    try:
        get_graph(graph).query(ddl)
    except ResponseError as e:
        if "already indexed" not in str(e) and "already exists" not in str(e):
            raise


def increment_counter(name: str, *, seed: int = 0) -> int:
    """Atomically increment a named counter stored in the graph and return the new value.

    FalkorDB Cloud users can only run graph commands (no SET/INCR), and writes to one graph
    are applied one at a time, so a single MERGE+SET query is an atomic counter.
    """
    rows = write("MERGE (c:Counter {name: $name}) ON CREATE SET c.value = $seed "
                 "SET c.value = c.value + 1 RETURN c.value AS v", {"name": name, "seed": seed})
    return rows[0]["v"]


def graph_exists(name: str | None = None) -> bool:
    return (name or current_graph()) in get_db().list_graphs()


def memory_usage_mb() -> dict[str, float]:
    info = get_db().connection.info("memory")
    return {"used_mb": round(info.get("used_memory", 0) / 1e6, 1),
            "max_mb": round((info.get("maxmemory") or 0) / 1e6, 1)}
