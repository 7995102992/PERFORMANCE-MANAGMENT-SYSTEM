"""API tests for Request Types CRUD endpoints."""
from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio

from src.main import app
from src.models import Category, RequestType

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
    {
        "priority": "low",
        "first_response_minutes": 480,
        "resolution_minutes": 2880,
        "business_hours_only": True,
    },
    {
        "priority": "medium",
        "first_response_minutes": 240,
        "resolution_minutes": 1440,
        "business_hours_only": True,
    },
    {
        "priority": "high",
        "first_response_minutes": 60,
        "resolution_minutes": 480,
        "business_hours_only": True,
    },
    {
        "priority": "urgent",
        "first_response_minutes": 15,
        "resolution_minutes": 120,
        "business_hours_only": True,
    },
]


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
async def category_id(client):
    resp = await client.post(f"{PREFIX}/categories", json={
        "name": "RT Test Category",
        "department_id": STUB_DEPT_IT_ID,
        "business_unit_id": STUB_BU_MAIN_ID,
    })
    cid = resp.json()["id"]
    yield cid
    # find_all, not a filter on organisation_id — that field is stored as an
    # ObjectId, so a string filter matches nothing and leaves rows behind that
    # collide on the unique name index next run. Dedicated test database.
    await Category.find_all().delete()
    # SLA rules are embedded in RequestType, not a collection of their own —
    # deleting the request types takes them with it. (SLARule is a CustomModel,
    # so calling find_all() on it raises AttributeError in teardown.)
    await RequestType.find_all().delete()


class TestCreateRequestType:
    async def test_create_success(self, client, category_id):
        resp = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Laptop Issue",
            "description": "Hardware problems",
            "sla_rules": VALID_SLA_RULES,
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Laptop Issue"
        assert len(data["sla_rules"]) == 4

    async def test_create_missing_sla(self, client, category_id):
        resp = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "No SLA Type",
            "sla_rules": [],
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "SLA_RULE_EMPTY"

    async def test_create_duplicate_priority_in_sla(self, client, category_id):
        resp = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Dup Priority Type",
            "sla_rules": [
                {"priority": "low", "first_response_minutes": 60, "resolution_minutes": 480},
                {"priority": "low", "first_response_minutes": 30, "resolution_minutes": 240},
            ],
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "SLA_RULE_DUPLICATE_PRIORITY_IN_PAYLOAD"

    async def test_create_sla_invalid_times(self, client, category_id):
        resp = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Bad SLA Type",
            "sla_rules": [
                {"priority": "low", "first_response_minutes": 500, "resolution_minutes": 60},
            ],
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "SLA_RULE_INVALID_TIMES"

    async def test_create_duplicate_name(self, client, category_id):
        await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Duplicate RT Name",
            "sla_rules": VALID_SLA_RULES,
        })
        resp = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Duplicate RT Name",
            "sla_rules": VALID_SLA_RULES,
        })
        assert resp.status_code == 409


class TestListRequestTypes:
    async def test_list(self, client, category_id):
        resp = await client.get(f"{PREFIX}/request-types")
        assert resp.status_code == 200
        assert "items" in resp.json()

    async def test_list_with_category_filter(self, client, category_id):
        resp = await client.get(f"{PREFIX}/request-types", params={"category_id": category_id})
        assert resp.status_code == 200

    async def test_list_with_search(self, client, category_id):
        resp = await client.get(f"{PREFIX}/request-types", params={"q": "laptop"})
        assert resp.status_code == 200


class TestGetRequestType:
    async def test_get_success(self, client, category_id):
        create = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Get RT Test",
            "sla_rules": VALID_SLA_RULES,
        })
        rt_id = create.json()["id"]
        resp = await client.get(f"{PREFIX}/request-types/{rt_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == rt_id

    async def test_get_not_found(self, client, category_id):
        resp = await client.get(f"{PREFIX}/request-types/aaaaaaaaaaaaaaaaaaaaaaaa")
        assert resp.status_code == 404


class TestUpdateRequestType:
    async def test_update_name(self, client, category_id):
        create = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Update RT Test",
            "sla_rules": VALID_SLA_RULES,
        })
        rt_id = create.json()["id"]
        resp = await client.put(f"{PREFIX}/request-types/{rt_id}", json={
            "name": "Updated RT Name",
        })
        assert resp.status_code == 200
        assert resp.json()["name"] == "Updated RT Name"


class TestDeleteRequestType:
    async def test_delete_success(self, client, category_id):
        create = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "Delete RT Test",
            "sla_rules": VALID_SLA_RULES,
        })
        rt_id = create.json()["id"]
        resp = await client.delete(f"{PREFIX}/request-types/{rt_id}")
        assert resp.status_code == 204

    async def test_delete_not_found(self, client, category_id):
        resp = await client.delete(f"{PREFIX}/request-types/aaaaaaaaaaaaaaaaaaaaaaaa")
        assert resp.status_code == 404


class TestSLAPreview:
    async def test_sla_preview(self, client, category_id):
        create = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "SLA Preview RT",
            "sla_rules": VALID_SLA_RULES,
        })
        rt_id = create.json()["id"]
        resp = await client.get(f"{PREFIX}/request-types/{rt_id}/sla-preview", params={"priority": "low"})
        assert resp.status_code == 200
        data = resp.json()
        # Assert against the fixture, not literals — the two drifted apart once
        # already when VALID_SLA_RULES had to grow to all four priorities.
        low = next(r for r in VALID_SLA_RULES if r["priority"] == "low")
        assert data["first_response_minutes"] == low["first_response_minutes"]
        assert data["resolution_minutes"] == low["resolution_minutes"]

    async def test_sla_preview_unknown_priority(self, client, category_id):
        """A partial rule set can no longer exist — RequestTypeCreate rejects a
        payload that doesn't cover all four priorities, so the old "no matching
        rule" case is unreachable. What's left to check is an unknown priority
        on the query string."""
        create = await client.post(f"{PREFIX}/request-types", json={
            "category_id": category_id,
            "name": "SLA Preview NoMatch",
            "sla_rules": VALID_SLA_RULES,
        })
        rt_id = create.json()["id"]
        resp = await client.get(
            f"{PREFIX}/request-types/{rt_id}/sla-preview",
            params={"priority": "catastrophic"},
        )
        assert resp.status_code in (400, 422)


class TestActiveEndpoints:
    async def test_list_active_categories(self, client, category_id):
        resp = await client.get(f"{PREFIX}/categories/active")
        assert resp.status_code == 200
        assert "items" in resp.json()

    async def test_list_active_request_types_for_category(self, client, category_id):
        resp = await client.get(f"{PREFIX}/categories/{category_id}/request-types/active")
        assert resp.status_code == 200
        assert "items" in resp.json()
