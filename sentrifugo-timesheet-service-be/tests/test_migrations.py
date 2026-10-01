"""Startup migrations.

Beanie creates the indexes a model declares and never drops the ones it stopped
declaring, so a re-keyed index outlives the deploy that retired it and keeps
enforcing the old rule. These run once per database, on boot, to clear that up.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pymongo.errors import DuplicateKeyError, OperationFailure

from src.migrations import CONVERGENT, LEDGER, LOCK_ID, ONCE, _registry, run_migrations


def make_db(*, applied=(), lock_taken=False, collections=None):
    """A Mongo double: the ledger plus whatever collections a migration touches."""
    db = MagicMock()
    ledger = MagicMock()
    ledger.find = MagicMock(return_value=_cursor([{"_id": n} for n in applied]))
    ledger.delete_many = AsyncMock()
    ledger.delete_one = AsyncMock()
    ledger.insert_one = AsyncMock(
        side_effect=DuplicateKeyError("taken") if lock_taken else None)
    ledger.update_one = AsyncMock()
    db.__getitem__ = MagicMock(
        side_effect=lambda name: ledger if name == LEDGER else (collections or {}).get(
            name, _collection()))
    db._ledger = ledger
    return db


def _collection(drop_index=None):
    c = MagicMock()
    c.drop_index = drop_index or AsyncMock()
    return c


def _cursor(docs):
    class _C:
        def __aiter__(self):
            async def gen():
                for d in docs:
                    yield d
            return gen()
    return _C()


def recorded_names(db):
    """Migrations that ran — recorded via upsert, unlike the lock's insert."""
    return [c.args[0]["_id"] for c in db._ledger.update_one.call_args_list]


def stub_registry(*names, kind=ONCE, outcome=None):
    """A registry of no-op migrations — these tests are about the runner."""
    return lambda: [
        (n, AsyncMock(return_value=outcome or f"did {n}"), kind) for n in names
    ]


class TestRunner:
    @pytest.mark.asyncio
    async def test_a_fresh_database_applies_everything_in_order(self):
        db = make_db()
        with patch("src.migrations._registry", stub_registry("a", "b", "c")):
            await run_migrations(db)

        assert recorded_names(db) == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_only_the_unapplied_ones_run(self):
        db = make_db(applied=["a"])
        with patch("src.migrations._registry", stub_registry("a", "b")):
            await run_migrations(db)

        assert recorded_names(db) == ["b"]

    @pytest.mark.asyncio
    async def test_an_applied_migration_is_not_repeated(self):
        db = make_db(applied=["a", "b"])
        with patch("src.migrations._registry", stub_registry("a", "b")):
            await run_migrations(db)

        assert recorded_names(db) == []
        db._ledger.delete_many.assert_not_called()  # never even takes the lock

    @pytest.mark.asyncio
    async def test_a_convergent_migration_reruns_even_when_recorded(self):
        """The reported failure: the retired index was dropped, an instance running
        older code recreated it, and the ledger's "done" stopped us healing it. An
        index drop states what the schema should be, so it is re-checked every boot.
        """
        db = make_db(applied=["a"])
        with patch("src.migrations._registry", stub_registry("a", kind=CONVERGENT)):
            await run_migrations(db)

        assert recorded_names(db) == ["a"]

    @pytest.mark.asyncio
    async def test_a_once_only_migration_does_not(self):
        """Data rewrites stay ledger-gated — re-running one is not free."""
        db = make_db(applied=["a"])
        with patch("src.migrations._registry", stub_registry("a", kind=ONCE)):
            await run_migrations(db)

        assert recorded_names(db) == []

    @pytest.mark.asyncio
    async def test_index_migrations_are_registered_as_convergent(self):
        """Guards the classification itself: an index drop registered as once-only
        would reintroduce exactly the bug this fixes."""
        kinds = {name: kind for name, _fn, kind in _registry()}

        assert kinds["001_reopen_per_employee_indexes"] == CONVERGENT
        assert kinds["003_drop_org_wide_head_email_index"] == CONVERGENT
        assert kinds["004_drop_org_wide_task_name_index"] == CONVERGENT
        assert kinds["005_backfill_task_project_owner"] == ONCE

    def test_every_registered_migration_is_reachable(self):
        """Guards the seam: the registry names modules by import, so a renamed or
        moved script fails here rather than silently at the next deploy."""
        entries = _registry()

        assert entries, "registry is empty"
        assert all(callable(fn) for _name, fn, _kind in entries)
        assert all(k in (CONVERGENT, ONCE) for _n, _f, k in entries)
        assert len({name for name, _, _ in entries}) == len(entries), "duplicate names"

    @pytest.mark.asyncio
    async def test_only_one_instance_runs_them(self):
        """Several pods boot at once; the losers serve traffic instead of racing."""
        db = make_db(lock_taken=True)
        await run_migrations(db)

        assert recorded_names(db) == []

    @pytest.mark.asyncio
    async def test_a_failing_migration_does_not_stop_startup(self):
        """A crash-loop would take the whole API down for a one-endpoint problem."""
        db = make_db()
        with patch("src.migrations._registry", lambda:
                   [("x_boom", AsyncMock(side_effect=RuntimeError("nope")), ONCE)]):
            await run_migrations(db)

        assert recorded_names(db) == []

    @pytest.mark.asyncio
    async def test_a_failed_migration_is_retried_next_boot(self):
        """Recorded on success only, so fixing it is enough to have it run again."""
        db = make_db()
        with patch("src.migrations._registry", lambda:
                   [("x_boom", AsyncMock(side_effect=RuntimeError("nope")), ONCE)]):
            await run_migrations(db)

        assert "x_boom" not in recorded_names(db)

    @pytest.mark.asyncio
    async def test_the_lock_is_released_even_when_one_fails(self):
        db = make_db()
        with patch("src.migrations._registry", lambda:
                   [("x_boom", AsyncMock(side_effect=RuntimeError("nope")), ONCE)]):
            await run_migrations(db)

        db._ledger.delete_one.assert_awaited()

    @pytest.mark.asyncio
    async def test_an_unreadable_ledger_is_survivable(self):
        db = MagicMock()
        ledger = MagicMock()
        ledger.find = MagicMock(side_effect=RuntimeError("mongo down"))
        db.__getitem__ = MagicMock(return_value=ledger)

        await run_migrations(db)  # must not raise


