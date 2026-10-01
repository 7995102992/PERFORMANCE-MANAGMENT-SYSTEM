"""End-to-end journey test across the org's services.

Builds a complete employee journey for one NexaGen employee:

  IAM (REAL API):   onboarded (from seed) → designation change (+ band/pay-grade)
                    → L1 change → L2 change
  Timesheet (REAL,  create client → project → task → assign employee → assign
   inject fallback):  approver → submit weekly timesheet → approve
                    → project_assigned + worked-hours metric
  Leave / SRM / Exit (INJECTED events): leave_allocated, service_request_raised,
                    exit  (+ SR-count metric)

Whatever can't be driven through a real API (e.g. the timesheet service isn't
reachable on the configured URL) is published as a domain event instead, so the
journey always ends up complete. The IAM journey consumer must be running.

Prerequisites:
    - IAM Admin BE running at IAM_URL (default http://localhost:8000), journey
      consumer started by its lifespan.
    - NexaGen org seeded:  python -m scripts.seed_org_via_api
    - (optional, for the REAL timesheet flow) Timesheet service running at
      TS_URL with the right TS_PREFIX.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.test_journey_e2e
    # custom service locations:
    IAM_URL=http://localhost:8000 TS_URL=http://localhost:8001 TS_PREFIX=/api/v1 \
        python -m scripts.test_journey_e2e

Verify (authorized as super admin or orgadmin@nexagen.com / test@123):
    GET /journey/<printed user_id>
"""
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

import aio_pika
import httpx
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

IAM_URL = os.getenv("IAM_URL", "http://localhost:8000").rstrip("/")
TS_URL = os.getenv("TS_URL", "http://localhost:8001").rstrip("/")
TS_PREFIX = os.getenv("TS_PREFIX", "")  # timesheet API_PREFIX, e.g. "/api/v1"
ORG_NAME = "NexaGen Solutions Pvt Ltd"
ORG_ADMIN = ("orgadmin@nexagen.com", "test@123")
EMP_PASSWORD = "test@123"
EXCHANGE = "domain_events"
TIMEOUT = 30.0


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

async def _login(client: httpx.AsyncClient, base: str, email: str, pw: str) -> str | None:
    try:
        r = await client.post(f"{base}/auth/login", json={"email": email, "password": pw})
        r.raise_for_status()
        return r.json().get("access_token")
    except Exception as exc:
        print(f"  ! login failed for {email}: {exc}")
        return None


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ─── Event injection (for Leave / SRM / Exit + timesheet fallback) ────────────

async def _inject(events: list[tuple[str, dict, str]]) -> None:
    conn = await aio_pika.connect_robust(settings.RABBITMQ_URL)
    async with conn:
        ch = await conn.channel()
        ex = await ch.declare_exchange(EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True)
        for rk, payload, idem in events:
            await ex.publish(
                aio_pika.Message(
                    body=json.dumps(payload, default=str).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    headers={"idempotency_key": idem},
                ),
                routing_key=rk,
            )
            print(f"  injected {rk}")


# ─── DB lookups (raw motor — no Beanie coupling) ──────────────────────────────

async def _load_context() -> dict:
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    org = await db["organisations"].find_one({"legal_name": ORG_NAME, "deleted_on": None})
    if not org:
        client.close()
        raise SystemExit(
            f"Org '{ORG_NAME}' not found. Run `python -m scripts.seed_org_via_api` first."
        )
    org_id = org["_id"]
    emps = await db["employees"].find(
        {"organisation_id": org_id, "deleted_on": None, "user_id": {"$ne": None}}
    ).to_list(length=200)
    desigs = await db["designations"].find(
        {"organisation_id": org_id, "deleted_on": None, "is_active": True}
    ).to_list(length=50)
    if len(emps) < 3 or len(desigs) < 2:
        client.close()
        raise SystemExit("Need at least 3 employees and 2 designations in the seeded org.")

    # The "subject" employee whose journey we build; plus a couple of others to
    # serve as new managers and a different designation.
    subject = emps[1]
    others = [e for e in emps if e["_id"] != subject["_id"]]
    new_l1, new_l2 = others[0], others[1]
    cur_desig = subject.get("designation_id")
    new_desig = next((d for d in desigs if d["_id"] != cur_desig), desigs[0])

    user = await db["users"].find_one({"_id": subject["user_id"]})
    client.close()
    return {
        "org_id": str(org_id),
        "subject_user_id": str(subject["user_id"]),
        "subject_email": (user or {}).get("email"),
        "new_designation_id": str(new_desig["_id"]),
        "new_l1_user_id": str(new_l1["user_id"]),
        "new_l2_user_id": str(new_l2["user_id"]),
    }


