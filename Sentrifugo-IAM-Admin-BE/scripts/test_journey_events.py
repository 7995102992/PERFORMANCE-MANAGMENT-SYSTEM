"""Drive cross-service journey events for testing.

Publishes the canonical domain events that the Timesheet / Leave / SRM
producers emit — directly to the shared ``domain_events`` exchange — so the IAM
journey consumer (which must be running) populates journey_timeline +
journey_metrics for the project / leave / service-request node types.

This lets you smoke-test the *full* multi-service journey without standing up
all four services: seed the org first (so an employee with a BU exists), then
run this to inject the cross-service events.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    # auto-pick the first active employee:
    python -m scripts.test_journey_events
    # or target a specific employee/org:
    python -m scripts.test_journey_events --user-id <USER_ID> --org-id <ORG_ID>

Prerequisites:
    - IAM Admin BE running (its lifespan starts the journey consumer)
    - An org already seeded via scripts.seed_org_via_api (employee must have a BU,
      so the consumer can resolve the financial year for metrics)

Verify afterwards:
    GET /journey/{user_id}   (or POST /journey/batch { "user_ids": [...] })

Note: each run uses fresh idempotency keys, so re-running ADDS more nodes and
keeps incrementing the worked-hours / SR-count metrics. Drop the
journey_timeline / journey_metrics / journey_processed_events collections to reset.
"""
import argparse
import asyncio
import json
import os
from datetime import datetime, timezone
from uuid import uuid4

import aio_pika
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

EXCHANGE = "domain_events"


async def _pick_employee(user_id: str | None, org_id: str | None) -> tuple[str, str]:
    """Resolve (user_id, org_id) — use the args if given, else pick the first
    active employee that has a linked user + business unit."""
    if user_id and org_id:
        return user_id, org_id

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    emp = await db["employees"].find_one(
        {
            "deleted_on": None,
            "user_id": {"$ne": None},
            "business_unit_id": {"$ne": None},
        },
        sort=[("created_on", -1)],  # newest first → targets the latest seeded org
    )
    client.close()
    if not emp:
        raise SystemExit(
            "No seeded employee with a user + business unit found. "
            "Run `python -m scripts.seed_org_via_api` first."
        )
    return str(emp["user_id"]), str(emp["organisation_id"])


def _build_events(user_id: str, org_id: str) -> list[tuple[str, dict, str]]:
    """(routing_key, payload, idempotency_key) for each cross-service event."""
    now = datetime.now(timezone.utc)
    run = uuid4().hex[:8]  # unique per run so re-runs add fresh nodes
    year = now.year
    return [
        (
            "project.assigned",
            {
                "user_id": user_id,
                "organisation_id": org_id,
                "project_id": f"test-project-{run}",
                "project_name": f"Project Phoenix ({run})",
                "assigned_on": now.isoformat(),
            },
            f"project.assigned:test:{run}",
        ),
        (
            "leave.allocated",
            {
                "user_id": user_id,
                "organisation_id": org_id,
                "leave_type_id": "test-annual-leave",
                "leave_year": year,
                "amount_hours": 160.0,
                "allocated_on": now.isoformat(),
            },
            f"leave.allocated:test:{user_id}:{run}",
        ),
        (
            "service_request.raised",
            {
                "user_id": user_id,
                "organisation_id": org_id,
                "sr_id": f"test-sr-{run}",
                "ticket_no": f"SR-{run.upper()}",
                "title": "Laptop replacement request",
                "category": "IT Support",
                "raised_on": now.isoformat(),
            },
            f"service_request.raised:test:{run}",
        ),
        (
            "timesheet.approved",
            {
                "user_id": user_id,
                "organisation_id": org_id,
                "hours": 40.0,
                "period_end": now.isoformat(),
            },
            f"timesheet.approved:test:{run}",
        ),
    ]


async def main() -> None:
    parser = argparse.ArgumentParser(description="Inject cross-service journey events")
    parser.add_argument("--user-id", default=os.getenv("JOURNEY_USER_ID"))
    parser.add_argument("--org-id", default=os.getenv("JOURNEY_ORG_ID"))
    args = parser.parse_args()

    user_id, org_id = await _pick_employee(args.user_id, args.org_id)
    print(f"Target employee: user_id={user_id} org_id={org_id}")

    events = _build_events(user_id, org_id)
    conn = await aio_pika.connect_robust(settings.RABBITMQ_URL)
    async with conn:
        channel = await conn.channel()
        exchange = await channel.declare_exchange(
            EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True,
        )
        for routing_key, payload, idem in events:
            await exchange.publish(
                aio_pika.Message(
                    body=json.dumps(payload, default=str).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    headers={"idempotency_key": idem},
                ),
                routing_key=routing_key,
            )
            print(f"  published {routing_key}  (idempotency_key={idem})")

    print(
        "\nDone. Give the consumer a second, then verify:\n"
        f"  GET /journey/{user_id}\n"
        "Expect: project_assigned, leave_allocated, service_request_raised nodes,\n"
        "and metrics with worked_hours=40 and service_requests_count=1 for the FY."
    )


if __name__ == "__main__":
    asyncio.run(main())
