"""Tests for correlation ID middleware and propagation.

Covers:
  - Middleware generates a UUID when no header is sent
  - Middleware echoes back a client-provided correlation ID
  - Correlation ID appears in error response bodies (domain + unhandled)
  - Correlation ID is stamped on user documents during create/update/delete
  - Correlation ID is stamped on org documents during create/update
  - Correlation ID is included in outbox event payloads
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.correlation import HEADER_NAME
from tests.conftest import (
    TEST_USER_DOC,
    TEST_USER_EMAIL,
    TEST_USER_FIRST_NAME,
    TEST_USER_ID,
    TEST_USER_LAST_NAME,
)


def _auth_patch(is_super_admin=True):
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(
            id=TEST_USER_ID,
            email=TEST_USER_EMAIL,
            first_name=TEST_USER_FIRST_NAME,
            last_name=TEST_USER_LAST_NAME,
            is_super_admin=is_super_admin,
        ),
    )


# ---------------------------------------------------------------------------
# Middleware — header generation and echo
# ---------------------------------------------------------------------------
class TestCorrelationIdMiddleware:
    @pytest.mark.asyncio
    async def test_generates_correlation_id_when_absent(self, client: AsyncClient):
        response = await client.get("/health")
        cid = response.headers.get(HEADER_NAME)
        assert cid is not None
        assert len(cid) == 36  # UUID format

    @pytest.mark.asyncio
    async def test_echoes_client_provided_correlation_id(self, client: AsyncClient):
        custom_cid = "my-trace-id-12345"
        response = await client.get("/health", headers={HEADER_NAME: custom_cid})
        assert response.headers.get(HEADER_NAME) == custom_cid

    @pytest.mark.asyncio
    async def test_different_requests_get_different_ids(self, client: AsyncClient):
        r1 = await client.get("/health")
        r2 = await client.get("/health")
        assert r1.headers.get(HEADER_NAME) != r2.headers.get(HEADER_NAME)


# ---------------------------------------------------------------------------
# Error responses include correlation_id
# ---------------------------------------------------------------------------
class TestCorrelationIdInErrorResponses:
    @pytest.mark.asyncio
    async def test_domain_error_includes_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        with _auth_patch(), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock,
            return_value=None,
        ):
            response = await client.get(
                f"/users/{str(uuid4())}",
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert response.status_code == 404
        body = response.json()
        assert body.get("correlation_id") == custom_cid

    @pytest.mark.asyncio
    async def test_error_response_has_correlation_id_even_without_header(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _auth_patch(), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock,
            return_value=None,
        ):
            response = await client.get(
                f"/users/{str(uuid4())}",
                headers=auth_headers,
            )

        assert response.status_code == 404
        body = response.json()
        assert "correlation_id" in body
        assert len(body["correlation_id"]) == 36


# ---------------------------------------------------------------------------
# User CRUD stamps correlation_id on documents
# ---------------------------------------------------------------------------
class TestCorrelationIdOnUserCrud:
    @pytest.mark.asyncio
    async def test_create_user_stamps_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        captured = {}

        async def capture_create(doc):
            captured.update(doc)
            return {**doc, "id": "new-user-id", "display_name": "New User"}

        with _auth_patch(), patch(
            "src.users.service.repository.get_user_by_email",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "src.users.service.repository.create_user",
            side_effect=capture_create,
        ), patch(
            "src.users.service.send_activation_email",
            new_callable=AsyncMock,
        ), patch(
            "src.rabbitmq.outbox.publish",
            new_callable=AsyncMock,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            await client.post(
                "/users",
                json={
                    "email": "new@example.com",
                    "password": "Secure@123",
                    "auth_method": "local",
                    "first_name": "New",
                    "last_name": "User",
                },
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert captured.get("correlation_id") == custom_cid

    @pytest.mark.asyncio
    async def test_update_user_stamps_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        captured = {}

        async def capture_update(uid, fields):
            captured.update(fields)
            return {**TEST_USER_DOC, **fields}

        with _auth_patch(), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock,
            return_value=TEST_USER_DOC,
        ), patch(
            "src.users.service.repository.update_user",
            side_effect=capture_update,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            await client.put(
                f"/users/{TEST_USER_ID}",
                json={"first_name": "Updated"},
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert captured.get("correlation_id") == custom_cid

    @pytest.mark.asyncio
    async def test_delete_user_stamps_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        captured = {}

        async def capture_update(uid, fields):
            captured.update(fields)
            return {**TEST_USER_DOC, **fields}

        with _auth_patch(), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock,
            return_value=TEST_USER_DOC,
        ), patch(
            "src.users.service.repository.update_user",
            side_effect=capture_update,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            await client.delete(
                f"/users/{TEST_USER_ID}",
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert captured.get("correlation_id") == custom_cid


# ---------------------------------------------------------------------------
# Org CRUD stamps correlation_id on documents and outbox payloads
# ---------------------------------------------------------------------------
class TestCorrelationIdOnOrgCrud:
    def _sample_org_doc(self, **overrides) -> dict:
        now = datetime.now(timezone.utc)
        base = {
            "id": "org-1",
            "legal_name": "Acme Corp",
            "address_id": None,
            "date_of_incorporation": None,
            "financial_year": "calendar",
            "currency": None,
            "timezone": None,
            "logo_asset_id": None,
            "is_multiple_business_units": False,
            "custom_fields": None,
            "is_active": True,
            "enabled_modules": ["core_hr"],
            "setup_status": "pending",
            "created_by": None,
            "created_on": now,
            "modified_by": None,
            "modified_on": now,
            "deleted_by": None,
            "deleted_on": None,
            "correlation_id": None,
        }
        base.update(overrides)
        return base

    def _sample_admin_doc(self, **overrides) -> dict:
        now = datetime.now(timezone.utc)
        base = {
            "id": "admin-1",
            "email": "jane@acme.com",
            "password_hash": None,
            "auth_method": "local",
            "azure_oid": None,
            "first_name": "Jane",
            "last_name": "Doe",
            "phone": "555-0100",
            "avatar_url": None,
            "status": "inactive",
            "last_login_at": None,
            "password_changed_at": None,
            "is_super_admin": False,
            "is_org_admin": True,
            "organisation_id": "org-1",
            "created_by": None,
            "created_on": now,
            "modified_by": None,
            "modified_on": now,
            "deleted_by": None,
            "deleted_on": None,
            "correlation_id": None,
        }
        base.update(overrides)
        return base

    @pytest.mark.asyncio
    async def test_create_org_stamps_correlation_id_on_doc_and_payload(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        org_captured = {}
        admin_captured = {}
        outbox_captured = {}

        async def capture_org_create(doc):
            org_captured.update(doc)
            return {**doc, "id": "org-new"}

        async def capture_admin_create(doc):
            admin_captured.update(doc)
            return {**doc, "id": "admin-new"}

        original_publish = AsyncMock()

        async def capture_publish(event_type, payload, *, idempotency_key, exchange=None):
            if event_type == "organisation.created":
                outbox_captured.update(payload)
            return "evt-id"

        with _auth_patch(), patch(
            "src.tenancy.service.org_repo.get_organisation_by_legal_name",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "src.tenancy.service.user_repo.get_user_by_email",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "src.tenancy.service.org_repo.create_organisation",
            side_effect=capture_org_create,
        ), patch(
            "src.tenancy.service.user_repo.create_user",
            side_effect=capture_admin_create,
        ), patch(
            "src.tenancy.service.send_activation_email",
            new_callable=AsyncMock,
        ), patch(
            "src.rabbitmq.outbox.publish",
            side_effect=capture_publish,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            response = await client.post(
                "/super-admin/organisations",
                json={
                    "legal_name": "Acme Corp",
                    "enabled_modules": ["core_hr"],
                    "setup_status": "pending",
                    "send_activation": True,
                    "administrator": {
                        "name": "Jane Doe",
                        "email": "jane@acme.com",
                        "phone": "555-0100",
                    },
                },
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert org_captured.get("correlation_id") == custom_cid
        assert admin_captured.get("correlation_id") == custom_cid
        assert outbox_captured.get("correlation_id") == custom_cid

    @pytest.mark.asyncio
    async def test_update_org_stamps_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        org_captured = {}

        async def capture_org_update(org_id, fields):
            org_captured.update(fields)
            return {**self._sample_org_doc(), **fields}

        with _auth_patch(), patch(
            "src.tenancy.service.org_repo.get_organisation_by_id",
            new_callable=AsyncMock,
            return_value=self._sample_org_doc(),
        ), patch(
            "src.tenancy.service.org_repo.get_organisation_by_legal_name",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "src.tenancy.service.org_repo.update_organisation",
            side_effect=capture_org_update,
        ), patch(
            "src.tenancy.service.user_repo.get_org_admin",
            new_callable=AsyncMock,
            return_value=self._sample_admin_doc(),
        ), patch(
            "src.rabbitmq.outbox.publish",
            new_callable=AsyncMock,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            await client.put(
                "/super-admin/organisations/org-1",
                json={"legal_name": "Acme Global"},
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert org_captured.get("correlation_id") == custom_cid


# ---------------------------------------------------------------------------
# Outbox events include correlation_id in payloads
# ---------------------------------------------------------------------------
class TestCorrelationIdInOutboxPayloads:
    @pytest.mark.asyncio
    async def test_user_created_event_has_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        outbox_captured = {}

        async def capture_publish(event_type, payload, *, idempotency_key, exchange=None):
            if event_type == "user.created":
                outbox_captured.update(payload)
            return "evt-id"

        new_user = {
            **TEST_USER_DOC,
            "id": str(uuid4()),
            "email": "new@example.com",
            "status": "inactive",
            "display_name": "New User",
        }

        with _auth_patch(), patch(
            "src.users.service.repository.get_user_by_email",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "src.users.service.repository.create_user",
            new_callable=AsyncMock,
            return_value=new_user,
        ), patch(
            "src.users.service.send_activation_email",
            new_callable=AsyncMock,
        ), patch(
            "src.rabbitmq.outbox.publish",
            side_effect=capture_publish,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            await client.post(
                "/users",
                json={
                    "email": "new@example.com",
                    "password": "Secure@123",
                    "auth_method": "local",
                    "first_name": "New",
                    "last_name": "User",
                },
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert outbox_captured.get("correlation_id") == custom_cid

    @pytest.mark.asyncio
    async def test_policy_created_event_has_correlation_id(
        self, client: AsyncClient, auth_headers: dict
    ):
        custom_cid = str(uuid4())
        outbox_captured = {}
        policy_doc = {
            "id": "pol-new",
            "name": "Test Policy",
            "status": "active",
            "organisation_id": None,
            "seed_module_codes": [],
            "created_on": datetime.now(timezone.utc),
            "modified_on": datetime.now(timezone.utc),
        }

        async def capture_publish(event_type, payload, *, idempotency_key, exchange=None):
            if event_type == "policy.created":
                outbox_captured.update(payload)
            return "evt-id"

        with _auth_patch(), patch(
            "src.policies.service.repo.get_policy_by_name",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "src.policies.service.repo.create_policy",
            new_callable=AsyncMock,
            return_value=policy_doc,
        ), patch(
            "src.rabbitmq.outbox.publish",
            side_effect=capture_publish,
        ), patch(
            "src.rabbitmq.outbox.publish_audit_log",
            new_callable=AsyncMock,
        ):
            await client.post(
                "/policies",
                json={"name": "Test Policy"},
                headers={**auth_headers, HEADER_NAME: custom_cid},
            )

        assert outbox_captured.get("correlation_id") == custom_cid
