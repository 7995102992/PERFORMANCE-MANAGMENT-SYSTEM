# Employee Data Flow via RabbitMQ — Integration Guide for Leave Management

IAM Admin BE publishes employee lifecycle events (`created`, `updated`, `deleted`) to RabbitMQ. This guide shows what events are published, their payloads, and how to consume them in the Leave Management module.

---

## Architecture

```
IAM Admin BE (Producer)                          Leave Management BE (Consumer)
─────────────────────                            ─────────────────────────────
Employee Create ──►  outbox.publish()            bind queue to "employee.*"
Employee Update ──►     │                              │
Employee Delete ──►     │                              ▼
Bulk Upload     ──►     │                        on_message() handler
                        │                              │
                        ▼                              ▼
                   ┌─────────────────┐           Upsert/delete in local
                   │  domain_events  │           employees collection
                   │  (TOPIC exchange)│           (or cache/lookup table)
                   └─────────────────┘
```

All three events go to the **`domain_events`** exchange (TOPIC, durable) with routing keys:
- `employee.created`
- `employee.updated`
- `employee.deleted`

---

## Event Payloads

### `employee.created`

Published when a single employee is created (including each row during bulk upload).

```json
{
    "correlation_id": "uuid-string",
    "employee_id": "67a1b2c3d4e5f6...",
    "organisation_id": "67a1b2c3d4e5f6...",
    "emp_code": "EMP-0042",
    "work_email": "john.doe@company.com",
    "name": "John Doe",
    "first_name": "John",
    "last_name": "Doe",
    "l1_manager_id": "67a1b2c3..." | null,
    "l2_manager_id": "67a1b2c3..." | null,
    "designation_id": "67a1b2c3..." | null,
    "department_id": "67a1b2c3..." | null,
    "business_unit_id": "67a1b2c3..." | null,
    "employment_status": "active" | "probation" | ...,
    "date_of_joining": "2026-05-01" | null
}
```

### `employee.updated`

Published when any employee field is updated.

```json
{
    "correlation_id": "uuid-string",
    "employee_id": "67a1b2c3d4e5f6...",
    "organisation_id": "67a1b2c3d4e5f6...",
    "emp_code": "EMP-0042",
    "work_email": "john.doe@company.com",
    "name": "John Doe",
    "l1_manager_id": "67a1b2c3..." | null,
    "l2_manager_id": "67a1b2c3..." | null,
    "designation_id": "67a1b2c3..." | null,
    "department_id": "67a1b2c3..." | null,
    "business_unit_id": "67a1b2c3..." | null,
    "employment_status": "active",
    "changed_fields": ["first_name", "designation_id", "l1_manager_id"]
}
```

`changed_fields` tells you exactly what changed — useful if you only need to react to specific field changes (e.g., manager change affects leave approval chain).

### `employee.deleted`

Published when an employee is soft-deleted.

```json
{
    "correlation_id": "uuid-string",
    "employee_id": "67a1b2c3d4e5f6...",
    "organisation_id": "67a1b2c3d4e5f6..."
}
```

---

## Bulk Upload Behavior

During bulk upload, IAM Admin BE calls `create()` for each row individually. This means:
- Each employee created fires its own `employee.created` event
- Your consumer doesn't need special bulk handling — it processes one event at a time
- Events arrive in rapid succession during a bulk import, so design your consumer to handle bursts

---

## How to Consume These Events

### Step 1: Add `aio-pika` dependency

```bash
pip install aio-pika
```

### Step 2: Add `RABBITMQ_URL` to your config

```python
# config.py or settings.py
RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"
```

### Step 3: Create a consumer module

Create `src/rabbitmq/consumer.py` (or similar):

