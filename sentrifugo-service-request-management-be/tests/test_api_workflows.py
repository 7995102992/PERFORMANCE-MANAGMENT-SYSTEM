"""API tests for Workflow endpoints."""
from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio

from src.main import app
from src.models import (
    ApprovalLevel, Approver, Category, EscalationConfig, RequestType, Workflow,
)

from src.config import settings as _settings

# Derived from config so the suite follows whatever API_PREFIX the
# environment declares (empty locally, mounted under a gateway path in
# deployment) instead of asserting one hardcoded value.
PREFIX = _settings.API_PREFIX

# Ids come from the IAM stub fixtures — ObjectId-shaped, since every id crossing
# the API is typed PydanticObjectId.
from src.integrations.iam_client import (  # noqa: E402
    STUB_BU_MAIN_ID,
    STUB_DEPT_IT_ID,
    STUB_ORG_ID,
    STUB_USER_ADMIN_ID,
    STUB_USER_EMPLOYEE_ID,
    STUB_USER_MANAGER_ID,
)

DEV_SESSION = json.dumps({
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

# All four priorities: RequestTypeCreate._check_rules rejects a payload that
# doesn't cover low/medium/high/urgent with SLA_RULE_MISSING_PRIORITY.
VALID_SLA_RULES = [
    {"priority": "low", "first_response_minutes": 480, "resolution_minutes": 2880},
    {"priority": "medium", "first_response_minutes": 240, "resolution_minutes": 1440},
    {"priority": "high", "first_response_minutes": 60, "resolution_minutes": 480},
    {"priority": "urgent", "first_response_minutes": 15, "resolution_minutes": 120},
]


def _workflow_body(category_id: str, request_type_id: str) -> dict:
    return {
        "category_id": category_id,
        "request_type_id": request_type_id,
        "approval_required": True,
        "approval_levels": [
            {
                "level_index": 1,
                "logic": "and",
                "approvers": [
                    {"approver_user_id": STUB_USER_MANAGER_ID},
                ],
            },
        ],
        "escalation_config": {
            "auto_escalate_enabled": False,
        },
    }


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


@pytest_asyncio.fixture
async def cat_and_rt(client):
    cat = await client.post(f"{PREFIX}/categories", json={
        "name": "WF Test Category",
        "department_id": STUB_DEPT_IT_ID,
        "business_unit_id": STUB_BU_MAIN_ID,
    })
    cat_id = cat.json()["id"]

    rt = await client.post(f"{PREFIX}/request-types", json={
        "category_id": cat_id,
        "name": "WF Test Request Type",
        "sla_rules": VALID_SLA_RULES,
    })
    rt_id = rt.json()["id"]

    yield cat_id, rt_id

    # SLA rules are embedded in RequestType, so they go with it — SLARule is a
    # CustomModel and has no find_all() of its own.
    for model in [Approver, ApprovalLevel, EscalationConfig, Workflow, RequestType, Category]:
        await model.find_all().delete()


class TestCreateWorkflow:
    async def test_create_success(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        resp = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        assert resp.status_code == 201, resp.json()
        data = resp.json()
        assert data["category_id"] == cat_id
        assert data["request_type_id"] == rt_id
        assert data["approval_required"] is True
        assert len(data["approval_levels"]) == 1

    async def test_create_no_approval(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        resp = await client.post(f"{PREFIX}/workflows", json={
            "category_id": cat_id,
            "request_type_id": rt_id,
            "approval_required": False,
        })
        assert resp.status_code == 201
        assert resp.json()["approval_required"] is False

    @pytest.mark.xfail(
        reason="approval_required with zero levels currently returns 201 — "
        "open question 3 in design_docs/workflow-changes-06082026.md",
        strict=False,
    )
    async def test_create_missing_approvers(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        resp = await client.post(f"{PREFIX}/workflows", json={
            "category_id": cat_id,
            "request_type_id": rt_id,
            "approval_required": True,
            "approval_levels": [],
            "escalation_config": {"auto_escalate_enabled": False},
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "APPROVER_REQUIRED"

    async def test_create_levels_not_sequential(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        resp = await client.post(f"{PREFIX}/workflows", json={
            "category_id": cat_id,
            "request_type_id": rt_id,
            "approval_required": True,
            "approval_levels": [
                {"level_index": 1, "logic": "and", "approvers": [{"approver_user_id": STUB_USER_MANAGER_ID}]},
                {"level_index": 3, "logic": "and", "approvers": [{"approver_user_id": STUB_USER_EMPLOYEE_ID}]},
            ],
            "escalation_config": {"auto_escalate_enabled": False},
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "WORKFLOW_LEVELS_NOT_SEQUENTIAL"

    async def test_create_duplicate_approver_in_level(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        resp = await client.post(f"{PREFIX}/workflows", json={
            "category_id": cat_id,
            "request_type_id": rt_id,
            "approval_required": True,
            "approval_levels": [
                {"level_index": 1, "logic": "and", "approvers": [
                    {"approver_user_id": STUB_USER_MANAGER_ID},
                    {"approver_user_id": STUB_USER_MANAGER_ID},
                ]},
            ],
            "escalation_config": {"auto_escalate_enabled": False},
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "WORKFLOW_APPROVER_DUPLICATE_IN_LEVEL"


class TestListWorkflows:
    async def test_list(self, client, cat_and_rt):
        resp = await client.get(f"{PREFIX}/workflows")
        assert resp.status_code == 200
        assert "items" in resp.json()

    async def test_list_filter_by_category(self, client, cat_and_rt):
        cat_id, _ = cat_and_rt
        resp = await client.get(f"{PREFIX}/workflows", params={"category_id": cat_id})
        assert resp.status_code == 200

    async def test_list_filter_by_request_type(self, client, cat_and_rt):
        _, rt_id = cat_and_rt
        resp = await client.get(f"{PREFIX}/workflows", params={"request_type_id": rt_id})
        assert resp.status_code == 200


class TestGetWorkflow:
    async def test_get_success(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        create = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        wf_id = create.json()["id"]
        resp = await client.get(f"{PREFIX}/workflows/{wf_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == wf_id

    async def test_get_not_found(self, client, cat_and_rt):
        resp = await client.get(f"{PREFIX}/workflows/aaaaaaaaaaaaaaaaaaaaaaaa")
        assert resp.status_code == 404


class TestUpdateWorkflow:
    async def test_update(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        create = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        wf_id = create.json()["id"]
        updated_body = _workflow_body(cat_id, rt_id)
        updated_body["approval_levels"][0]["approvers"].append(
            {"approver_user_id": STUB_USER_EMPLOYEE_ID}
        )
        resp = await client.put(f"{PREFIX}/workflows/{wf_id}", json=updated_body)
        assert resp.status_code == 200


class TestDeleteWorkflow:
    async def test_delete_success(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        create = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        wf_id = create.json()["id"]
        # create_workflow saves ACTIVE, and delete_workflow refuses an active
        # workflow (WORKFLOW_ACTIVE_CANNOT_DELETE) — deactivate first, exactly
        # as the UI does.
        await client.post(f"{PREFIX}/workflows/{wf_id}/deactivate")
        resp = await client.delete(f"{PREFIX}/workflows/{wf_id}")
        assert resp.status_code == 204, resp.json()

    async def test_delete_active_is_blocked(self, client, cat_and_rt):
        """The 409 is the point: an active workflow is routing live tickets."""
        cat_id, rt_id = cat_and_rt
        create = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        wf_id = create.json()["id"]
        resp = await client.delete(f"{PREFIX}/workflows/{wf_id}")
        assert resp.status_code == 409
        assert resp.json()["code"] == "WORKFLOW_ACTIVE_CANNOT_DELETE"

    async def test_delete_not_found(self, client, cat_and_rt):
        resp = await client.delete(f"{PREFIX}/workflows/aaaaaaaaaaaaaaaaaaaaaaaa")
        assert resp.status_code == 404


class TestActivateDeactivate:
    async def test_activate(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        create = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        wf_id = create.json()["id"]
        resp = await client.post(f"{PREFIX}/workflows/{wf_id}/activate")
        assert resp.status_code == 200

    async def test_deactivate(self, client, cat_and_rt):
        cat_id, rt_id = cat_and_rt
        create = await client.post(f"{PREFIX}/workflows", json=_workflow_body(cat_id, rt_id))
        wf_id = create.json()["id"]
        await client.post(f"{PREFIX}/workflows/{wf_id}/activate")
        resp = await client.post(f"{PREFIX}/workflows/{wf_id}/deactivate")
        assert resp.status_code == 200


class TestPrimaryAssigneePreview:
    async def test_preview(self, client, cat_and_rt):
        _, rt_id = cat_and_rt
        resp = await client.get(f"{PREFIX}/request-types/{rt_id}/primary-assignee-preview")
        assert resp.status_code == 200
