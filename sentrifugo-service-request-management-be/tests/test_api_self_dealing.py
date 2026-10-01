"""Nobody handles or approves their own request — at every door.

`assign_executor` has always enforced this on the executor it is handed. Three
sibling paths install a handler too and did not check:

  * `escalate` in the executor phase — `_eligible_escalation_targets` dropped
    only the caller, so the requester (an implicit primary of their own
    department's categories under D3) was an eligible target. Being escalated
    into executing your own ticket makes `resolve` reachable.
  * `escalate` in the APPROVAL phase — the target was validated for org
    membership and nothing else, then written to
    `escalation_override_approver_user_id`, which `_is_current_approver`
    (service_detail.py:143) and `require_current_approver`
    (auth/utils/authorization.py:152) both honour on its own. That is a
    requester approving their own request, and it is the worst of the three.
  * `reassign_executor` — no requester check at all.

Plus the SLA tick, which installs a handler from a fixed workflow target with
no acting user in the loop to notice.

These tests pin the target side (who may be installed) and the actor side (what
the requester may do once installed, which matters for tickets that reached
that state before the guards existed).
"""
from __future__ import annotations

import itertools
import json

import pytest_asyncio
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.main import app
from src.models import (
    Category,
    PriorityEnum,
    RequestStatusEnum,
    ServiceRequest,
)
from src.requests.utils.self_dealing import is_requester

import httpx

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

_ticket_seq = itertools.count(5000)

_ACTIONS = {
    "raise_request": True,
    "execute_request": True,
    "approve_request": True,
    "manage_request": True,
    "view_all_requests": True,
}


def _session(user_id: str, *, acl: str = "editor") -> str:
    return json.dumps({
        "id": user_id,
        "organisation_id": STUB_ORG_ID,
        "email": f"{user_id}@demo.local",
        "display_name": "Test User",
        "is_super_admin": False,
        "permissions": {"service_request": {"acl": acl, "actions": _ACTIONS}},
        "roles": [],
        "department_id": STUB_DEPT_IT_ID,
    })


def _client(user_id: str, **kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer test-token",
            "X-SRM-Dev-Session": _session(user_id, **kw),
        },
    )


@pytest_asyncio.fixture
async def category():
    await Category.get_motor_collection().delete_many({})
    cat = Category(
        organisation_id=PydanticObjectId(STUB_ORG_ID),
        name="Self Dealing Cat",
        name_lc="self dealing cat",
        business_unit_id=PydanticObjectId(STUB_BU_MAIN_ID),
        department_ids=[PydanticObjectId(STUB_DEPT_IT_ID)],
        department_id=PydanticObjectId(STUB_DEPT_IT_ID),
        executors=[],
    )
    await cat.insert()
    yield cat
    await Category.get_motor_collection().delete_many({})


@pytest_asyncio.fixture(autouse=True)
async def _clean():
    await ServiceRequest.get_motor_collection().delete_many({})
    yield
    await ServiceRequest.get_motor_collection().delete_many({})


async def _ticket(cat, *, requester, status, **over) -> ServiceRequest:
    now = utcnow()
    kw = dict(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=PydanticObjectId(STUB_ORG_ID),
        requester_user_id=PydanticObjectId(requester),
        category_id=cat.id,
        request_type_id=PydanticObjectId(),
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.MEDIUM,
        title="Self dealing probe",
        request_status=status,
        primary_assignee_user_id=PydanticObjectId(requester),
        created_on=now,
        submitted_on=now,
    )
    kw.update(over)
    sr = ServiceRequest(**kw)
    await sr.insert()
    return sr


class TestIsRequesterHelper:
    """The comparison this all rests on. A silent False here reopens every
    hole at once, and the callers pass three different id types."""

    async def test_matches_across_id_types(self, category):
        uid = STUB_USER_MANAGER_ID
        sr = await _ticket(
            category, requester=uid, status=RequestStatusEnum.ASSIGNED
        )
        assert is_requester(sr, uid) is True
        assert is_requester(sr, PydanticObjectId(uid)) is True
        assert is_requester(sr, sr.requester_user_id) is True
        assert is_requester(sr, STUB_USER_EMPLOYEE_ID) is False
        assert is_requester(sr, None) is False


