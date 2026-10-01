import json

import aio_pika

from src.database import get_db
from src.logger import logger
from src.messaging.constants.exchanges import Exchanges
from src.messaging.constants.queues import Queues
from src.messaging.constants.routing_keys import RoutingKeys
from src.messaging.middleware.retry import requeue_with_backoff
from src.rabbitmq import get_connection


async def _upsert_business_unit(payload: dict) -> None:
    db = get_db()
    bu_id = payload.get("id") or payload.get("_id")
    if not bu_id:
        logger.warning("Business unit event missing id", payload=payload)
        return

    await db["business_units"].update_one(
        {"_id": bu_id},
        {"$set": {
            "_id": bu_id,
            "name": payload.get("name", ""),
            "org_id": payload.get("org_id", ""),
            "is_deleted": payload.get("is_deleted", False),
        }},
        upsert=True,
    )
    logger.info("Business unit upserted", bu_id=bu_id)


async def _upsert_department(payload: dict) -> None:
    db = get_db()
    dept_id = payload.get("id") or payload.get("_id")
    if not dept_id:
        logger.warning("Department event missing id", payload=payload)
        return

    # `business_unit_id` (singular) = the dept's primary BU. `business_unit_ids`
    # (array) = every BU this dept is linked to. The LMS needs the array because
    # holiday plan / work calendar edits cascade across all linked BUs, not just
    # the primary one. Older publishers may emit only the singular field; default
    # the array to [primary] so the dept isn't treated as having zero BU links.
    primary_bu_id = payload.get("business_unit_id", "")
    bu_ids = payload.get("business_unit_ids")
    if bu_ids is None:
        bu_ids = [primary_bu_id] if primary_bu_id else []

    await db["departments"].update_one(
        {"_id": dept_id},
        {"$set": {
            "_id": dept_id,
            "name": payload.get("name", ""),
            "org_id": payload.get("org_id", ""),
            "business_unit_id": primary_bu_id,
            "business_unit_ids": bu_ids,
            "is_deleted": payload.get("is_deleted", False),
        }},
        upsert=True,
    )
    logger.info("Department upserted", dept_id=dept_id, bu_count=len(bu_ids))


async def _process_business_unit_message(message: aio_pika.IncomingMessage) -> None:
    """Process a business unit event from IAM."""
    try:
        body = json.loads(message.body)
    except json.JSONDecodeError as e:
        logger.error("Invalid JSON in business unit message", error=str(e))
        await message.ack()
        return

    payload = body.get("payload", body)

    try:
        await _upsert_business_unit(payload)
        await message.ack()
    except Exception as e:
        logger.error("Failed to process business unit event", error=str(e))
        async with get_connection().channel() as ch:
            exchange = await ch.get_exchange(Exchanges.IAM, ensure=False)
            await requeue_with_backoff(message, exchange, str(e))


async def _process_department_message(message: aio_pika.IncomingMessage) -> None:
    """Process a department event from IAM."""
    try:
        body = json.loads(message.body)
    except json.JSONDecodeError as e:
        logger.error("Invalid JSON in department message", error=str(e))
        await message.ack()
        return

    payload = body.get("payload", body)

    try:
        await _upsert_department(payload)
        await message.ack()
    except Exception as e:
        logger.error("Failed to process department event", error=str(e))
        async with get_connection().channel() as ch:
            exchange = await ch.get_exchange(Exchanges.IAM, ensure=False)
            await requeue_with_backoff(message, exchange, str(e))


async def start_iam_consumer() -> None:
    """Start consuming business unit and department events from IAM."""
    channel = await get_connection().channel()
    await channel.set_qos(prefetch_count=10)

    bu_queue = await channel.get_queue(Queues.BUSINESS_UNIT_SYNCED, ensure=False)
    await bu_queue.consume(_process_business_unit_message)
    logger.info("IAM business unit consumer started", queue=Queues.BUSINESS_UNIT_SYNCED)

    dept_queue = await channel.get_queue(Queues.DEPARTMENT_SYNCED, ensure=False)
    await dept_queue.consume(_process_department_message)
    logger.info("IAM department consumer started", queue=Queues.DEPARTMENT_SYNCED)
