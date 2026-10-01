"""Graph schema — uniqueness constraints for the projected node labels.

Each node is keyed by the string form of its Mongo ``_id`` (or ``user_id`` for
:User). A unique constraint both guarantees one node per entity and creates the
backing index that makes every ``MERGE (n:Label {id:$id})`` an O(1) upsert.

Idempotent: ``IF NOT EXISTS`` means re-running is a no-op. Call once after
``init_graph()`` (and it is safe to call on every boot).
"""
from __future__ import annotations

import asyncio

from src.graph.connection import is_healthy, run_write
from src.logger import logger

_RETRY_SECONDS = 5
_schema_task: asyncio.Task | None = None

_CONSTRAINTS = [
    "CREATE CONSTRAINT org_id      IF NOT EXISTS FOR (o:Organisation)   REQUIRE o.id IS UNIQUE",
    "CREATE CONSTRAINT bu_id       IF NOT EXISTS FOR (b:BusinessUnit)   REQUIRE b.id IS UNIQUE",
    "CREATE CONSTRAINT dept_id     IF NOT EXISTS FOR (d:Department)     REQUIRE d.id IS UNIQUE",
    "CREATE CONSTRAINT desig_id    IF NOT EXISTS FOR (d:Designation)    REQUIRE d.id IS UNIQUE",
    "CREATE CONSTRAINT band_id     IF NOT EXISTS FOR (b:Band)           REQUIRE b.id IS UNIQUE",
    "CREATE CONSTRAINT paygrade_id IF NOT EXISTS FOR (p:PayGrade)       REQUIRE p.id IS UNIQUE",
    "CREATE CONSTRAINT policy_id   IF NOT EXISTS FOR (p:Policy)         REQUIRE p.id IS UNIQUE",
    "CREATE CONSTRAINT folder_id   IF NOT EXISTS FOR (f:DocumentFolder) REQUIRE f.id IS UNIQUE",
    "CREATE CONSTRAINT orgdoc_id   IF NOT EXISTS FOR (d:OrgDocument)    REQUIRE d.id IS UNIQUE",
    "CREATE CONSTRAINT emp_id      IF NOT EXISTS FOR (e:Employee)       REQUIRE e.id IS UNIQUE",
    "CREATE CONSTRAINT user_id     IF NOT EXISTS FOR (u:User)           REQUIRE u.id IS UNIQUE",
    # Employee.user_id is how managers (stored as user ids) are resolved to the
    # manager's Employee node — index it so that lookup is fast.
    "CREATE INDEX emp_user_id      IF NOT EXISTS FOR (e:Employee)       ON (e.user_id)",
]


async def init_graph_schema() -> None:
    """Declare all constraints/indexes. Best-effort per statement so a transient
    Neo4j hiccup on one doesn't abort the rest (mirrors the resilient boot)."""
    for stmt in _CONSTRAINTS:
        try:
            await run_write(stmt)
        except Exception as exc:
            logger.warning("graph schema statement failed", stmt=stmt, error=str(exc))
    logger.info("Neo4j graph schema ensured")


async def _run_graph_schema_init() -> None:
    """Ensure the schema once Neo4j is actually reachable — without blocking app
    startup. Polls the cheap connectivity probe and only issues the constraint
    writes when the store is up, so a Neo4j that is down at boot never stalls
    startup or floods logs with transaction-retry noise. Constraints are
    ``IF NOT EXISTS``, so this is safe whenever it finally runs."""
    while True:
        try:
            if await is_healthy():
                await init_graph_schema()
                return
        except Exception as exc:  # noqa: BLE001 — never let this loop die
            logger.warning("graph schema init probe failed", error=str(exc))
        await asyncio.sleep(_RETRY_SECONDS)


def start_graph_schema_task() -> None:
    """Launch schema-ensure as a non-blocking background task."""
    global _schema_task
    _schema_task = asyncio.create_task(_run_graph_schema_init())
    logger.info("Graph schema init task started")


async def stop_graph_schema_task() -> None:
    global _schema_task
    if _schema_task is not None and not _schema_task.done():
        _schema_task.cancel()
        try:
            await _schema_task
        except asyncio.CancelledError:
            pass
    _schema_task = None
