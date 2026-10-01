import uuid
from datetime import datetime, timezone


def outbox_event_to_mongo_doc(
    event_type: str,
    routing_key: str,
    payload: dict,
    exchange: str | None = None,
) -> dict:
    """Build a MongoDB outbox_events document."""
    now = datetime.now(timezone.utc)
    doc = {
        "_id": str(uuid.uuid4()),
        "event_type": event_type,
        "routing_key": routing_key,
        "payload": payload,
        "status": "PENDING",
        "retries": 0,
        "created_at": now,
        "updated_at": now,
    }
    if exchange:
        doc["exchange"] = exchange
    return doc
