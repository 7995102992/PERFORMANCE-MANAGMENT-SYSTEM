from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import aio_pika
import src.database as _database
import src.rabbitmq as _rabbitmq
from src.logger import logger
from src.messaging.constants.exchanges import Exchanges

POLL_INTERVAL_SECONDS = 5
MAX_RETRIES = 10
RELAY_BATCH_SIZE = 50

_relay_task: asyncio.Task | None = None


async def start_relay() -> None:
    global _relay_task
    _relay_task = asyncio.create_task(_relay_loop())
    logger.info("Outbox relay started")


async def stop_relay() -> None:
    if _relay_task and not _relay_task.done():
        _relay_task.cancel()
        try:
            await _relay_task
        except asyncio.CancelledError:
            pass
    logger.info("Outbox relay stopped")


async def publish(
    event_type: str,
    payload: dict,
    *,
    idempotency_key: str,
    exchange: str = Exchanges.EMAIL_EVENTS,
) -> None:
    if not _database.mongo_client:
        logger.warning("MongoDB not initialized, skipping email event", event_type=event_type)
        return

    db = _database.mongo_client.get_default_database()
    collection = db["outbox_events"]

    existing = await collection.find_one(
        {"idempotency_key": idempotency_key, "status": {"$ne": "FAILED"}}
    )
    if existing:
        logger.debug("Outbox event already queued", idempotency_key=idempotency_key)
        return

    doc = {
        "idempotency_key": idempotency_key,
        "exchange": exchange,
        "routing_key": event_type,
        "event_type": event_type,
        "payload": payload,
        "status": "PENDING",
        "retries": 0,
        "created_at": datetime.now(timezone.utc),
    }

    try:
        await collection.insert_one(doc)
        logger.info("Outbox event persisted", event_type=event_type)
    except Exception as exc:
        logger.warning("Failed to insert outbox event", event_type=event_type, error=repr(exc))
        return

    if await _try_publish(doc):
        await collection.update_one(
            {"_id": doc["_id"]},
            {"$set": {"status": "SENT", "sent_at": datetime.now(timezone.utc)}},
        )


async def _try_publish(event: dict) -> bool:
    if not await _rabbitmq.ensure_ready():
        return False
    try:
        async with _rabbitmq.rabbitmq_connection.channel() as channel:
            exchange_obj = await channel.declare_exchange(
                event["exchange"], aio_pika.ExchangeType.TOPIC, durable=True,
            )
            await exchange_obj.publish(
                aio_pika.Message(
                    body=json.dumps(event["payload"], default=str).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    # Stamp the idempotency key as both message_id and a header so
                    # cross-service consumers (e.g. IAM's journey dispatcher, which
                    # keys dedup off the header) can identify the delivery.
                    message_id=event.get("idempotency_key"),
                    headers={"idempotency_key": event.get("idempotency_key")},
                ),
                routing_key=event["routing_key"],
            )
        logger.info("Outbox event published to RabbitMQ", routing_key=event["routing_key"])
        return True
    except Exception as exc:
        logger.warning(
            "Outbox publish failed (relay will retry)",
            routing_key=event.get("routing_key"),
            error=repr(exc),
        )
        return False


async def _relay_loop() -> None:
    while True:
        try:
            await _relay_batch()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Outbox relay error", error=repr(exc))
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def _relay_batch() -> None:
    if not _database.mongo_client:
        return

    # If the broker is unreachable, skip this tick entirely so a transient outage
    # doesn't burn each event's retry budget (which would dead-letter perfectly
    # good messages). Retries are spent only on genuine per-message publish
    # failures while the broker is up.
    if not await _rabbitmq.ensure_ready():
        return

    db = _database.mongo_client.get_default_database()
    collection = db["outbox_events"]

    events = await collection.find(
        {"status": {"$in": ["PENDING", "FAILED"]}, "retries": {"$lt": MAX_RETRIES}},
    ).sort("created_at", 1).limit(RELAY_BATCH_SIZE).to_list(length=RELAY_BATCH_SIZE)

    for event in events:
        if await _try_publish(event):
            await collection.update_one(
                {"_id": event["_id"]},
                {"$set": {"status": "SENT", "sent_at": datetime.now(timezone.utc)}},
            )
        else:
            new_retries = event.get("retries", 0) + 1
            if new_retries >= MAX_RETRIES:
                # Genuine, repeated publish failure while the broker is up — more
                # retries won't help. Mark dead, stamp the time, and alert loudly
                # ONCE (the relay query filters retries < MAX_RETRIES, so it won't
                # be picked up again). Row kept for audit/replay.
                await collection.update_one(
                    {"_id": event["_id"]},
                    {"$set": {
                        "retries": new_retries,
                        "status": "FAILED",
                        "dead_lettered_at": datetime.now(timezone.utc),
                    }},
                )
                logger.error(
                    "Outbox event exhausted retries — needs manual intervention",
                    event_id=str(event.get("_id")),
                    event_type=event.get("event_type"),
                    exchange=event.get("exchange"),
                    idempotency_key=event.get("idempotency_key"),
                )
            else:
                await collection.update_one(
                    {"_id": event["_id"]},
                    {"$set": {"retries": new_retries, "status": "PENDING"}},
                )


async def run_outbox_worker() -> None:
    await _relay_loop()
