"""Schema migrations applied automatically at startup.

Beanie creates the indexes a model declares but never removes the ones it stopped
declaring, so a renamed or re-keyed index survives a deploy and keeps enforcing the
old rule. That is what broke the employee-keyed reopen: the retired
``pso_project_period_unique`` index stayed behind, saw ``project_id: null`` on every
new row, and rejected the second grant of any month as a duplicate.

Each migration is:

* **idempotent** — safe to run against a database that already has it applied, since
  a fresh deploy and a redeploy take the same path;
* **either convergent or once-only** — an index drop states what the schema should
  look like and is re-checked every boot, because an instance still running older
  code recreates the shape Beanie's model declares and a ledger entry reading "done"
  would then stop us healing it. Data rewrites run once and are recorded;
* **guarded by a lock** — several instances start at once behind a load balancer, and
  exactly one of them should be doing this.

This module is only the runner. Every migration lives in ``scripts/`` as a
``migrate(db)`` function, which is exactly what its command line calls too — so a
migration behaves the same whether a deploy ran it or a person did, and there is
one place to read when asking what it does.

Destructive tools (``clear_project_timesheets``, ``mock/seed``) deliberately have no
``migrate`` entry point and are never reachable from here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from pymongo.errors import DuplicateKeyError, OperationFailure

logger = logging.getLogger(__name__)

LEDGER = "schema_migrations"
LOCK_ID = "__migration_lock__"
# Long enough for any migration here, short enough that a crashed instance does not
# block the next deploy for long.
LOCK_TTL = timedelta(minutes=5)


async def drop_index_if_present(db, collection: str, index_name: str) -> str:
    """Drop an index if it is there. Missing is success — that is the desired state.

    Shared with the ``scripts/`` entry points so a migration and its manual runner
    cannot disagree about what "already done" means.
    """
    try:
        await db[collection].drop_index(index_name)
        return f"dropped {collection}.{index_name}"
    except OperationFailure as exc:
        if exc.code == 27 or "index not found" in str(exc).lower():
            return f"{collection}.{index_name} already absent"
        raise


# ── migrations ────────────────────────────────────────────────────────────────
# Append only. Never edit or renumber an entry that has shipped: the name is what
# records it as done, so changing one makes it run again everywhere.
#
# Each entry points at the ``migrate(db)`` in its ``scripts/`` module — the same
# function the manual runner calls. One implementation, two ways to reach it, so a
# migration cannot behave differently depending on who started it.

# Runs on every boot. Dropping a retired index is a statement about what the schema
# should look like, not an event that happens once: Beanie recreates whatever indexes
# a model declares, so any instance still running older code puts the old shape back,
# and a ledger entry saying "done yesterday" then keeps us from healing it. Costs one
# `list_indexes` per collection and drops only when something is actually there.
CONVERGENT = "convergent"

# Runs once, then recorded. For migrations that rewrite data, where re-running is
# either wasteful or not obviously safe.
ONCE = "once"


def _registry() -> list[tuple[str, callable, str]]:
    """Imported lazily so a broken script cannot stop the app importing."""
    from scripts.backfill_task_project_owner import migrate as backfill_task_owner
    from scripts.migrate_cph_email_unique_per_client import migrate as cph_email_index
    from scripts.migrate_reopen_per_employee import migrate as reopen_per_employee
    from scripts.migrate_task_name_unique_per_project import migrate as task_name_index

    return [
        ("001_reopen_per_employee_indexes", reopen_per_employee, CONVERGENT),
        ("003_drop_org_wide_head_email_index", cph_email_index, CONVERGENT),
        ("004_drop_org_wide_task_name_index", task_name_index, CONVERGENT),
        ("005_backfill_task_project_owner", backfill_task_owner, ONCE),
    ]


# ── runner ────────────────────────────────────────────────────────────────────

async def _acquire_lock(db) -> bool:
    """One instance runs migrations; the rest carry on and serve traffic.

    The lock is a document with an expiry rather than a flag, so an instance that
    dies mid-migration does not wedge every future deploy.
    """
    now = datetime.now(timezone.utc)
    await db[LEDGER].delete_many({"_id": LOCK_ID, "expires_at": {"$lt": now}})
    try:
        await db[LEDGER].insert_one({"_id": LOCK_ID, "expires_at": now + LOCK_TTL})
        return True
    except DuplicateKeyError:
        return False


async def _release_lock(db) -> None:
    try:
        await db[LEDGER].delete_one({"_id": LOCK_ID})
    except Exception:
        logger.exception("migration lock release failed — it will expire on its own")


async def run_migrations(db) -> None:
    """Apply any migration this database has not recorded.

    Never raises. A migration failing is worth shouting about, but it must not stop
    the service booting: the alternative is a crash-loop that takes the API down for
    a problem that may affect one endpoint.
    """
    applied = set()
    try:
        applied = {d["_id"] async for d in db[LEDGER].find({}, {"_id": 1})}
    except Exception:
        logger.exception("migration ledger unreadable — skipping migrations")
        return

    try:
        migrations = _registry()
    except Exception:
        logger.exception("migration registry unavailable — skipping migrations")
        return

    # Convergent ones run regardless of the ledger; once-only ones only when unseen.
    pending = [
        (name, fn, kind) for name, fn, kind in migrations
        if kind == CONVERGENT or name not in applied
    ]
    if not pending:
        logger.info("migrations.up_to_date count=%d", len(migrations))
        return

    if not await _acquire_lock(db):
        logger.info("migrations.locked_by_another_instance pending=%d", len(pending))
        return

    try:
        for name, fn, kind in pending:
            try:
                outcome = await fn(db)
                await db[LEDGER].update_one(
                    {"_id": name},
                    {"$set": {"applied_on": datetime.now(timezone.utc),
                              "outcome": outcome, "kind": kind}},
                    upsert=True,
                )
                # A convergent migration runs every boot and usually finds nothing.
                # Only say so when it actually changed the schema, or the log fills
                # with a line per collection per start and stops being read.
                if kind == ONCE or "dropped" in outcome:
                    logger.info("migrations.applied name=%s outcome=%s", name, outcome)
                else:
                    logger.debug("migrations.noop name=%s outcome=%s", name, outcome)
            except Exception:
                # A once-only migration is recorded on success alone, so a fixed one
                # is retried next boot.
                logger.exception("migrations.failed name=%s — continuing startup", name)
    finally:
        await _release_lock(db)
