"""A stored value outside an enum must cost one field, not one query.

`Project.project_type` is typed as `ProjectTypeEnum`, and Beanie validates a
`find` as a unit — so four seeded projects holding `fixed_bid`, `retainer` and
`internal` did not lose four rows, they failed every `assigned-projects` call in
the organisation and emptied the expense form's project picker with it.

These pin both halves of the fix: reads survive a vocabulary they do not know,
and writes are as strict as they ever were.
"""
from __future__ import annotations

import logging

import pytest
from pydantic import BaseModel, ValidationError

from src.models import (
    BillableRateTypeEnum,
    LenientBillableRateType,
    LenientProjectStatus,
    LenientProjectType,
    ProjectStatusEnum,
    ProjectTypeEnum,
)
from src.projects.schemas import ProjectCreate, ProjectUpdate

_DOC_ID = "6a965f4f1f351c8ce7f90b51"


class _Row(BaseModel):
    """Stands in for the document, so the test needs no live collection."""

    id: str | None = None
    project_type: LenientProjectType = ProjectTypeEnum.TIME_AND_MATERIALS
    project_status: LenientProjectStatus = ProjectStatusEnum.ACTIVE
    billable_rate_type: LenientBillableRateType = None


class TestReadsSurviveUnknownValues:
    def test_the_three_values_that_caused_the_outage_now_load(self) -> None:
        assert _Row(project_type="fixed_bid").project_type is ProjectTypeEnum.TIME_AND_MATERIALS
        assert _Row(project_type="retainer").project_type is ProjectTypeEnum.TIME_AND_MATERIALS
        assert _Row(project_type="internal").project_type is ProjectTypeEnum.TIME_AND_MATERIALS

    def test_an_optional_field_falls_back_to_none(self) -> None:
        """`None` is how "we do not know" is already spelled there — no sentinel needed."""
        assert _Row(billable_rate_type="per_fortnight").billable_rate_type is None

    def test_a_known_value_is_untouched(self) -> None:
        """The fallback must not be reachable by anything the enum can parse."""
        row = _Row(project_type="fixed_fee", project_status="on_hold", billable_rate_type="per_day")
        assert row.project_type is ProjectTypeEnum.FIXED_FEE
        assert row.project_status is ProjectStatusEnum.ON_HOLD
        assert row.billable_rate_type is BillableRateTypeEnum.PER_DAY

    def test_an_already_coerced_member_passes_straight_through(self) -> None:
        """Documents are also validated on write, where the value is already an enum."""
        assert _Row(project_type=ProjectTypeEnum.NON_BILLABLE).project_type is ProjectTypeEnum.NON_BILLABLE

    def test_the_fallback_is_logged_with_the_document_id(self, caplog) -> None:
        """Silent leniency is just slower rot — somebody has to be able to find the row."""
        with caplog.at_level(logging.WARNING, logger="src.models"):
            _Row(id=_DOC_ID, project_type="retainer")
        assert len(caplog.records) == 1
        message = caplog.records[0].getMessage()
        assert "retainer" in message
        assert _DOC_ID in message


class TestWritesStayStrict:
    """The whole trade rests on the API validating through `schemas.py`, not the document.

    If a request body were ever validated against `Project` itself, leniency on
    read would quietly become leniency on write, and the API would start
    accepting — and storing — the very values this was added to tolerate.
    """

    def test_create_still_refuses_an_unknown_project_type(self) -> None:
        with pytest.raises(ValidationError) as caught:
            ProjectCreate(client_id="c", name="n", project_type="retainer")
        assert caught.value.errors()[0]["loc"] == ("project_type",)

    def test_update_still_refuses_an_unknown_project_type(self) -> None:
        with pytest.raises(ValidationError):
            ProjectUpdate(project_type="fixed_bid")
