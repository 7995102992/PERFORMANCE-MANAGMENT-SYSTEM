"""Neo4j async driver lifecycle — the graph projection connection.

The driver created by ``AsyncGraphDatabase.driver`` is lazy and self-healing: it
does not open a socket until the first query, maintains an internal connection
pool, and transparently reconnects across broker/database flaps. So the driver
object is usable even if Neo4j is down at boot — the boot-time
``verify_connectivity`` is only a health probe and must NOT crash the app
(mirrors the Valkey/RabbitMQ resilience posture in ``src.main``).

Mongo remains the system of record. This module is purely the read/write path
for the derived graph projection (org chart, reporting chains, traversals).
"""
from __future__ import annotations

from typing import Any

from neo4j import AsyncDriver, AsyncGraphDatabase

from src.config import settings
from src.logger import logger

graph_driver: AsyncDriver | None = None


async def init_graph() -> None:
    """Create the Neo4j driver. Best-effort connectivity probe — a Neo4j that is
    down at boot logs a warning; the driver self-heals on the next query."""
    global graph_driver
    graph_driver = AsyncGraphDatabase.driver(
        settings.NEO4J_URI,
        auth=(settings.NEO4J_USER, settings.NEO4J_PASSWORD),
        # Fail fast when Neo4j is down rather than blocking the caller: bound the
        # managed-transaction auto-retry (default 30s) and the connection wait.
        # A down broker no longer stalls startup or floods logs; the schema task
        # and future events re-sync once it returns.
        max_transaction_retry_time=5,
        connection_acquisition_timeout=5,
    )
    try:
        await graph_driver.verify_connectivity()
        logger.info("Neo4j connection initialized", uri=settings.NEO4J_URI)
    except Exception as exc:
        logger.warning("Neo4j connectivity check failed at init (will self-heal)", error=str(exc))


async def close_graph() -> None:
    global graph_driver
    if graph_driver:
        await graph_driver.close()
        graph_driver = None
        logger.info("Neo4j connection closed")


def get_graph() -> AsyncDriver:
    """Return the Neo4j driver. The pool self-heals, so a live connection is
    never required here."""
    if graph_driver is None:
        raise RuntimeError("Neo4j not initialised — call init_graph() first")
    return graph_driver


async def is_healthy() -> bool:
    """Cheap connectivity probe for the health endpoint."""
    if graph_driver is None:
        return False
    try:
        await graph_driver.verify_connectivity()
        return True
    except Exception:
        return False


async def run_read(cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run a read query in a managed transaction and return rows as dicts."""
    driver = get_graph()
    async with driver.session(database=settings.NEO4J_DATABASE) as session:
        result = await session.execute_read(_collect, cypher, params or {})
    return result


async def run_write(cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run a write query in a managed transaction (auto-retried by the driver)."""
    driver = get_graph()
    async with driver.session(database=settings.NEO4J_DATABASE) as session:
        result = await session.execute_write(_collect, cypher, params or {})
    return result


async def _collect(tx, cypher: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    result = await tx.run(cypher, params)
    return [record.data() async for record in result]
