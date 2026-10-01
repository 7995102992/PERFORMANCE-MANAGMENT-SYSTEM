"""Background materializer for effective-dated pending employee changes.

_apply_due_pending_changes normally runs lazily on IAM read paths, which is
fine for IAM's own API — but two consumers see a deferred change only once it
is actually applied:

  - the Timesheet service reads the IAM `employees` collection directly, so a
    change that hasn't materialized is invisible to it regardless of events;
  - the Leave service only learns about a change from the employee.updated
    event published at apply time.

If nobody happens to read the employee in IAM on/after the effective date,
both would keep seeing the old value indefinitely. This task closes that gap:
it sweeps for due pending changes shortly after startup and then every hour,
applying them through the same _apply_due_pending_changes path (history,
account sync, event, audit log) the lazy reads use.
"""
import asyncio
from datetime import date

from src.logger import logger

_SWEEP_INTERVAL_SECONDS = 60 * 60  # hourly — catches the midnight rollover within an hour

_task: asyncio.Task | None = None


async def sweep_due_pending_changes() -> int:
    """Apply every employee's due pending changes. Returns employees updated."""
    from src.modules.organisation.models import EmployeeDocument
    from src.modules.organisation.employees.utils.tools import EmployeeTools

    tools = EmployeeTools()
    applied = 0
    due_filter = {
        "deleted_on": None,
        "pending_changes.effective_date": {"$lte": date.today()},
    }
    async for employee in EmployeeDocument.find(due_filter):
        try:
            if await tools._apply_due_pending_changes(employee):
                applied += 1
        except Exception as exc:
            # One bad record must not stall the rest of the sweep.
            logger.error(
                f"Failed to apply due pending changes for employee {employee.id}: {exc!r}"
            )
    if applied:
        logger.info(f"Pending-change sweep applied changes for {applied} employee(s)")
    return applied


async def _run_loop() -> None:
    # Small delay so startup (DB/RabbitMQ init) settles first.
    await asyncio.sleep(15)
    while True:
        try:
            await sweep_due_pending_changes()
        except Exception as exc:
            logger.error(f"Pending-change sweep failed: {exc!r}")
        await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)


def start_pending_changes_task() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_run_loop())


def stop_pending_changes_task() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None
