"""Who may close a RESOLVED ticket — and specifically, who may not.

`close` (service_actions.py) is an allow-list of four branches, and until now a
requester was excluded from it only by accident: they were blocked when they
happened to satisfy none of the branches. Two of them are satisfied *by
construction* on a self-raised ticket:

  * `_is_category_primary` — a category with no roster (the default) falls back
    to the department head, who is an implicit primary (D3). A head raises into
    their own department's categories, so every head could close every ticket
    they raised. This is the case that was reported from DEV.
  * `_is_manager_of_ticket` — the org-wide editor/admin ACL intersected with
    the ticket's departments, likewise automatic for a manager raising into
    their own department.

Neither predicate distinguishes "manager of this ticket" from "the person who
asked for it", so the guard sits in front of both. These tests pin the guard
from both ends: the requester is refused, and everyone who legitimately closes
still can.

The stub IAM makes `STUB_USER_MANAGER_ID` the head of the IT department
(iam_client.py:655), which is exactly the reported shape.
"""
from __future__ import annotations

import itertools
import json

import httpx
import pytest_asyncio
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.main import app
from src.models import (
    Category,
    OrgSrConfig,
    PriorityEnum,
    RequestStatusEnum,
    ServiceRequest,
)

from src.integrations.iam_client import (  # noqa: E402
    STUB_BU_MAIN_ID,
    STUB_DEPT_IT_ID,
    STUB_ORG_ID,
    STUB_USER_ADMIN_ID,
    STUB_USER_EMPLOYEE2_ID,
    STUB_USER_EMPLOYEE_ID,
    STUB_USER_MANAGER_ID,
)

PREFIX = "/api/v1/service-requests"

_ticket_seq = itertools.count(1)

# Everything the close and detail endpoints gate on, so the ROUTER never
# decides these tests — only the service-layer branches under test do.
_ACTIONS = {
    "raise_request": True,
    "execute_request": True,
    "approve_request": True,
    "manage_request": True,
    "view_all_requests": True,
}


def _session(user_id: str, *, acl: str = "viewer", super_admin: bool = False) -> str:
    """`acl` drives `is_manager()` (iam_helpers.py:23) — viewer keeps the
    manager branch out of the way so a test can isolate the dept-head one."""
    return json.dumps({
        "id": user_id,
        "organisation_id": STUB_ORG_ID,
        "email": f"{user_id}@demo.local",
        "display_name": "Test User",
        "is_super_admin": super_admin,
        "permissions": {"service_request": {"acl": acl, "actions": _ACTIONS}},
        "roles": [],
        "department_id": STUB_DEPT_IT_ID,
    })


def _client(session: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer test-token",
            "X-SRM-Dev-Session": session,
        },
    )


@pytest_asyncio.fixture
async def category():
    """IT-owned, no roster — the default configuration, and the one that makes
    the department head an implicit primary."""
    await Category.get_motor_collection().delete_many({})
    cat = Category(
        organisation_id=PydanticObjectId(STUB_ORG_ID),
        name="Close Auth Cat",
        name_lc="close auth cat",
        business_unit_id=PydanticObjectId(STUB_BU_MAIN_ID),
        department_ids=[PydanticObjectId(STUB_DEPT_IT_ID)],
        department_id=PydanticObjectId(STUB_DEPT_IT_ID),
        executors=[],
    )
    await cat.insert()
    yield cat
    await Category.get_motor_collection().delete_many({})


async def _resolved_ticket(
    cat: Category, *, requester: str, executor: str
) -> ServiceRequest:
    now = utcnow()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=PydanticObjectId(STUB_ORG_ID),
        requester_user_id=PydanticObjectId(requester),
        category_id=cat.id,
        request_type_id=PydanticObjectId(),
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.MEDIUM,
        title="Resolved, awaiting close",
        request_status=RequestStatusEnum.RESOLVED,
        primary_assignee_user_id=PydanticObjectId(requester),
        executor_user_id=PydanticObjectId(executor),
        created_on=now,
        submitted_on=now,
        resolved_at=now,
    )
    await sr.insert()
    return sr


@pytest_asyncio.fixture(autouse=True)
async def _clean_tickets():
    await ServiceRequest.get_motor_collection().delete_many({})
    yield
    await ServiceRequest.get_motor_collection().delete_many({})