class TestRequesterCannotBeInstalledAsHandler:
    async def test_reassign_to_the_requester_is_rejected(self, category):
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.ASSIGNED,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/reassign-executor",
                json={"executor_user_id": STUB_USER_MANAGER_ID},
            )
        assert resp.status_code == 403, resp.text
        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == PydanticObjectId(STUB_USER_EMPLOYEE_ID)

    async def test_approval_phase_escalation_to_the_requester_is_rejected(
        self, category
    ):
        """The worst of them: this field alone grants approve and reject."""
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.PENDING_APPROVAL,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
            current_level_index=1,
            level_1_approver_user_id=PydanticObjectId(STUB_USER_EMPLOYEE2_ID),
            approval_triggered_at=utcnow(),
        )
        async with _client(STUB_USER_EMPLOYEE_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/escalate",
                json={
                    "escalate_to_user_id": STUB_USER_MANAGER_ID,
                    "escalation_reason": "please look at this",
                },
            )
        assert resp.status_code >= 400, resp.text
        after = await ServiceRequest.get(sr.id)
        assert after.escalation_override_approver_user_id is None, (
            "the requester was installed as the approver of their own request"
        )

    async def test_executor_phase_escalation_to_the_requester_is_rejected(
        self, category
    ):
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.IN_PROGRESS,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
            first_response_at=utcnow(),
        )
        async with _client(STUB_USER_EMPLOYEE_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/escalate",
                json={
                    "escalate_to_user_id": STUB_USER_MANAGER_ID,
                    "escalation_reason": "over to you",
                },
            )
        assert resp.status_code >= 400, resp.text
        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == PydanticObjectId(STUB_USER_EMPLOYEE_ID)

    async def test_the_requester_is_not_offered_as_an_escalation_target(
        self, category
    ):
        """Dropdown hygiene — nobody should be shown a choice that 400s.
        The requester is the IT department head in the stub, so without the
        discard they would be listed as an implicit primary (D3)."""
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.IN_PROGRESS,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
            first_response_at=utcnow(),
        )
        async with _client(STUB_USER_EMPLOYEE_ID) as c:
            resp = await c.get(
                f"{PREFIX}/requests/{sr.id}/eligible-escalation-targets"
            )
        if resp.status_code == 404:
            import pytest

            pytest.skip("no eligible-escalation-targets endpoint in this build")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rows = body if isinstance(body, list) else body.get("items", [])
        assert STUB_USER_MANAGER_ID not in {str(r.get("user_id")) for r in rows}