# ─── IAM milestones (REAL) ────────────────────────────────────────────────────

async def _drive_iam(client: httpx.AsyncClient, ctx: dict, admin_token: str) -> None:
    """Change designation + L1 + L2 on the subject → fires designation_changed,
    l1_changed, l2_changed (onboarded already exists from the seed)."""
    payload = {
        "designationId": ctx["new_designation_id"],
        "l1ManagerId": ctx["new_l1_user_id"],
        "l2ManagerId": ctx["new_l2_user_id"],
    }
    try:
        r = await client.put(
            f"{IAM_URL}/employees/{ctx['subject_user_id']}",
            json=payload, headers=_auth(admin_token),
        )
        r.raise_for_status()
        print("  IAM: designation + L1 + L2 updated (designation_changed / l1_changed / l2_changed)")
    except Exception as exc:
        print(f"  ! IAM employee update failed: {exc}")


# ─── Timesheet milestones (REAL, with inject fallback) ────────────────────────

def _last_monday() -> datetime:
    today = datetime.now(timezone.utc).date()
    monday = today - timedelta(days=today.weekday() + 7)  # previous week's Monday
    return datetime(monday.year, monday.month, monday.day, tzinfo=timezone.utc)


async def _drive_timesheet(client: httpx.AsyncClient, ctx: dict, admin_token: str) -> bool:
    """Real timesheet flow. Returns True if it fired the events, False if the
    caller should inject them instead."""
    ts = f"{TS_URL}{TS_PREFIX}"
    h = _auth(admin_token)

    # Done step-by-step so a failure at any point falls back to injection.
    try:
        rc = await client.post(f"{ts}/clients", headers=h, json={
            "name": "Acme Client", "contact_person": "Jane Doe",
            "contact_phone": "9999999999", "country": "India", "state": "Telangana",
        })
        rc.raise_for_status()
        client_id = rc.json()["id"]

        rp = await client.post(f"{ts}/projects", headers=h, json={
            "client_id": client_id, "name": "Project Phoenix",
            "client_approval_required": False,
        })
        rp.raise_for_status()
        project_id = rp.json()["id"]

        rt = await client.post(f"{ts}/tasks", headers=h, json={"name": "Development"})
        rt.raise_for_status()
        task_id = rt.json()["id"]

        (await client.post(f"{ts}/projects/{project_id}/tasks", headers=h,
                           json={"task_id": task_id})).raise_for_status()

        # Assign the subject (with the task) — fires project.assigned.
        (await client.post(f"{ts}/projects/{project_id}/resources", headers=h, json={
            "user_id": ctx["subject_user_id"], "task_id": task_id,
        })).raise_for_status()

        # Org admin assigned project-level so they can approve.
        admin_uid = _jwt_uid(admin_token)
        (await client.post(f"{ts}/projects/{project_id}/resources", headers=h, json={
            "user_id": admin_uid,
        })).raise_for_status()

        # Org approval off → L1 approval finalises (CLIENT_APPROVED).
        (await client.put(f"{ts}/settings/approval", headers=h, json={
            "approval_required": False, "allow_future_entries": True,
            "allow_past_entries_days": 365, "levels": [],
        })).raise_for_status()

        # As the subject: create + fill + submit a weekly timesheet.
        emp_token = await _login(client, IAM_URL, ctx["subject_email"], EMP_PASSWORD)
        if not emp_token:
            return False
        eh = _auth(emp_token)
        monday = _last_monday()
        rts = await client.post(f"{ts}/my-timesheets", headers=eh, json={
            "week_start_date": monday.date().isoformat(),
        })
        rts.raise_for_status()
        ts_id = rts.json()["id"]

        entries = [{
            "project_id": project_id, "task_id": task_id,
            "entry_date": (monday + timedelta(days=d)).date().isoformat(), "hours": 8,
        } for d in range(5)]
        (await client.post(f"{ts}/my-timesheets/{ts_id}/entries", headers=eh,
                           json={"entries": entries})).raise_for_status()
        (await client.post(f"{ts}/my-timesheets/{ts_id}/submit", headers=eh)).raise_for_status()

        # As org admin: approve → CLIENT_APPROVED → timesheet.approved.
        (await client.post(f"{ts}/approvals/timesheets/{ts_id}/approve", headers=h,
                           json={"comments": "ok"})).raise_for_status()
        print("  Timesheet: project + assignment + submit + approve done (REAL)")
        return True
    except Exception as exc:
        print(f"  ! Timesheet real flow failed ({exc}); will inject events instead")
        return False


