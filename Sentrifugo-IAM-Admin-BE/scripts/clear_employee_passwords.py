"""Clear the login password of every employee in an organisation (IAM).

Org admins (``is_org_admin``) and super admins are NEVER touched — they keep
their password so someone can always get into the admin portal.

For each targeted user this resets the account to the same state a freshly
imported, never-activated employee is in:

    password_hash      -> None
    password_changed_at-> None
    activated_at       -> None      (source of truth for "pending activation")
    status             -> inactive

That combination matters: ``src.auth.service.activate_account`` refuses a token
when ``status != active AND activated_at is not None`` (that shape means "an
admin deactivated me"), so clearing ``activated_at`` too is what makes the
account activatable again by scripts/send_activation_emails.py.

Pass --keep-status for a password-only wipe (status/activated_at untouched) —
use that when the users should recover via "Forgot password" instead.

Live sessions and mPIN device tokens of every cleared user are revoked in
Valkey, so anyone currently logged in is kicked out.

Reads/writes Mongo directly (raw driver, no Beanie models) so legacy documents
with values outside today's enums still load.

Modes:
    python -m scripts.clear_employee_passwords --org-id <id>            # DRY RUN
    python -m scripts.clear_employee_passwords --org-id <id> --commit   # clear
    python -m scripts.clear_employee_passwords --revert                 # restore from backup CSV

--commit writes a backup CSV (default scripts/cleared_passwords_backup.csv)
holding the previous password HASHES. Keep it out of git and delete it once the
change is confirmed — --revert is the only way back.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import valkey  # noqa: E402
from src.config import settings  # noqa: E402

DEFAULT_BACKUP = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "cleared_passwords_backup.csv")
BACKUP_COLUMNS = ["user_id", "email", "password_hash", "password_changed_at",
                  "activated_at", "status"]


# ───────────────────────── helpers ─────────────────────────
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(v) -> str:
    return v.isoformat() if isinstance(v, datetime) else ""


def parse_dt(s: str):
    return datetime.fromisoformat(s) if s else None


async def connect():
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MongoDB is not configured (MONGO_DB_HOST/.env).")
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    if db is None:
        raise SystemExit("ERROR: no default database in MONGODB_URL — set MONGO_DB_NAME.")
    return client, db


async def revoke_sessions(user_id: str) -> str:
    """Kill live sessions + mPIN devices. Best effort — Valkey being down must
    not abort the wipe (the password is already gone; sessions expire on TTL)."""
    from src.auth.utils.mpin import revoke_all_device_tokens
    from src.auth.utils.sessions import revoke_all_user_sessions
    try:
        await revoke_all_user_sessions(user_id)
        await revoke_all_device_tokens(user_id)
        return ""
    except Exception as exc:  # noqa: BLE001 — reported per user, never fatal
        return str(exc)


async def load_targets(db, org_id: ObjectId, include_inactive: bool) -> list[dict]:
    q: dict = {
        "organisation_id": org_id,
        "deleted_on": None,
        "is_org_admin": {"$ne": True},
        "is_super_admin": {"$ne": True},
    }
    if not include_inactive:
        # Only current staff. Exited employees sit at status != active and must
        # stay locked out — re-pending them would make them activatable again.
        q["status"] = "active"
    cur = db["users"].find(q, projection={
        "email": 1, "first_name": 1, "last_name": 1, "password_hash": 1,
        "password_changed_at": 1, "activated_at": 1, "status": 1,
    })
    return await cur.to_list(length=None)


# ───────────────────────── clear ─────────────────────────
async def run_clear(args) -> None:
    client, db = await connect()
    org_id = ObjectId(args.org_id)

    org = await db["organisations"].find_one({"_id": org_id}, {"name": 1})
    if not org:
        client.close()
        raise SystemExit(f"ERROR: organisation {org_id} not found.")

    users = await load_targets(db, org_id, args.include_inactive)
    with_pw = [u for u in users if u.get("password_hash")]
    already = [u for u in users if not u.get("password_hash")]

    admins = await db["users"].count_documents({
        "organisation_id": org_id, "deleted_on": None,
        "$or": [{"is_org_admin": True}, {"is_super_admin": True}],
    })

    print(f"\norganisation : {org.get('name')} ({org_id})")
    print(f"scope        : {'all users' if args.include_inactive else 'status=active only'}"
          f", org/super admins excluded ({admins} skipped)")
    print(f"targeted     : {len(users)} users — {len(with_pw)} with a password, "
          f"{len(already)} already cleared")
    print(f"mode         : {'password only (status kept)' if args.keep_status else 'full reset to pending'}")
    if args.clear_history:
        print("history      : password_history rows will be deleted too")

    for u in users[:20]:
        print(f"   - {u.get('email')}  [{u.get('status')}]"
              f"{'' if u.get('password_hash') else '  (no password)'}")
    if len(users) > 20:
        print(f"   ... and {len(users) - 20} more")

    if not args.commit:
        print("\nDRY RUN — nothing written. Re-run with --commit to clear these passwords.")
        client.close()
        return

    if not users:
        print("\nnothing to do.")
        client.close()
        return

    await valkey.init_valkey()

    unset: dict = {"password_hash": "", "password_changed_at": ""}
    set_fields: dict = {"modified_on": now_utc(), "modified_by": args.actor}
    if not args.keep_status:
        unset["activated_at"] = ""
        set_fields["status"] = "inactive"

    cleared = hist_deleted = 0
    session_errors: list[str] = []
    with open(args.backup, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=BACKUP_COLUMNS)
        w.writeheader()
        for u in users:
            uid = u["_id"]
            w.writerow({
                "user_id": str(uid),
                "email": u.get("email", ""),
                "password_hash": u.get("password_hash") or "",
                "password_changed_at": iso(u.get("password_changed_at")),
                "activated_at": iso(u.get("activated_at")),
                "status": u.get("status") or "",
            })
            await db["users"].update_one({"_id": uid}, {"$set": set_fields, "$unset": unset})
            cleared += 1

            if args.clear_history:
                res = await db["password_history"].delete_many({"user_id": str(uid)})
                hist_deleted += res.deleted_count

            err = await revoke_sessions(str(uid))
            if err:
                session_errors.append(f"{u.get('email')}: {err}")

    await valkey.close_valkey()
    client.close()

    print(f"\nDONE — {cleared} users cleared. backup: {args.backup}")
    if args.clear_history:
        print(f"       {hist_deleted} password_history rows deleted (not restorable by --revert)")
    if session_errors:
        print(f"       WARNING: session revocation failed for {len(session_errors)} users "
              f"(Valkey?): {session_errors[0]}")
    print("       Next: python -m scripts.send_activation_emails --org-id "
          f"{org_id} --commit")
    print("       The backup CSV contains password hashes — delete it once verified.")


# ───────────────────────── revert ─────────────────────────
async def run_revert(args) -> None:
    if not os.path.exists(args.backup):
        raise SystemExit(f"ERROR: backup not found: {args.backup}")

    with open(args.backup, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise SystemExit("ERROR: backup CSV is empty.")

    client, db = await connect()
    restored = missing = 0
    for r in rows:
        uid = ObjectId(r["user_id"])
        user = await db["users"].find_one({"_id": uid}, {"_id": 1})
        if not user:
            missing += 1
            continue
        set_fields: dict = {"modified_on": now_utc(), "modified_by": args.actor}
        unset: dict = {}
        for col, mongo_field in (("password_hash", "password_hash"),
                                 ("status", "status")):
            if r[col]:
                set_fields[mongo_field] = r[col]
            else:
                unset[mongo_field] = ""
        for col in ("password_changed_at", "activated_at"):
            dt = parse_dt(r[col])
            if dt:
                set_fields[col] = dt
            else:
                unset[col] = ""
        update: dict = {"$set": set_fields}
        if unset:
            update["$unset"] = unset
        await db["users"].update_one({"_id": uid}, update)
        restored += 1

    client.close()
    print(f"REVERTED — {restored} users restored from {args.backup}"
          + (f", {missing} no longer exist" if missing else ""))
    print("Sessions revoked during the clear are NOT restored (users log in again).")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--org-id", help="organisation _id whose employees are cleared")
    p.add_argument("--commit", action="store_true", help="write (default is a dry run)")
    p.add_argument("--revert", action="store_true", help="restore from the backup CSV")
    p.add_argument("--backup", default=DEFAULT_BACKUP, help="backup CSV path")
    p.add_argument("--include-inactive", action="store_true",
                   help="also clear non-active users (exited staff) — off by default")
    p.add_argument("--keep-status", action="store_true",
                   help="clear the password only; leave status/activated_at as-is "
                        "(users recover via Forgot Password, not activation)")
    p.add_argument("--clear-history", action="store_true",
                   help="also delete password_history rows so old passwords may be reused")
    p.add_argument("--actor", default="script:clear_employee_passwords",
                   help="value written to modified_by")
    args = p.parse_args()

    if args.revert:
        asyncio.run(run_revert(args))
        return
    if not args.org_id:
        p.error("--org-id is required (or use --revert)")
    asyncio.run(run_clear(args))


if __name__ == "__main__":
    main()
