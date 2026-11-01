"""Per-request context: which workspace (FalkorDB graph) the request works on.

Each workspace is its own graph, so tickets, knowledge base, events and uploads never mix.
The API sets the graph from the `techmate_ws` cookie for every request (see api.py);
scripts and anything outside a request use GRAPH_NAME, the default workspace.
"""

from __future__ import annotations

from contextvars import ContextVar

from .config import get_settings

_graph: ContextVar[str | None] = ContextVar("graph", default=None)


def current_graph() -> str:
    return _graph.get() or get_settings().graph_name


def set_graph(name: str):
    """Use `name` for the rest of this context; returns a token for `reset_graph`."""
    return _graph.set(name)


def reset_graph(token) -> None:
    _graph.reset(token)