class TestRequesterCannotActAsHandler:
    """Defence in depth for tickets that reached this state before the
    target-side guards existed — the executor IS the requester here."""

    async def test_first_response_is_rejected(self, category):
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.ASSIGNED,
            executor_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(f"{PREFIX}/requests/{sr.id}/first-response")
        assert resp.status_code == 403, resp.text
        assert (await ServiceRequest.get(sr.id)).first_response_at is None

    async def test_resolve_is_rejected(self, category):
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.IN_PROGRESS,
            executor_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
            first_response_at=utcnow(),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/resolve",
                json={"resolution_notes": "did it myself"},
            )
        assert resp.status_code == 403, resp.text
        assert (await ServiceRequest.get(sr.id)).request_status == (
            RequestStatusEnum.IN_PROGRESS
        )

    async def test_submit_for_approval_is_rejected(self, category):
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.IN_PROGRESS,
            executor_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
            first_response_at=utcnow(),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(f"{PREFIX}/requests/{sr.id}/submit-for-approval")
        assert resp.status_code == 403, resp.text
        assert (await ServiceRequest.get(sr.id)).current_level_index is None

    async def test_the_requester_cannot_assign_their_own_ticket(self, category):
        """A primary who raises a ticket does not get to route it.

        `_ticket` makes the requester the `primary_assignee_user_id`, which is
        the reported case exactly: a category primary raised a ticket and still
        held Assign on it.
        """
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.PENDING_ASSIGNMENT,
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/assign-executor",
                json={"executor_user_id": STUB_USER_EMPLOYEE_ID},
            )
        assert resp.status_code == 403, resp.text
        assert (await ServiceRequest.get(sr.id)).executor_user_id is None
        async with _client(STUB_USER_MANAGER_ID) as c:
            caps = (await c.get(f"{PREFIX}/requests/{sr.id}")).json()["capabilities"]
        assert caps["can_assign_executor"] is False
        # Self-assign was already closed to the requester; assert it here too so
        # a future widening of one flag can't quietly reopen the other door.
        assert caps["can_self_assign"] is False

    async def test_the_requester_cannot_reassign_their_own_ticket(self, category):
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.ASSIGNED,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/reassign-executor",
                json={"executor_user_id": STUB_USER_EMPLOYEE2_ID},
            )
        assert resp.status_code == 403, resp.text
        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == PydanticObjectId(STUB_USER_EMPLOYEE_ID)
        async with _client(STUB_USER_MANAGER_ID) as c:
            caps = (await c.get(f"{PREFIX}/requests/{sr.id}")).json()["capabilities"]
        assert caps["can_reassign_executor"] is False

    async def test_the_requester_is_not_offered_the_executor_picker(self, category):
        """The picker mirrors the two write endpoints, so it refuses too."""
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.PENDING_ASSIGNMENT,
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.get(f"{PREFIX}/requests/{sr.id}/eligible-executors")
        assert resp.status_code == 403, resp.text

    async def test_the_capabilities_agree_with_all_of_that(self, category):
        """A flag left true here is a button that 403s on click."""
        sr = await _ticket(
            category,
            requester=STUB_USER_MANAGER_ID,
            status=RequestStatusEnum.IN_PROGRESS,
            executor_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
            first_response_at=utcnow(),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.get(f"{PREFIX}/requests/{sr.id}")
        assert resp.status_code == 200, resp.text
        caps = resp.json()["capabilities"]
        assert caps["can_resolve"] is False
        assert caps["can_submit_for_approval"] is False
        assert caps["can_trigger_l2_approval"] is False


class TestTheExecutorPickerNeverOffersTheCaller:
    """Sibling of the rule above, and the same failure it exists to prevent.

    Not self-dealing — the caller here is a primary routing someone else's
    ticket — but it lands in this file because it is the picker half of
    "the dropdown must never offer a choice the endpoint refuses", which is what
    every test above is really about.
    """

    async def test_a_primary_does_not_see_themselves(self, category):
        from src.models import CategoryExecutor, ExecutorRoleEnum

        # Two primaries and a secondary — the reported roster shape.
        category.executors = [
            CategoryExecutor(
                user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
                role=ExecutorRoleEnum.PRIMARY,
                name="Primary One",
            ),
            CategoryExecutor(
                user_id=PydanticObjectId(STUB_USER_EMPLOYEE2_ID),
                role=ExecutorRoleEnum.PRIMARY,
                name="Primary Two",
            ),
            CategoryExecutor(
                user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
                role=ExecutorRoleEnum.SECONDARY,
                name="Secondary",
            ),
        ]
        await category.save()
        sr = await _ticket(
            category,
            requester=STUB_USER_ADMIN_ID,
            status=RequestStatusEnum.ASSIGNED,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
            primary_assignee_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.get(f"{PREFIX}/requests/{sr.id}/eligible-executors")
        assert resp.status_code == 200, resp.text
        offered = {row["user_id"] for row in resp.json()["items"]}
        # The caller, and the executor who already holds it.
        assert STUB_USER_MANAGER_ID not in offered
        assert STUB_USER_EMPLOYEE_ID not in offered
        # The other primary is still a valid target — the exclusion is of the
        # caller, not of primaries.
        assert STUB_USER_EMPLOYEE2_ID in offered


class TestHandlersWhoAreNotTheRequesterAreUnaffected:
    async def test_a_normal_executor_can_still_resolve(self, category):
        sr = await _ticket(
            category,
            requester=STUB_USER_EMPLOYEE2_ID,
            status=RequestStatusEnum.IN_PROGRESS,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
            first_response_at=utcnow(),
        )
        async with _client(STUB_USER_EMPLOYEE_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/resolve",
                json={"resolution_notes": "fixed"},
            )
        assert resp.status_code == 200, resp.text
        assert (await ServiceRequest.get(sr.id)).request_status == (
            RequestStatusEnum.RESOLVED
        )

    async def test_reassign_to_a_third_party_still_works(self, category):
        """The router here is NOT the requester — which is the whole point.

        This used to have the requester doing the reassigning, back when the
        actor rule was withheld from assign / reassign. It is the same scenario
        as `test_the_requester_cannot_reassign_their_own_ticket` below with only
        the caller changed, so keeping both is what pins the rule to *who is
        acting* rather than to the endpoint.
        """
        sr = await _ticket(
            category,
            # Four distinct people, because the scenario needs four roles:
            # requester, the primary doing the routing, the current executor and
            # the new one. The requester is the admin stub purely because the
            # other three are spoken for.
            requester=STUB_USER_ADMIN_ID,
            status=RequestStatusEnum.ASSIGNED,
            executor_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
            primary_assignee_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
        )
        async with _client(STUB_USER_MANAGER_ID) as c:
            resp = await c.post(
                f"{PREFIX}/requests/{sr.id}/reassign-executor",
                json={"executor_user_id": STUB_USER_EMPLOYEE2_ID},
            )
        assert resp.status_code == 200, resp.text
        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == PydanticObjectId(STUB_USER_EMPLOYEE2_ID)