class TestDropStaleIndex:
    @pytest.mark.asyncio
    async def test_it_drops_the_project_keyed_reopen_index(self):
        """The reported failure: E11000 on pso_project_period_unique with
        project_id null, blocking the second reopen of any month."""
        from scripts.migrate_reopen_per_employee import migrate

        drop = AsyncMock()
        db = MagicMock()
        db.__getitem__ = MagicMock(return_value=_collection(drop_index=drop))

        await migrate(db)

        assert [c.args[0] for c in drop.call_args_list] == [
            "pso_project_period_unique", "pso_user_period_unique"]

    @pytest.mark.asyncio
    async def test_an_absent_index_counts_as_success(self):
        """A fresh database never had it — the desired state either way."""
        from src.migrations import drop_index_if_present

        drop = AsyncMock(side_effect=OperationFailure("index not found with name", 27))
        db = MagicMock()
        db.__getitem__ = MagicMock(return_value=_collection(drop_index=drop))

        out = await drop_index_if_present(db, "past_submission_overrides", "pso_project_period_unique")

        assert "already absent" in out

    @pytest.mark.asyncio
    async def test_a_live_index_sharing_the_legacy_name_is_left_alone(self):
        """The current model declares a plain (org, email) lookup index, which Mongo
        auto-names exactly like the retired unique one. Dropping by name alone would
        delete it every boot, and Beanie would recreate it every boot.
        """
        from scripts.migrate_cph_email_unique_per_client import migrate

        drop = AsyncMock()
        col = _collection(drop_index=drop)
        col.list_indexes = MagicMock(return_value=_cursor([
            {"name": "organisation_id_1_email_1", "unique": False},
        ]))
        db = MagicMock()
        db.__getitem__ = MagicMock(return_value=col)

        out = await migrate(db)

        assert "organisation_id_1_email_1" not in [c.args[0] for c in drop.call_args_list]
        assert "not the unique legacy index" in out

    @pytest.mark.asyncio
    async def test_the_unique_legacy_index_is_still_dropped(self):
        from scripts.migrate_cph_email_unique_per_client import migrate

        drop = AsyncMock()
        col = _collection(drop_index=drop)
        col.list_indexes = MagicMock(return_value=_cursor([
            {"name": "organisation_id_1_email_1", "unique": True},
        ]))
        db = MagicMock()
        db.__getitem__ = MagicMock(return_value=col)

        await migrate(db)

        assert "organisation_id_1_email_1" in [c.args[0] for c in drop.call_args_list]

    @pytest.mark.asyncio
    async def test_a_real_failure_still_raises(self):
        """Only "not found" is benign; anything else must be recorded as a failure
        so the migration is retried rather than marked done."""
        from src.migrations import drop_index_if_present

        drop = AsyncMock(side_effect=OperationFailure("not authorized", 13))
        db = MagicMock()
        db.__getitem__ = MagicMock(return_value=_collection(drop_index=drop))

        with pytest.raises(OperationFailure):
            await drop_index_if_present(db, "past_submission_overrides", "pso_project_period_unique")
