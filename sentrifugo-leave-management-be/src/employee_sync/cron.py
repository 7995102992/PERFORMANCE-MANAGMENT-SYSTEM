"""
Employee replica reconciliation cron.

The ``employees`` collection is a replica maintained from IAM domain events.
A missed event (consumer downtime, retry exhaustion, changes made before this
service existed) leaves the replica stale forever — e.g. an employee who moved
teams keeps their old l1/l2_manager_id here and still appears in the old
manager's team surfaces. This cron heals that drift: it sweeps IAM's full
employee snapshot (Direct Reply-To RPC, cursor-paginated) and re-upserts the
hierarchy / status fields the leave module depends on. Other replica fields
(names, work_email, ...) are left untouched.

Production : daily at 2:30 AM IST (9 PM UTC).
Development: every 30 minutes.
On startup the sweep runs once immediately so a deploy heals existing drift.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from src.clients.iam_employees import fetch_employees_page
from src.config import settings
from src.database import get_db
from src.logger import logger
from src.messaging.consumers.domain_events_consumer import (
    _EMPLOYEE_OID_FIELDS,
    _convert_oids,
    safe_oid,
    to_oid,
)

_DEV_POLL_SECONDS = 30 * 60
# One RPC reply must fit comfortably in a broker frame; 200 rows keeps the
# payload small (the old HTTP page of 500 was ~310 KB). Also the page-exhausted
# check below, so the two can never disagree.
_PAGE_SIZE = 200

_IST = timezone(timedelta(hours=5, minutes=30))


def _seconds_until_230am_ist() -> float:
    now = datetime.now(_IST)
    target = now.replace(hour=2, minute=30, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _run_once() -> None:
    try:
        db = get_db()
        after_id: str | None = None
        synced = 0
        # Every employee id IAM reported this sweep, plus the highest one seen.
        # Both feed the deletion reconciliation after the loop.
        seen: set = set()
        max_seen = None

        while True:
            page = await fetch_employees_page(after_id=after_id, limit=_PAGE_SIZE)
            if page is None:
                # IAM unreachable — abort rather than mistake the outage for
                # the end of the collection; the next scheduled run retries.
                logger.warning("Employee sync sweep aborted: IAM unreachable", synced=synced)
                return
            if not page:
                break

            for row in page:
                employee_id = row.get("employee_id")
                if not employee_id:
                    continue
                fields = {k: v for k, v in row.items() if k != "employee_id"}
                # User-account lifecycle goes to the users replica, not the
                # employee doc — IAM never re-publishes status/deletion flips
                # for pre-existing users, so the sweep is what keeps it honest.
                user_status = fields.pop("user_status", None)
                user_is_deleted = fields.pop("user_is_deleted", None)
                # Same ObjectId coercion as the domain-events consumer so the
                # replica keeps a single type per field.
                _convert_oids(fields, _EMPLOYEE_OID_FIELDS)
                emp_oid = to_oid(employee_id)
                seen.add(emp_oid)
                if max_seen is None or emp_oid > max_seen:
                    max_seen = emp_oid
                await db["employees"].update_one(
                    {"_id": emp_oid},
                    {"$set": fields},
                    upsert=True,
                )
                raw_user_id = row.get("user_id")
                raw_org_id = row.get("organisation_id") or row.get("org_id")
                if raw_user_id:
                    user_set: dict = {}
                    if user_status is not None:
                        user_set["status"] = user_status
                    if user_is_deleted is not None:
                        user_set["is_deleted"] = user_is_deleted
                    if raw_org_id is not None:
                        user_set["organisation_id"] = safe_oid(raw_org_id)
                    # Identity travels with the snapshot now. Several read paths
                    # project these off the users replica, but no writer ever
                    # populated them, so team surfaces rendered raw ObjectIds.
                    for _user_field, _row_field in (
                        ("first_name", "first_name"),
                        ("last_name", "last_name"),
                        ("name", "name"),
                        ("email", "work_email"),
                    ):
                        if row.get(_row_field) is not None:
                            user_set[_user_field] = row[_row_field]
                    if user_set:
                        await db["users"].update_one(
                            {"_id": safe_oid(raw_user_id)},
                            {"$set": user_set},
                            upsert=True,
                        )
                synced += 1

            after_id = page[-1]["employee_id"]
            if len(page) < _PAGE_SIZE:
                break

        # Deletion reconciliation. The loop above only upserts, so an employee
        # that disappears from IAM entirely — hard-deleted, or a record dropped
        # before this service existed — would linger in the replica forever and
        # keep turning up in assignable-employee pools. IAM's snapshot includes
        # its OWN soft-deleted rows, so anything absent from a complete sweep
        # genuinely no longer exists upstream.
        #
        # Reached only after a full sweep: the `page is None` branch returns
        # early, so a broker hiccup can never be read as "IAM has no employees"
        # and empty the replica.
        removed = 0
        if max_seen is not None:
            local_ids = {
                d["_id"]
                async for d in db["employees"].find(
                    {"is_deleted": {"$ne": True}}, {"_id": 1}
                )
            }
            # Ignore anything above the cursor's high-water mark. An employee
            # created by a domain event mid-sweep sorts after the last id IAM
            # returned, so it was never in range — dropping it here would be a
            # race, and the next sweep picks it up anyway.
            stale = [oid for oid in local_ids - seen if oid <= max_seen]
            if stale:
                result = await db["employees"].update_many(
                    {"_id": {"$in": stale}}, {"$set": {"is_deleted": True}}
                )
                removed = result.modified_count
                # Soft-delete, not a drop: every read path already filters on
                # is_deleted, and LMS-native rows (plan / calendar assignments)
                # reference these ids.
                logger.info(
                    "Employee sync marked vanished employees deleted",
                    count=removed,
                )

        logger.info("Employee sync sweep complete", synced=synced, removed=removed)
    except Exception as exc:
        logger.error("Employee sync sweep failed", error=repr(exc))


async def run_employee_sync_cron() -> None:
    """Background task: periodically reconcile the employees replica with IAM."""
    is_dev = settings.ENVIRONMENT == "development"
    logger.info(
        "Employee sync cron started",
        mode="development" if is_dev else "production",
        poll_seconds=_DEV_POLL_SECONDS if is_dev else "daily-at-2:30am-ist",
    )
    await _run_once()
    while True:
        if is_dev:
            await asyncio.sleep(_DEV_POLL_SECONDS)
        else:
            wait = _seconds_until_230am_ist()
            logger.info("Employee sync cron: sleeping until 2:30 AM IST", seconds=int(wait))
            await asyncio.sleep(wait)
        await _run_once()
