"""Send the activation email to an organisation's employees (IAM).

Uses the exact same path the create-employee flow uses —
``src.auth.service.send_activation_email``: an activation JWT + a fallback
password-reset token are stored in Valkey and one ``email.activation`` event is
written to the transactional outbox. The outbox relay -> RabbitMQ -> schedule
service turns that into the real email, so **Valkey, the relay and the schedule
service must be running** for anything to actually land in an inbox.

Employees land on the user portal (``USER_FRONTEND_URL``); org/super admins,
only if you explicitly include them, land on the admin portal.

Default audience: users of the org that are pending activation —
``activated_at`` is null AND no ``password_hash`` — i.e. exactly what
scripts/clear_employee_passwords.py leaves behind. Org admins and super admins
are excluded unless --include-admins is passed.

Employees who have left are ALWAYS excluded, in every mode (including --all and
--only): an ended employment status (Exit / Retired / Terminated / Absconded —
the EMPLOYMENT_STATUSES master data rows with is_active=false, same rule as
src.auth.service._has_ended_employment_status) or a date_of_exit in the past.
Someone serving notice is still an employee and still gets the email.

Modes:
    python -m scripts.send_activation_emails --org-id <id>                    # DRY RUN
    python -m scripts.send_activation_emails --org-id <id> --commit           # send
    python -m scripts.send_activation_emails --org-id <id> --commit --only a@b.com
    python -m scripts.send_activation_emails --org-id <id> --commit --limit 25

Re-running is safe: each run issues fresh tokens, and the older ones simply stay
valid until their TTL (ACTIVATION_TOKEN_EXPIRE_HOURS) expires.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from datetime import datetime, timezone
from uuid import uuid4

from beanie import init_beanie
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import valkey  # noqa: E402
from src.config import settings  # noqa: E402
from src.correlation import correlation_id_ctx  # noqa: E402
from src.models import OutboxEventDocument  # noqa: E402

DEFAULT_REPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "activation_emails_sent.csv")


def full_name(u: dict) -> str:
    return " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x).strip() \
        or u.get("email", "")


async def exited_user_ids(db, org_id: ObjectId) -> set[ObjectId]:
    """user_ids of employees who have left.

    Mirrors src.auth.service._has_ended_employment_status: Exit / Retired /
    Terminated / Absconded are exactly the EMPLOYMENT_STATUSES master-data rows
    with ``is_active`` false. A past ``date_of_exit`` counts too, in case the
    status was never flipped. Someone serving notice has a *future* exit date
    and an active status, so they still get the email. Accounts with no
    employee record (admins) are never in the set.
    """
    ended = await db["master_data"].find(
        {"category": "EMPLOYMENT_STATUSES", "is_active": False}, {"_id": 1}
    ).to_list(length=None)
    ended_ids = [d["_id"] for d in ended]

    # Beanie stores a `date` as midnight datetime, so compare against one.
    # Strictly before today: someone whose last working day *is* today is still
    # an employee.
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    or_clauses: list[dict] = [{"date_of_exit": {"$ne": None, "$lt": today}}]
    if ended_ids:
        or_clauses.append({"employment_status": {"$in": ended_ids}})

    emps = await db["employees"].find(
        {"organisation_id": org_id, "$or": or_clauses}, {"user_id": 1},
    ).to_list(length=None)
    return {e["user_id"] for e in emps if e.get("user_id")}


async def load_recipients(db, org_id: ObjectId, args) -> tuple[list[dict], list[dict]]:
    q: dict = {"organisation_id": org_id, "deleted_on": None}
    if not args.include_admins:
        q["is_org_admin"] = {"$ne": True}
        q["is_super_admin"] = {"$ne": True}
    if not args.all and not args.only:
        # Pending activation only — never re-activate someone who already has a
        # working login. --only names the recipients explicitly, so it sends
        # regardless of activation status.
        q["activated_at"] = None
        q["$or"] = [{"password_hash": None}, {"password_hash": {"$exists": False}}]
    if args.only:
        q["email"] = {"$in": [e.strip().lower() for e in args.only]}

    cur = db["users"].find(q, projection={
        "email": 1, "first_name": 1, "last_name": 1, "status": 1,
        "activated_at": 1, "password_hash": 1, "is_org_admin": 1, "is_super_admin": 1,
    }).sort("email", 1)
    users = await cur.to_list(length=None)

    # Exited employees never get an activation link — not even via --only/--all.
    exited = await exited_user_ids(db, org_id)
    skipped = [u for u in users if u["_id"] in exited]
    users = [u for u in users if u["_id"] not in exited]

    if args.limit:
        users = users[:args.limit]
    return users, skipped


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--org-id", required=True, help="organisation _id to email")
    p.add_argument("--commit", action="store_true", help="actually send (default is a dry run)")
    p.add_argument("--all", action="store_true",
                   help="email everyone in the org, not just pending-activation users")
    p.add_argument("--include-admins", action="store_true",
                   help="also email org/super admins (routed to the admin portal)")
    p.add_argument("--only", action="append", metavar="EMAIL",
                   help="restrict to these emails (repeatable) — sends regardless of "
                        "activation status; use for a test/re-send")
    p.add_argument("--limit", type=int, help="cap the number of emails this run")
    p.add_argument("--delay", type=float, default=0.2,
                   help="seconds between sends (default 0.2)")
    p.add_argument("--report", default=DEFAULT_REPORT, help="per-user result CSV")
    args = p.parse_args()

    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MongoDB is not configured (MONGO_DB_HOST/.env).")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    if db is None:
        raise SystemExit("ERROR: no default database in MONGODB_URL — set MONGO_DB_NAME.")

    org_id = ObjectId(args.org_id)
    org = await db["organisations"].find_one({"_id": org_id}, {"name": 1})
    if not org:
        client.close()
        raise SystemExit(f"ERROR: organisation {org_id} not found.")

    users, exited = await load_recipients(db, org_id, args)

    print(f"\norganisation : {org.get('name')} ({org_id})")
    audience = ("explicit --only list (any activation status)" if args.only
                else "ALL users" if args.all else "pending activation only")
    print(f"audience     : {audience}"
          f"{'' if args.include_admins else ', org/super admins excluded'}"
          ", exited employees excluded")
    print(f"portal       : {settings.USER_FRONTEND_URL or settings.FRONTEND_URL or '(unset!)'}")
    print(f"recipients   : {len(users)}")
    for u in users[:20]:
        print(f"   - {u.get('email')}  [{u.get('status')}]")
    if len(users) > 20:
        print(f"   ... and {len(users) - 20} more")
    if exited:
        print(f"\nskipped (exited employees): {len(exited)}")
        for u in exited[:20]:
            print(f"   - {u.get('email')}")
        if len(exited) > 20:
            print(f"   ... and {len(exited) - 20} more")

    if not (settings.USER_FRONTEND_URL or settings.FRONTEND_URL):
        print("\nWARNING: neither USER_FRONTEND_URL nor FRONTEND_URL is set — the "
              "activation link in the email would be relative and unusable.")

    if not args.commit:
        print("\nDRY RUN — no tokens issued, no events published. Re-run with --commit.")
        client.close()
        return

    if not users:
        print("\nnothing to send.")
        client.close()
        return

    # Valkey is mandatory: the tokens live there and an email whose token was
    # never stored is dead on arrival.
    await valkey.init_valkey()
    try:
        await valkey.valkey_client.ping()
    except Exception as exc:  # noqa: BLE001
        client.close()
        raise SystemExit(f"ERROR: Valkey unreachable ({exc}) — tokens cannot be stored. Aborting.")

    # Only the outbox document is needed; the relay picks the events up from there.
    await init_beanie(database=db, document_models=[OutboxEventDocument])

    from src.auth.service import send_activation_email  # noqa: E402 — needs settings/valkey ready

    sent = failed = 0
    with open(args.report, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["user_id", "email", "result", "error", "at"])
        w.writeheader()
        for u in users:
            uid, email = str(u["_id"]), u.get("email", "")
            is_admin = bool(u.get("is_org_admin") or u.get("is_super_admin"))
            # No inbound request here, so the correlation contextvar is still "" —
            # and the consumer's TaskMessage.correlation_id is a UUID, so an empty
            # one gets the message rejected as malformed. Stamp one per email.
            correlation_id_ctx.set(str(uuid4()))
            try:
                await send_activation_email(
                    uid, email, full_name(u),
                    tenant_id=str(org_id),
                    is_admin_portal=is_admin,
                )
                sent += 1
                row = {"result": "queued", "error": ""}
            except Exception as exc:  # noqa: BLE001 — one bad address must not stop the run
                failed += 1
                row = {"result": "failed", "error": str(exc)}
                print(f"   FAILED {email}: {exc}")
            w.writerow({"user_id": uid, "email": email,
                        "at": datetime.now(timezone.utc).isoformat(), **row})
            if args.delay:
                await asyncio.sleep(args.delay)

    await valkey.close_valkey()
    client.close()

    print(f"\nDONE — {sent} activation events queued, {failed} failed. report: {args.report}")
    print("Delivery still depends on the outbox relay + RabbitMQ + the schedule service; "
          "check the outbox_events collection for anything stuck in status='pending'.")


if __name__ == "__main__":
    asyncio.run(main())
