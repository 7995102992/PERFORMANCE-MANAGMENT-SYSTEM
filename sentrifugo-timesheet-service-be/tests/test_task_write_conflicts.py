"""A unique-index violation on a task must read as a name clash, not a 500.

The application checks the name before writing, but the database has the final say:
a concurrent write, or an index that has not been migrated yet, still collides.
Beanie also disguises the failure — it re-raises a DuplicateKeyError from `save()`
as RevisionIdWasChanged, which has nothing to do with revisions.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from beanie.exceptions import RevisionIdWasChanged
from pymongo.errors import DuplicateKeyError

from src.exceptions import TaskNameExists
from src.tasks import service


def make_task(failure=None, *, on_insert=False):
    task = MagicMock()
    task.save = AsyncMock(side_effect=None if on_insert else failure)
    task.insert = AsyncMock(side_effect=failure if on_insert else None)
    return task


class TestPersistTask:
    @pytest.mark.asyncio
    async def test_a_clean_save_passes_through(self):
        task = make_task()
        await service._persist_task(task)
        task.save.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_a_clean_insert_passes_through(self):
        task = make_task(on_insert=True)
        await service._persist_task(task, insert=True)
        task.insert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_duplicate_on_insert_reads_as_a_name_clash(self):
        task = make_task(DuplicateKeyError("dup"), on_insert=True)

        with pytest.raises(TaskNameExists) as exc:
            await service._persist_task(task, insert=True)

        assert exc.value.status_code == 409

    @pytest.mark.asyncio
    async def test_beanies_revision_error_on_save_reads_as_a_name_clash(self):
        """`save()` never surfaces DuplicateKeyError — beanie swaps it for this."""
        task = make_task(RevisionIdWasChanged())

        with pytest.raises(TaskNameExists):
            await service._persist_task(task)

    @pytest.mark.asyncio
    async def test_duplicate_on_save_is_also_covered(self):
        task = make_task(DuplicateKeyError("dup"))

        with pytest.raises(TaskNameExists):
            await service._persist_task(task)

    @pytest.mark.asyncio
    async def test_other_failures_are_not_swallowed(self):
        task = make_task(RuntimeError("mongo is down"))

        with pytest.raises(RuntimeError):
            await service._persist_task(task)