def _jwt_uid(token: str) -> str:
    """Pull the uid claim from a JWT without verifying (just for the admin user id)."""
    import base64
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("uid", "")
    except Exception:
        return ""


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main() -> None:
    ctx = await _load_context()
    uid, org = ctx["subject_user_id"], ctx["org_id"]
    print(f"Subject employee: user_id={uid} org_id={org} email={ctx['subject_email']}")

    now = datetime.now(timezone.utc)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        admin_token = await _login(client, IAM_URL, *ORG_ADMIN)
        if not admin_token:
            raise SystemExit("Could not log in as NexaGen org admin — is IAM running + seeded?")

        await _drive_iam(client, ctx, admin_token)
        ts_real = await _drive_timesheet(client, ctx, admin_token)

    # Inject everything the real APIs didn't handle.
    injected: list[tuple[str, dict, str]] = []
    if not ts_real:
        injected += [
            ("project.assigned", {
                "user_id": uid, "organisation_id": org,
                "project_id": "test-project", "project_name": "Project Phoenix",
                "assigned_on": now.isoformat(),
            }, f"project.assigned:e2e:{uid}"),
            ("timesheet.approved", {
                "user_id": uid, "organisation_id": org,
                "hours": 40.0, "period_end": now.isoformat(),
            }, f"timesheet.approved:e2e:{uid}"),
        ]
    injected += [
        ("leave.allocated", {
            "user_id": uid, "organisation_id": org, "leave_type_id": "annual",
            "leave_year": now.year, "amount_hours": 160.0, "allocated_on": now.isoformat(),
        }, f"leave.allocated:e2e:{uid}:{now.year}"),
        ("service_request.raised", {
            "user_id": uid, "organisation_id": org, "sr_id": "test-sr",
            "ticket_no": "SR-E2E", "title": "Laptop replacement", "category": "IT Support",
            "raised_on": now.isoformat(),
        }, f"service_request.raised:e2e:{uid}"),
        ("exit.applied", {
            "user_id": uid, "org_id": org, "exit_id": "test-exit",
            "reason_for_exit": "Resigned", "last_working_day": now.isoformat(),
        }, f"exit.applied:e2e:{uid}"),
    ]
    await _inject(injected)

    print(
        "\n──────────────────────────────────────────────\n"
        f"  Subject user_id: {uid}\n"
        f"  Org: {ORG_NAME}\n"
        "──────────────────────────────────────────────\n"
        "Verify (super admin, or orgadmin@nexagen.com / test@123):\n"
        f"  GET /journey/{uid}\n\n"
        "Expect: onboarded, designation_changed, l1_changed, l2_changed,\n"
        "project_assigned, leave_allocated, service_request_raised, exit\n"
        "+ metrics (worked_hours, service_requests_count)."
    )


if __name__ == "__main__":
    asyncio.run(main())
