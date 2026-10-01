"""API tests for Dashboard, Health, and Internal Job endpoints."""
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
async def anon_client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as c:
        yield c


class TestHealth:
    async def test_healthz(self, anon_client):
        resp = await anon_client.get("/healthz")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["service"] == "srm"

    async def test_readyz(self, anon_client):
        resp = await anon_client.get("/readyz")
        assert resp.status_code == 200
        data = resp.json()
        assert "mongo" in data
        assert "rabbitmq" in data
        assert data["service"] == "srm"


class TestDashboard:
    async def test_summary(self, client):
        resp = await client.get(f"{PREFIX}/dashboard/summary")
        assert resp.status_code == 200

    async def test_summary_unauthenticated(self, anon_client):
        resp = await anon_client.get(f"{PREFIX}/dashboard/summary")
        assert resp.status_code in (401, 403)


class TestInternalJobs:
    async def test_sla_tick_with_valid_token(self, anon_client):
        resp = await anon_client.post(
            f"{PREFIX}/_internal/jobs/sla-tick",
            headers={"X-Internal-Token": "dev-internal-token"},
        )
        assert resp.status_code == 200

    async def test_sla_tick_invalid_token(self, anon_client):
        resp = await anon_client.post(
            f"{PREFIX}/_internal/jobs/sla-tick",
            headers={"X-Internal-Token": "wrong-token"},
        )
        assert resp.status_code == 401

    async def test_sla_tick_no_token(self, anon_client):
        resp = await anon_client.post(f"{PREFIX}/_internal/jobs/sla-tick")
        assert resp.status_code == 401

    async def test_rebuild_sla_cursor(self, anon_client):
        resp = await anon_client.post(
            f"{PREFIX}/_internal/jobs/rebuild-sla-cursor",
            headers={"X-Internal-Token": "dev-internal-token"},
        )
        assert resp.status_code == 200

    async def test_rebuild_sla_cursor_invalid_token(self, anon_client):
        resp = await anon_client.post(
            f"{PREFIX}/_internal/jobs/rebuild-sla-cursor",
            headers={"X-Internal-Token": "bad"},
        )
        assert resp.status_code == 401


class TestAuth:
    async def test_unauthenticated_access(self, anon_client):
        resp = await anon_client.get(f"{PREFIX}/categories")
        assert resp.status_code in (401, 403)

    async def test_missing_permission(self):
        no_perm_session = json.dumps({
            "id": "5f00000000000000000000ff",  # nobody — deliberately not a stub user
            "organisation_id": STUB_ORG_ID,
            "is_super_admin": False,
            "permissions": {},
            "roles": ["employee"],
        })
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            headers={
                "Authorization": "Bearer noperm-token",
                "X-SRM-Dev-Session": no_perm_session,
            },
        ) as c:
            resp = await c.post(f"{PREFIX}/categories", json={
                "name": "Should Fail",
                "department_id": "dept_001",
            })
            assert resp.status_code == 403