class TestRequesterCannotClose:
    """The reported DEV case: SR-2026-000105 / SR-2026-000104."""

    async def test_department_head_cannot_close_the_request_they_raised(
        self, category
    ):
        """Padma's case. `acl=viewer` deliberately: with the manager branch
        switched off, the ONLY thing that could admit her is the implicit-
        primary fallback to the department head — so this test fails if the
        guard is removed even when nobody holds a manager ACL.
        """
        sr = await _resolved_ticket(
            category,
            requester=STUB_USER_MANAGER_ID,   # head of IT in the stub
            executor=STUB_USER_EMPLOYEE_ID,   # somebody else resolved it
        )
        async with _client(_session(STUB_USER_MANAGER_ID, acl="viewer")) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/close", json={"closing_remarks": "close"}
            )
        assert resp.status_code == 403, resp.text
        assert resp.json()["code"] == "FORBIDDEN"

        after = await ServiceRequest.get(sr.id)
        assert after.request_status == RequestStatusEnum.RESOLVED
        assert after.closed_at is None

    async def test_manager_cannot_close_the_request_they_raised(self, category):
        """The other branch, isolated: an editor-ACL holder in the ticket's
        department who is NOT the department head."""
        sr = await _resolved_ticket(
            category,
            requester=STUB_USER_EMPLOYEE_ID,   # in IT, not its head
            executor=STUB_USER_EMPLOYEE2_ID,
        )
        async with _client(_session(STUB_USER_EMPLOYEE_ID, acl="editor")) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/close", json={"closing_remarks": "x"}
            )
        assert resp.status_code == 403, resp.text
        assert (await ServiceRequest.get(sr.id)).request_status == (
            RequestStatusEnum.RESOLVED
        )

    async def test_requester_who_is_also_the_executor_cannot_close(self, category):
        """Self-raised AND self-assigned, with `executor_can_close` on — the
        one remaining branch that would otherwise let a requester through."""
        await OrgSrConfig.get_motor_collection().delete_many({})
        await OrgSrConfig(
            organisation_id=PydanticObjectId(STUB_ORG_ID), executor_can_close=True
        ).insert()
        try:
            sr = await _resolved_ticket(
                category,
                requester=STUB_USER_EMPLOYEE_ID,
                executor=STUB_USER_EMPLOYEE_ID,
            )
            async with _client(_session(STUB_USER_EMPLOYEE_ID)) as c:
                resp = await c.post(
                    f"{PREFIX}/requests/{sr.id}/close", json={"closing_remarks": "x"}
                )
            assert resp.status_code == 403, resp.text
            assert (await ServiceRequest.get(sr.id)).request_status == (
                RequestStatusEnum.RESOLVED
            )
        finally:
            await OrgSrConfig.get_motor_collection().delete_many({})

    async def test_the_capability_hides_the_button_rather_than_403ing_it(
        self, category
    ):
        """`can_close` must move with `close`. If it doesn't, the requester
        still sees an enabled Close button and only learns it is refused after
        clicking — which is the behaviour that was reported."""
        sr = await _resolved_ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            executor=STUB_USER_EMPLOYEE_ID,
        )
        async with _client(_session(STUB_USER_MANAGER_ID, acl="viewer")) as c:
            resp = await c.get(f"{PREFIX}/requests/{sr.id}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["capabilities"]["can_close"] is False


class TestLegitimateClosersAreUnaffected:
    """The guard must not narrow anything except the requester."""

    async def test_department_head_can_close_someone_elses_request(self, category):
        sr = await _resolved_ticket(
            category,
            requester=STUB_USER_EMPLOYEE_ID,
            executor=STUB_USER_EMPLOYEE2_ID,
        )
        async with _client(_session(STUB_USER_MANAGER_ID, acl="viewer")) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/close", json={"closing_remarks": "done"}
            )
        assert resp.status_code == 200, resp.text
        after = await ServiceRequest.get(sr.id)
        assert after.request_status == RequestStatusEnum.CLOSED
        assert after.closed_at is not None

    async def test_the_capability_stays_true_for_that_closer(self, category):
        sr = await _resolved_ticket(
            category,
            requester=STUB_USER_EMPLOYEE_ID,
            executor=STUB_USER_EMPLOYEE2_ID,
        )
        async with _client(_session(STUB_USER_MANAGER_ID, acl="viewer")) as c:
            resp = await c.get(f"{PREFIX}/requests/{sr.id}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["capabilities"]["can_close"] is True

    async def test_super_admin_may_still_close_their_own_request(self, category):
        """Super admin bypasses this guard as it bypasses every other one —
        it is the break-glass path for a stuck ticket."""
        sr = await _resolved_ticket(
            category,
            requester=STUB_USER_ADMIN_ID,
            executor=STUB_USER_EMPLOYEE_ID,
        )
        async with _client(
            _session(STUB_USER_ADMIN_ID, super_admin=True)
        ) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/close", json={"closing_remarks": "admin"}
            )
        assert resp.status_code == 200, resp.text
        assert (await ServiceRequest.get(sr.id)).request_status == (
            RequestStatusEnum.CLOSED
        )
