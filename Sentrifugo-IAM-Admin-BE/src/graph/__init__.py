"""Neo4j graph layer — the derived org/reporting structure projection.

All graph access goes through this package. The driver is resilient and
self-healing (see ``connection``); callers use ``run_read`` / ``run_write`` or
grab the driver via ``get_graph`` for advanced session control.

Mongo is the system of record; the graph is a queryable projection built live
from domain events (``schema`` declares the constraints, ``writer`` holds the
idempotent per-entity upserts, and ``projector`` consumes ``domain_events`` and
drives those upserts).
"""

from src.graph.connection import (
    close_graph,
    get_graph,
    init_graph,
    is_healthy,
    run_read,
    run_write,
)
from src.graph.schema import init_graph_schema

__all__ = [
    "close_graph",
    "get_graph",
    "init_graph",
    "init_graph_schema",
    "is_healthy",
    "run_read",
    "run_write",
]