```python
import asyncio
import json
import logging

import aio_pika

from src.config import settings

logger = logging.getLogger(__name__)

_connection: aio_pika.RobustConnection | None = None
_consumer_task: asyncio.Task | None = None

EXCHANGE_NAME = "domain_events"
QUEUE_NAME = "leave_management.employee_sync"
ROUTING_KEYS = ["employee.created", "employee.updated", "employee.deleted"]


async def start_consumer() -> None:
    global _connection, _consumer_task
    _connection = await aio_pika.connect_robust(
        settings.RABBITMQ_URL,
        heartbeat=30,
        reconnect_interval=5,
    )
    _consumer_task = asyncio.create_task(_consume())
    logger.info("Employee event consumer started")


async def stop_consumer() -> None:
    if _consumer_task and not _consumer_task.done():
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    if _connection:
        await _connection.close()
    logger.info("Employee event consumer stopped")


async def _consume() -> None:
    async with _connection.channel() as channel:
        await channel.set_qos(prefetch_count=10)

        exchange = await channel.declare_exchange(
            EXCHANGE_NAME, aio_pika.ExchangeType.TOPIC, durable=True,
        )
        queue = await channel.declare_queue(QUEUE_NAME, durable=True)

        for key in ROUTING_KEYS:
            await queue.bind(exchange, routing_key=key)

        async with queue.iterator() as queue_iter:
            async for message in queue_iter:
                async with message.process():
                    try:
                        await _handle_message(
                            message.routing_key,
                            json.loads(message.body),
                            message.headers or {},
                        )
                    except Exception:
                        logger.exception(
                            "Failed to process %s", message.routing_key,
                        )


async def _handle_message(
    routing_key: str, payload: dict, headers: dict,
) -> None:
    idempotency_key = headers.get("idempotency_key")
    # TODO: check idempotency_key against a processed set to skip duplicates

    if routing_key == "employee.created":
        await _on_employee_created(payload)
    elif routing_key == "employee.updated":
        await _on_employee_updated(payload)
    elif routing_key == "employee.deleted":
        await _on_employee_deleted(payload)


async def _on_employee_created(data: dict) -> None:
    """Upsert employee into local collection for leave lookups."""
    # Example: store a lightweight employee record locally
    #
    # from src.models import EmployeeCache
    # await EmployeeCache.find_one(
    #     {"employee_id": data["employee_id"]}
    # ).upsert(
    #     {"$set": {
    #         "employee_id": data["employee_id"],
    #         "organisation_id": data["organisation_id"],
    #         "emp_code": data["emp_code"],
    #         "name": data["name"],
    #         "work_email": data["work_email"],
    #         "l1_manager_id": data.get("l1_manager_id"),
    #         "l2_manager_id": data.get("l2_manager_id"),
    #         "department_id": data.get("department_id"),
    #         "designation_id": data.get("designation_id"),
    #         "business_unit_id": data.get("business_unit_id"),
    #         "employment_status": data.get("employment_status"),
    #         "date_of_joining": data.get("date_of_joining"),
    #     }},
    # )
    logger.info("Employee created: %s", data.get("employee_id"))


async def _on_employee_updated(data: dict) -> None:
    """Update local employee record. Check changed_fields if you only
    care about specific changes (e.g., manager changes affect approval chain)."""
    changed = data.get("changed_fields", [])
    logger.info(
        "Employee updated: %s, changed: %s",
        data.get("employee_id"), changed,
    )
    # Fields relevant to leave management:
    #   - l1_manager_id / l2_manager_id  → leave approval chain
    #   - employment_status              → block leave for exited employees
    #   - department_id / business_unit_id → leave policy assignment


async def _on_employee_deleted(data: dict) -> None:
    """Mark employee inactive locally. Cancel/reject pending leave requests."""
    logger.info("Employee deleted: %s", data.get("employee_id"))
```

### Step 4: Wire into app lifespan

```python
# main.py
from .rabbitmq.consumer import start_consumer, stop_consumer

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    try:
        await start_consumer()
    except Exception as e:
        logger.warning("rabbitmq consumer failed to start: %s", e)
    yield
    await stop_consumer()
    await close_db()
```

---

## What Fields Matter for Leave Management

| Field | Why It Matters |
|-------|---------------|
| `employee_id` | Primary key — link leave requests to employees |
| `organisation_id` | Multi-tenancy — scope all queries |
| `emp_code` | Display in leave reports |
| `name` / `work_email` | Display and notifications |
| `l1_manager_id` | Leave approval chain (L1 approver) |
| `l2_manager_id` | Escalation approver |
| `department_id` | Department-level leave policies |
| `business_unit_id` | BU-level leave policies |
| `designation_id` | Role-based leave entitlements |
| `employment_status` | Block leave for inactive/exited employees |
| `date_of_joining` | Calculate leave accruals and probation rules |

---

## Publishing Your Own Events (Leave Events)

If you also want to publish leave events (for audit or cross-service), copy the `rabbitmq/` outbox package from IAM Admin BE. Full setup:

### 1. Copy `src/rabbitmq/` folder (4 files)

```
src/rabbitmq/
├── __init__.py
├── connection.py
├── constants.py
└── outbox.py
```

Update import paths if needed (e.g., `from src.config` → your config import).

### 2. Add `OutboxEventDocument` to your models

```python
from uuid import uuid4
from typing import Literal, Optional
from datetime import datetime
from beanie import Document
from pydantic import Field
from pymongo import IndexModel, ASCENDING

class OutboxEventDocument(Document):
    id: str = Field(default_factory=lambda: str(uuid4()))
    idempotency_key: str
    exchange: str = "domain_events"
    event_type: str
    payload: dict
    status: Literal["pending", "sent", "failed"] = "pending"
    retries: int = 0
    created_at: datetime
    sent_at: Optional[datetime] = None

    class Settings:
        name = "outbox_events"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]
```

Add it to your Beanie `init_beanie` document list.

### 3. Publish from service layer

```python
from src.rabbitmq import outbox
from src.rabbitmq.constants import DebugLevel

# After leave request creation
await outbox.publish_audit_log(
    module="leave",
    actor_id=str(user.id),
    action="leave.requested",
    resource=f"leave:{leave_id}",
    debug_level=DebugLevel.EMPLOYEE,
    metadata={
        "employee_id": str(user.id),
        "leave_type": body.leave_type,
        "start_date": str(body.start_date),
        "end_date": str(body.end_date),
    },
)

# After leave approval
await outbox.publish_audit_log(
    module="leave",
    actor_id=str(approver.id),
    action="leave.approved",
    resource=f"leave:{leave_id}",
    debug_level=DebugLevel.MANAGER,
    metadata={"employee_id": request.employee_id},
)
```

---

## Idempotency

Messages are delivered **at-least-once**. Your consumer may receive the same event twice (e.g., after a crash before ack). Handle this by:

1. Using `idempotency_key` from message headers (format: `employee.created:<employee_id>`)
2. Using upsert operations instead of insert (so re-processing is a no-op)
3. Optionally tracking processed keys in a small collection

---

## Queue Naming Convention

Use the pattern: `<service_name>.<purpose>`

Examples:
- `leave_management.employee_sync` — Leave Management consuming employee events
- `timesheet.employee_sync` — Timesheet consuming employee events

Each service gets its own queue bound to the same exchange, so all services receive all events independently.
