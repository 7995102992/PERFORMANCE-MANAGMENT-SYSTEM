"""Soft-deleted tickets must not leak into the scoped views.

`_scoped_filter` (src/requests/service_list.py) feeds three endpoints — the
ticket list, the dashboard summary and the CSV export. Only the `my_requests`
branch of the list pinned `deleted_on: None`, so a soft-deleted ticket would
have been listed, counted in `total` and in the dashboard cards, and written
into the export. Nothing writes `ServiceRequest.deleted_on` today, which is why
this went unnoticed — these tests set it directly so the guard is enforced
before a delete endpoint or an out-of-band migration starts producing such rows.

The dashboard is asserted at `_scoped_filter` rather than over HTTP on purpose:
`dashboard_summary` caches its payload in Valkey for 60s, and this environment
shares a Valkey database, so an HTTP assertion would be both flaky and polluting.
"""
from __future__ import annotations

import itertools
import json
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.main import app
from src.models import PriorityEnum, RequestStatusEnum, ServiceRequest
from src.requests.service_list import _scoped_filter

PREFIX = "/api/v1/service-requests"

from src.integrations.iam_client import (  # noqa: E402
    STUB_ORG_ID,
    STUB_USER_ADMIN_ID,
)

_ticket_seq = itertools.count(1)

# Super admin: `_scoped_filter` returns early for this role, so it exercises the
# org-pin-only branch — the one that carried no deleted_on clause at all.
DEV_SESSION = json.dumps({
    "id": STUB_USER_ADMIN_ID,
    "organisation_id": STUB_ORG_ID,
    "email": "admin@demo.local",
    "display_name": "Demo Admin",
    "is_super_admin": True,
    "permissions": {},
    "roles": ["super_admin"],
})


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer test-token",
            "X-SRM-Dev-Session": DEV_SESSION,
        },
    ) as c:
        yield c


async def _make_ticket(*, deleted: bool) -> ServiceRequest:
    now = utcnow()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=PydanticObjectId(STUB_ORG_ID),
        requester_user_id=PydanticObjectId(),
        category_id=PydanticObjectId(),
        request_type_id=PydanticObjectId(),
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.HIGH,
        title="Soft delete probe",
        request_status=RequestStatusEnum.ASSIGNED,
        primary_assignee_user_id=PydanticObjectId(),
        executor_user_id=PydanticObjectId(),
        created_on=now,
        # The CSV export filters on submitted_on within a date range, so a
        # ticket without it is invisible there for reasons unrelated to soft
        # deletion — which would make that assertion vacuously pass.
        submitted_on=now,
        deleted_on=now if deleted else None,
    )
    await sr.insert()
    return sr


@pytest_asyncio.fixture
async def tickets():
    # Clear first as well as last: the assertions below count rows, and a
    # leftover from another module would make `total` wrong for reasons that
    # have nothing to do with soft deletion. Dedicated test database.
    await ServiceRequest.get_motor_collection().delete_many({})
    live = await _make_ticket(deleted=False)
    gone = await _make_ticket(deleted=True)
    yield live, gone
    await ServiceRequest.get_motor_collection().delete_many({})


def _user(**overrides) -> SimpleNamespace:
    """Minimal UserBase stand-in for the filter-shape assertions."""
    base = dict(
        id=STUB_USER_ADMIN_ID,
        oid=PydanticObjectId(STUB_USER_ADMIN_ID),
        organisation_id=STUB_ORG_ID,
        org_oid=PydanticObjectId(STUB_ORG_ID),
        is_super_admin=False,
        is_org_admin=False,
        department_id=None,
        access_token=None,
        permissions={},
        roles=[],
        has_permission=lambda *_a, **_k: False,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class TestScopedFilterPinsDeletedOn:
    """Every role, because the clause has to survive each early return."""

    async def test_super_admin_branch(self):
        filt = await _scoped_filter(_user(is_super_admin=True))
        assert filt["deleted_on"] is None

    async def test_manager_branch(self):
        filt = await _scoped_filter(
            _user(permissions={"service_request": {"acl": "editor", "actions": {}}})
        )
        assert filt["deleted_on"] is None
        assert "$or" in filt, "sanity: this must be the manager branch"

    async def test_employee_branch(self):
        filt = await _scoped_filter(_user())
        assert filt["deleted_on"] is None
        assert "$or" in filt


class TestSoftDeletedTicketsAreScopedOut:
    async def test_list_excludes_and_does_not_count_it(self, client, tickets):
        live, gone = tickets
        resp = await client.get(f"{PREFIX}/requests", params={"page_size": 100})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        ticket_nos = {i["ticket_no"] for i in body["items"]}
        assert live.ticket_no in ticket_nos
        assert gone.ticket_no not in ticket_nos
        # `total` drives pagination — a phantom row there yields an empty page.
        assert body["total"] == 1, body["total"]

    async def test_export_excludes_it(self, client, tickets):
        live, gone = tickets
        resp = await client.get(f"{PREFIX}/requests/export")
        assert resp.status_code == 200, resp.text
        text = resp.content.decode("utf-8", errors="replace")
        assert live.ticket_no in text
        assert gone.ticket_no not in text
