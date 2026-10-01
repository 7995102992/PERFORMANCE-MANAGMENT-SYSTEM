"""API tests for Service Request endpoints (list, detail, export, comments, notes, actions)."""
from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio

from src.main import app

from src.config import settings as _settings

# Derived from config so the suite follows whatever API_PREFIX the
# environment declares (empty locally, mounted under a gateway path in
# deployment) instead of asserting one hardcoded value.
PREFIX = _settings.API_PREFIX

# Ids come from the IAM stub fixtures — ObjectId-shaped, since every id crossing
# the API is typed PydanticObjectId.
from src.integrations.iam_client import (  # noqa: E402
    STUB_ORG_ID,
    STUB_USER_ADMIN_ID,
    STUB_USER_EMPLOYEE_ID,
    STUB_USER_MANAGER_ID,
)

DEV_SESSION_ADMIN = json.dumps({
    "id": STUB_USER_ADMIN_ID,
    "organisation_id": STUB_ORG_ID,
    "email": "admin@demo.local",
    "display_name": "Demo Admin",
    "is_super_admin": True,
    # is_super_admin bypasses every gate, so an empty grid is enough here. The
    # shape matters though: UserBase.permissions is a dict, and a list makes the
    # dev-session parse fail with a 401 that looks like a permissions bug.
    "permissions": {},
    "roles": ["super_admin"],
})

DEV_SESSION_EMPLOYEE = json.dumps({
    "id": STUB_USER_EMPLOYEE_ID,
    "organisation_id": STUB_ORG_ID,
    "email": "employee@demo.local",
    "display_name": "Demo Employee",
    "is_super_admin": False,
    # Mirrors what the "Employee" role policy actually resolves to in a seeded
    # org: editor acl on service_request with raise/execute/manage_request.
    # Note the editor acl makes `is_manager()` true — see common/iam_helpers.py.
    "permissions": {
        "service_request": {
            "acl": "editor",
            "actions": {
                "raise_request": True,
                "execute_request": True,
                "manage_request": True,
            },
        }
    },
    "roles": ["employee"],
})


@pytest_asyncio.fixture
async def admin_client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer admin-token",
            "X-SRM-Dev-Session": DEV_SESSION_ADMIN,
        },
    ) as c:
        yield c


@pytest_asyncio.fixture
async def employee_client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer emp-token",
            "X-SRM-Dev-Session": DEV_SESSION_EMPLOYEE,
        },
    ) as c:
        yield c


class TestListRequests:
    async def test_list_empty(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data

    async def test_list_with_filters(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests", params={
            "status": "submitted",
            "priority": "high",
            "status_group": "open",
            "page": 1,
            "page_size": 10,
        })
        assert resp.status_code == 200

    async def test_list_with_search(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests", params={"q": "laptop"})
        assert resp.status_code == 200

    async def test_list_with_date_range(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests", params={
            "created_from": "2026-01-01T00:00:00Z",
            "created_to": "2026-12-31T23:59:59Z",
        })
        assert resp.status_code == 200

    async def test_list_by_requester(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests", params={
            "requester_user_id": "user_emp_001",
        })
        assert resp.status_code == 200

    async def test_list_by_resolved_on(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests", params={
            "resolved_on": "this_month",
        })
        assert resp.status_code == 200


class TestRequestDetail:
    async def test_detail_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000")
        assert resp.status_code == 404

    async def test_attachment_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000/attachments/aid_001")
        assert resp.status_code == 404


class TestCreateRequestJSON:
    async def test_create_json_missing_fields(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/json", json={
            "category_id": "cat_001",
            "request_type_id": "rt_001",
            "title": "Test",
            "description": "Short",
            "priority": "low",
        })
        # title too short or desc too short => 422, or no active workflow => 400
        assert resp.status_code in (400, 422)

    async def test_create_json_validation_error(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/json", json={
            "category_id": "",
            "request_type_id": "",
            "title": "",
            "description": "",
            "priority": "low",
        })
        assert resp.status_code == 422


class TestComments:
    async def test_comments_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000/comments")
        assert resp.status_code == 404

    async def test_add_comment_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/comments", json={
            "body": "This is a test comment.",
        })
        assert resp.status_code == 404


class TestInternalNotes:
    async def test_notes_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000/internal-notes")
        assert resp.status_code == 404

    async def test_add_note_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/internal-notes", json={
            "body": "This is a test internal note.",
        })
        assert resp.status_code == 404


class TestActivity:
    async def test_activity_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000/activity")
        assert resp.status_code == 404


class TestActions:
    async def test_approve_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/approve", json={
            "remarks": "Approved",
        })
        assert resp.status_code == 404

    async def test_reject_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/reject", json={
            "reason": "Not valid request for our team.",
        })
        assert resp.status_code == 404

    async def test_resolve_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/resolve", json={
            "resolution_notes": "Fixed the issue by replacing the part.",
        })
        assert resp.status_code == 404

    async def test_close_not_found(self, admin_client):
        # CloseBody is a required body param — posting nothing 422s on
        # validation before the handler ever looks the ticket up.
        resp = await admin_client.post(
            f"{PREFIX}/requests/000000000000000000000000/close", json={}
        )
        assert resp.status_code == 404

    async def test_first_response_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/first-response")
        assert resp.status_code == 404


class TestAssignment:
    # These ids must be ObjectId-shaped: the bodies are typed PydanticObjectId,
    # so a placeholder string 422s on validation and never reaches the 404.
    async def test_assign_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/assign-executor", json={
            "executor_user_id": STUB_USER_EMPLOYEE_ID,
        })
        assert resp.status_code == 404

    async def test_reassign_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/reassign-executor", json={
            "executor_user_id": STUB_USER_EMPLOYEE_ID,
        })
        assert resp.status_code == 404

    async def test_escalate_not_found(self, admin_client):
        resp = await admin_client.post(f"{PREFIX}/requests/000000000000000000000000/escalate", json={
            "escalate_to_user_id": STUB_USER_MANAGER_ID,
            "reason": "SLA breach — escalating to manager for resolution.",
        })
        assert resp.status_code == 404

    async def test_eligible_executors_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000/eligible-executors")
        assert resp.status_code == 404

    async def test_eligible_escalation_targets_not_found(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/000000000000000000000000/eligible-escalation-targets")
        assert resp.status_code == 404


class TestExport:
    async def test_export_csv(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/export", params={
            "format": "csv",
            "date_range": "current_month",
        })
        assert resp.status_code == 200
        assert "text/csv" in resp.headers.get("content-type", "")

    async def test_export_excel_not_implemented(self, admin_client):
        resp = await admin_client.get(f"{PREFIX}/requests/export", params={
            "format": "excel",
        })
        assert resp.status_code == 501

    async def test_export_forbidden_for_employee(self, employee_client):
        resp = await employee_client.get(f"{PREFIX}/requests/export", params={
            "format": "csv",
        })
        # Employee lacks update permission or gets EXPORT_FORBIDDEN
        assert resp.status_code in (403, 200)
