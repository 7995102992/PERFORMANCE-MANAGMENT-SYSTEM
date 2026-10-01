"""Entry visibility for approvers must match week visibility.

A week reaches a manager's list when it has a TimesheetProjectApproval for a
project in their scope — and a task-level assignment puts the whole project in
that scope. Entry scoping has to use the same rule, or the manager gets a week
they can approve but whose entries render as "No entries for this week".
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.approvals.service import _scope_entries

_P1 = "507f1f77bcf86cd799439011"
_P2 = "507f1f77bcf86cd799439012"
_T_MINE = "507f1f77bcf86cd7994390a1"
_T_OTHER = "507f1f77bcf86cd7994390a2"


def make_entry(project_id, task_id, hours=8.0):
    return MagicMock(project_id=project_id, task_id=task_id, hours=hours)


class TestScopeEntries:
    def test_task_level_manager_sees_the_whole_project(self):
        """The reported bug: entries on a task the manager isn't assigned to."""
        entries = [make_entry(_P1, _T_MINE), make_entry(_P1, _T_OTHER)]

        visible = _scope_entries(entries, set(), {_P1: {_T_MINE}})

        assert len(visible) == 2

    def test_project_level_manager_sees_the_whole_project(self):
        entries = [make_entry(_P1, _T_MINE), make_entry(_P1, _T_OTHER)]

        visible = _scope_entries(entries, {_P1}, {})

        assert len(visible) == 2

    def test_other_projects_are_still_hidden(self):
        entries = [make_entry(_P1, _T_MINE), make_entry(_P2, _T_OTHER)]

        visible = _scope_entries(entries, {_P1}, {})

        assert [str(e.project_id) for e in visible] == [_P1]

    def test_no_scope_means_nothing_visible(self):
        assert _scope_entries([make_entry(_P1, _T_MINE)], set(), {}) == []

    def test_zero_hour_entries_are_kept(self):
        """No numeric filtering anywhere in the scope path."""
        entries = [make_entry(_P1, _T_MINE, hours=0.0), make_entry(_P1, _T_OTHER, hours=0)]

        visible = _scope_entries(entries, {_P1}, {})

        assert len(visible) == 2
