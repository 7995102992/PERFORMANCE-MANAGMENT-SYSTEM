"""Graph projector — consumes ``domain_events`` and projects the org structure
into Neo4j.

Mirrors the journey consumer's resilient lifecycle (own durable queue, robust
auto-reconnect, best-effort boot) but writes graph nodes/edges instead of Mongo
rows. It declares its **own** queue (``iam.graph``) so it gets an independent
copy of every event without competing with the journey consumer.

Delivery is at-least-once; every write in ``src.graph.writer`` is an idempotent
MERGE, so a redelivery is a harmless no-op — no separate dedupe store needed.
"""
from __future__ import annotations

import asyncio
import json

import aio_pika

from src.logger import logger
from src.rabbitmq import connection
from src.graph import writer

EXCHANGE_NAME = "domain_events"
QUEUE_NAME = "iam.graph"
_RETRY_INTERVAL_SECONDS = 5

_channel: aio_pika.abc.AbstractChannel | None = None
_consumer_task: asyncio.Task | None = None

# event_type (== routing key) → writer coroutine (takes the event payload)
_UPSERTS = {
    "organisation.created": writer.upsert_organisation,
    "organisation.updated": writer.upsert_organisation,
    "business_unit.created": writer.upsert_business_unit,
    "business_unit.updated": writer.upsert_business_unit,
    "department.created": writer.upsert_department,
    "department.updated": writer.upsert_department,
    "designation.created": writer.upsert_designation,
    "designation.updated": writer.upsert_designation,
    "band.created": writer.upsert_band,
    "band.updated": writer.upsert_band,
    "pay_grade.created": writer.upsert_paygrade,
    "pay_grade.updated": writer.upsert_paygrade,
    "policy.created": writer.upsert_policy,
    "policy.updated": writer.upsert_policy,
    "document_folder.created": writer.upsert_document_folder,
    "document_folder.updated": writer.upsert_document_folder,
    "org_document.created": writer.upsert_org_document,
    "org_document.updated": writer.upsert_org_document,
    "user.created": writer.upsert_user,
    "user.updated": writer.upsert_user,
    "employee.created": writer.upsert_employee,
    "employee.updated": writer.upsert_employee,
}

# *.deleted → (node label, payload id key)
_DELETES = {
    "organisation.deleted": ("Organisation", "organisation_id"),
    "business_unit.deleted": ("BusinessUnit", "business_unit_id"),
    "department.deleted": ("Department", "department_id"),
    "designation.deleted": ("Designation", "designation_id"),
    "band.deleted": ("Band", "band_id"),
    "pay_grade.deleted": ("PayGrade", "pay_grade_id"),
    "policy.deleted": ("Policy", "policy_id"),
    "document_folder.deleted": ("DocumentFolder", "folder_id"),
    "org_document.deleted": ("OrgDocument", "document_id"),
    "employee.deleted": ("Employee", "employee_id"),
}

ROUTING_KEYS = list(_UPSERTS) + list(_DELETES)


async def _project(event_type: str, payload: dict) -> None:
    if upsert := _UPSERTS.get(event_type):
        await upsert(payload)
    elif event_type in _DELETES:
        label, id_key = _DELETES[event_type]
        await writer.delete_node(label, payload.get(id_key))


async def _process_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    # requeue=False: projection is idempotent and Mongo stays the source of
    # truth, so we drop on error rather than risk a poison-requeue loop.
    async with message.process(requeue=False):
        try:
            payload = json.loads(message.body)
        except (ValueError, TypeError):
            logger.warning("graph: undecodable message", routing_key=message.routing_key)
            return

        event_type = message.routing_key or payload.get("event_type", "")
        try:
            await _project(event_type, payload)
        except Exception as exc:
            logger.error("graph: projection failed", event_type=event_type, error=repr(exc))


# ─── Lifecycle (mirrors src.modules.journey.consumer) ───────────────────────────

async def start_graph_projector() -> bool:
    global _channel
    if not await connection.ensure_ready():
        logger.warning("graph: RabbitMQ not ready, projector not started")
        return False
    try:
        _channel = await connection.rabbitmq_connection.channel()
        await _channel.set_qos(prefetch_count=20)
        exchange = await _channel.declare_exchange(
            EXCHANGE_NAME, aio_pika.ExchangeType.TOPIC, durable=True,
        )
        queue = await _channel.declare_queue(QUEUE_NAME, durable=True)
        for rk in ROUTING_KEYS:
            await queue.bind(exchange, routing_key=rk)
        await queue.consume(_process_message)
        logger.info("Graph projector started", queue=QUEUE_NAME)
        return True
    except Exception as exc:
        logger.error("graph: projector start failed", error=repr(exc))
        return False


async def run_graph_projector() -> None:
    """Keep retrying registration until it succeeds, so a broker down at boot
    self-heals with no restart. aio-pika's robust connection re-establishes the
    subscription across flaps once registered."""
    while True:
        if await start_graph_projector():
            return
        await asyncio.sleep(_RETRY_INTERVAL_SECONDS)


def start_graph_projector_task() -> None:
    global _consumer_task
    _consumer_task = asyncio.create_task(run_graph_projector())
    logger.info("Graph projector task started")


async def stop_graph_projector() -> None:
    global _channel, _consumer_task
    if _consumer_task is not None and not _consumer_task.done():
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    _consumer_task = None
    if _channel is not None and not _channel.is_closed:
        await _channel.close()
    _channel = None
