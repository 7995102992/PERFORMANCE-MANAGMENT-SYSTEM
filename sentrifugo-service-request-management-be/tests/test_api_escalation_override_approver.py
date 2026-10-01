"""The Phase-B escalation override approver must be able to FIND the ticket.

`apply_escalation` (src/requests/utils/escalation.py) sets
`escalation_override_approver_user_id`, leaving `current_level_index`, the
status AND the level's approver snapshot untouched — it is a side transition.
`auth/utils/authorization.py:152` then grants that user approve/reject rights.

But the approvals queue matched only the snapshotted L1/L2 approvers, the legacy
Approver rows, and tickets already decided. The override approver matched none
of them, so they held a decision that appeared in no list at all —
`_scoped_filter` has no approver clause either. These tests pin the clause that
closes that, at both call sites (the queue and its xlsx export).

Note the override is ADDITIVE, not a replacement, despite what the docstring on
`require_current_approver` says: the displaced snapshot approver still satisfies
the `snapshot_uid == user.oid` branch at authorization.py:176 and can still
approve. The queue is asserted to match that — whoever may act, sees it — rather
than the docstring. Narrowing authorization to a true replacement is a product
decision, not a queue fix.
"""
from __future__ import annotations

import itertools
import json

import httpx
import pytest_asyncio
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.main import app
from src.models import PriorityEnum, RequestStatusEnum, ServiceRequest

PREFIX = "/api/v1/service-requests"

from src.integrations.iam_client import (  # noqa: E402
    STUB_ORG_ID,
    STUB_USER_EMPLOYEE_ID,
    STUB_USER_MANAGER_ID,
)

_ticket_seq = itertools.count(1)


def _session(user_id: str) -> str:
    """A NON-super-admin session: is_super_admin would bypass the scope entirely
    and the assertion would pass no matter what the clause looked like."""
    return json.dumps({
        "id": user_id,
        "organisation_id": STUB_ORG_ID,
        "email": "override@demo.local",
        "display_name": "Override Approver",
        "is_super_admin": False,
        "permissions": {
            "service_request": {
                "acl": "editor",
                "actions": {"approve_request": True, "raise_request": True},
            }
        },
        "roles": ["manager"],
    })


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer test-token",
            "X-SRM-Dev-Session": _session(STUB_USER_MANAGER_ID),
        },
    ) as c:
        yield c


@pytest_asyncio.fixture
async def escalated_ticket():
    """A PENDING_APPROVAL ticket whose level-1 approver has been overridden.

    Mirrors what apply_escalation leaves behind: the override is set, the level
    snapshot still names SOMEONE ELSE, and current_level_index is untouched.
    """
    await ServiceRequest.get_motor_collection().delete_many({})
    now = utcnow()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=PydanticObjectId(STUB_ORG_ID),
        requester_user_id=PydanticObjectId(),
        category_id=PydanticObjectId(),
        request_type_id=PydanticObjectId(),
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.HIGH,
        title="Escalated for approval",
        request_status=RequestStatusEnum.PENDING_APPROVAL,
        primary_assignee_user_id=PydanticObjectId(),
        current_level_index=1,
        # Deliberately NOT the caller: the override replaced them.
        level_1_approver_user_id=PydanticObjectId(STUB_USER_EMPLOYEE_ID),
        escalation_override_approver_user_id=PydanticObjectId(STUB_USER_MANAGER_ID),
        is_escalated=True,
        escalated_at=now,
        created_on=now,
        submitted_on=now,
    )
    await sr.insert()
    yield sr
    await ServiceRequest.get_motor_collection().delete_many({})


class TestOverrideApproverCanFindTheTicket:
    async def test_it_appears_in_pending_approvals(self, client, escalated_ticket):
        resp = await client.get(f"{PREFIX}/requests/pending-approvals")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert escalated_ticket.ticket_no in {
            i["ticket_no"] for i in body["items"]
        }, "the override approver can approve this ticket but could not see it"

    async def test_it_appears_in_the_xlsx_export(self, client, escalated_ticket):
        """The export builds its own copy of `or_clauses`; the gap was in both."""
        resp = await client.get(f"{PREFIX}/requests/approvals-export")
        assert resp.status_code == 200, resp.text
        # Cheap containment check: the ticket_no is a literal in the sheet's
        # shared-string table, which is deflated inside the xlsx zip — so read
        # it back through openpyxl rather than grepping the bytes.
        import io

        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(resp.content))
        cells = {
            str(c.value) for row in wb.active.iter_rows() for c in row if c.value
        }
        assert escalated_ticket.ticket_no in cells

    async def test_the_displaced_snapshot_approver_still_sees_it(
        self, escalated_ticket
    ):
        """The override ADDS an approver; it does not remove the snapshotted one.

        authorization.py:176 still lets the snapshot approver decide, so hiding
        the ticket from them would recreate the same can-act-but-cannot-find
        gap this clause exists to close, just for the other party.
        """
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            headers={
                "Authorization": "Bearer test-token",
                "X-SRM-Dev-Session": _session(STUB_USER_EMPLOYEE_ID),
            },
        ) as displaced:
            resp = await displaced.get(f"{PREFIX}/requests/pending-approvals")
            assert resp.status_code == 200, resp.text
            assert escalated_ticket.ticket_no in {
                i["ticket_no"] for i in resp.json()["items"]
            }

    async def test_a_stale_override_does_not_resurrect_a_finished_ticket(
        self, client, escalated_ticket
    ):
        """Why the clause is paired with `current_level_index: {$ne: None}`.

        The two fields are always cleared together (service_actions.py:113,
        :206, :696, :821 and service_assign.py:512). Should a write path ever
        clear the level and miss the override, matching the override alone
        would put a closed ticket back in someone's approvals queue forever.
        """
        escalated_ticket.current_level_index = None
        escalated_ticket.request_status = RequestStatusEnum.CLOSED
        await escalated_ticket.save()

        resp = await client.get(f"{PREFIX}/requests/pending-approvals")
        assert resp.status_code == 200, resp.text
        assert escalated_ticket.ticket_no not in {
            i["ticket_no"] for i in resp.json()["items"]
        }

    async def test_an_unrelated_approver_does_not_see_it(self, escalated_ticket):
        """No widening: the override is one user on one ticket, not a role."""
        stranger = str(PydanticObjectId())
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            headers={
                "Authorization": "Bearer test-token",
                "X-SRM-Dev-Session": _session(stranger),
            },
        ) as other:
            resp = await other.get(f"{PREFIX}/requests/pending-approvals")
            assert resp.status_code == 200, resp.text
            assert escalated_ticket.ticket_no not in {
                i["ticket_no"] for i in resp.json()["items"]
            }
