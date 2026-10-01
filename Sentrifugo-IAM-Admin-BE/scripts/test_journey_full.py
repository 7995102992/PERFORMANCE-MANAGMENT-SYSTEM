"""One-shot journey milestone test — fresh org + employee, all node types.

Mints a brand-new organisation id + employee user_id and publishes the FULL set
of journey milestones directly to the shared ``domain_events`` exchange:

    onboarded → L1 changed → designation changed → project assigned →
    leave allocated → service request raised → timesheet approved → exit

The IAM journey consumer (must be running) builds the complete timeline + the
per-FY metrics. Nothing else needs to be running — no other services, no API
auth for setup.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.test_journey_full

Then verify — authorize as SUPER ADMIN (the org is synthetic, so there's no
org admin to log in as; super admin bypasses org-scoping):

    GET /journey/<printed user_id>

Each run mints a new user_id, so journeys never collide between runs.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import aio_pika
from bson import ObjectId

from src.config import settings

EXCHANGE = "domain_events"


def _new_oid() -> str:
    return str(ObjectId())


def _build_events(user_id: str, org_id: str) -> list[tuple[str, dict, str]]:
    """(routing_key, payload, idempotency_key) for every journey milestone.
    Dates are spread across years so the timeline reads like a real career."""
    base = datetime(2020, 4, 1, tzinfo=timezone.utc)

    def yr(n: int) -> str:
        return (base + timedelta(days=365 * n)).isoformat()

    return [
        (
            "employee.created",
            {
                "user_id": user_id, "organisation_id": org_id,
                "name": "Test Journey Employee", "emp_code": "TJ-001",
                "date_of_joining": yr(0),
            },
            f"employee.created:{user_id}",
        ),
        (
            "employee.updated",
            {
                "user_id": user_id, "organisation_id": org_id,
                "changed_fields": ["l1_manager_id", "designation_id"],
                "l1_manager_id": _new_oid(),
                "designation_id": _new_oid(),
            },
            f"employee.updated:{user_id}:promo",
        ),
        (
            "project.assigned",
            {
                "user_id": user_id, "organisation_id": org_id,
                "project_id": _new_oid(), "project_name": "Project Phoenix",
                "assigned_on": yr(2),
            },
            f"project.assigned:{user_id}",
        ),
        (
            "leave.allocated",
            {
                "user_id": user_id, "organisation_id": org_id,
                "leave_type_id": _new_oid(), "leave_year": 2023,
                "amount_hours": 160.0, "allocated_on": yr(3),
            },
            f"leave.allocated:{user_id}:2023",
        ),
        (
            "service_request.raised",
            {
                "user_id": user_id, "organisation_id": org_id,
                "sr_id": _new_oid(), "ticket_no": "SR-1001",
                "title": "Laptop replacement", "category": "IT Support",
                "raised_on": yr(4),
            },
            f"service_request.raised:{user_id}:1",
        ),
        (
            "timesheet.approved",
            {
                "user_id": user_id, "organisation_id": org_id,
                "hours": 40.0, "period_end": yr(4),
            },
            f"timesheet.approved:{user_id}:1",
        ),
        (
            "exit.applied",
            {
                "user_id": user_id, "org_id": org_id, "exit_id": _new_oid(),
                "reason_for_exit": "Resigned", "last_working_day": yr(5),
            },
            f"exit.applied:{user_id}",
        ),
    ]


async def main() -> None:
    org_id = _new_oid()
    user_id = _new_oid()
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
            print(f"  published {routing_key}")

    print(
        "\n──────────────────────────────────────────────\n"
        f"  org_id : {org_id}\n"
        f"  user_id: {user_id}\n"
        "──────────────────────────────────────────────\n"
        "Wait ~1s, then (authorized as SUPER ADMIN):\n"
        f"  GET /journey/{user_id}\n\n"
        "Expect 6 timeline nodes (onboarded, l1_changed, designation_changed,\n"
        "project_assigned, leave_allocated, service_request_raised, exit) and\n"
        "metrics with worked_hours=40 and service_requests_count=1."
    )


if __name__ == "__main__":
    asyncio.run(main())
