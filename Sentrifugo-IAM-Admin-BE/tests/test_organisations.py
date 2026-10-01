"""Tests for OrganisationDocument, schemas, and super-admin CRUD routes.

Covers:
  - ODM field shape (colleague-schema compatibility)
  - Input/output Pydantic schemas
  - Service + router flows for /super-admin/organisations
    (create with rollback, view with admin resolution, partial update)
"""

from copy import deepcopy
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.models import ModuleEnum
from src.modules.organisation.models import OrganisationDocument
from src.tenancy.schemas import (
    AdministratorInput,
    OrganisationCreate,
    OrganisationListItem,
    OrganisationResponse,
    OrganisationUpdate,
)
from tests.conftest import TEST_USER_EMAIL, TEST_USER_FIRST_NAME, TEST_USER_ID, TEST_USER_LAST_NAME


ORGS_URL = "/super-admin/organisations"


def _super_admin_patch():
    """Patch the JWT guard's user lookup so routes see a super admin."""
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(
            id=TEST_USER_ID,
            email=TEST_USER_EMAIL,
            first_name=TEST_USER_FIRST_NAME,
            last_name=TEST_USER_LAST_NAME,
            is_super_admin=True,
        ),
    )


def _non_super_admin_patch():
    """Patch the JWT guard to return a regular (non-super-admin) user."""
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(
            id=TEST_USER_ID,
            email=TEST_USER_EMAIL,
            first_name=TEST_USER_FIRST_NAME,
            last_name=TEST_USER_LAST_NAME,
            is_super_admin=False,
            is_org_admin=True,
            organisation_id="some-org-id",
        ),
    )


def _sample_org_doc(**overrides) -> dict:
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


def _sample_admin_doc(**overrides) -> dict:
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


# ---------------------------------------------------------------------------
# ODM field shape (introspected without instantiating — Beanie requires
# init_beanie() before construction, which we don't set up in unit tests)
# ---------------------------------------------------------------------------
class TestOrganisationDocument:
    def test_colleague_fields_are_present(self):
        """The other service's fields exist verbatim on our ODM."""
        fields = OrganisationDocument.model_fields
        for required_field in (
            "legal_name", "address_id", "date_of_incorporation",
            "financial_year", "currency", "timezone",
            "logo_asset_id", "is_multiple_business_units", "custom_fields", "is_active",
            "created_by", "created_on", "modified_by", "modified_on",
            "deleted_by", "deleted_on", "correlation_id",
        ):
            assert required_field in fields, f"missing colleague field: {required_field}"

    def test_iam_additions_are_present(self):
        fields = OrganisationDocument.model_fields
        for added in ("enabled_modules", "setup_status"):
            assert added in fields, f"missing IAM addition: {added}"

    def test_colleague_field_defaults(self):
        """The defaults match what the other service writes."""
        fields = OrganisationDocument.model_fields
        assert fields["financial_year"].default is None
        assert fields["currency"].default is None
        assert fields["timezone"].default is None
        assert "is_multiple_business_units" in fields
        assert fields["is_active"].default is True

    def test_iam_addition_defaults(self):
        fields = OrganisationDocument.model_fields
        assert fields["setup_status"].default == "active"
        # default_factory returns an empty list
        assert fields["enabled_modules"].default_factory() == []

    def test_administrator_is_not_on_organisation(self):
        """Admin contact lives on the User, not the Organisation."""
        fields = OrganisationDocument.model_fields
        assert "administrator" not in fields
        assert "admin_name" not in fields
        assert "admin_email" not in fields
        assert "admin_phone" not in fields


# ---------------------------------------------------------------------------
# OrganisationCreate — super-admin 'Add New Organization' input
# ---------------------------------------------------------------------------
class TestOrganisationCreate:
    def test_minimal_valid_payload(self):
        payload = OrganisationCreate(
            legal_name="Acme Corp",
            enabled_modules=["core_hr"],
            administrator=AdministratorInput(
                name="Jane Doe", email="jane@acme.com", phone="555-0100"
            ),
        )
        assert payload.legal_name == "Acme Corp"
        assert ModuleEnum.CORE_HR in payload.enabled_modules
        assert payload.administrator.email == "jane@acme.com"
        assert payload.setup_status == "draft"
        assert payload.send_activation is True

    def test_enabled_modules_core_hr_mandatory(self):
        with pytest.raises(ValueError, match="Core HR is mandatory"):
            OrganisationCreate(
                legal_name="Acme",
                enabled_modules=["payroll", "leave_management"],  # missing core_hr
                administrator=AdministratorInput(name="J", email="j@a.com"),
            )

    def test_enabled_modules_empty_list_allowed_at_create(self):
        """Empty list is allowed (draft orgs) — Core HR only enforced if any are set."""
        payload = OrganisationCreate(
            legal_name="Acme",
            enabled_modules=[],
            administrator=AdministratorInput(name="J", email="j@a.com"),
        )
        assert payload.enabled_modules == []

    def test_enabled_modules_invalid_string_rejected(self):
        with pytest.raises(ValueError):
            OrganisationCreate(
                legal_name="Acme",
                enabled_modules=["not_a_module"],
                administrator=AdministratorInput(name="J", email="j@a.com"),
            )

    def test_administrator_required(self):
        with pytest.raises(ValueError):
            OrganisationCreate(legal_name="Acme", enabled_modules=[])


# ---------------------------------------------------------------------------
# OrganisationUpdate — partial edit
# ---------------------------------------------------------------------------
class TestOrganisationUpdate:
    def test_all_fields_optional(self):
        payload = OrganisationUpdate()  # empty is valid
        assert payload.legal_name is None
        assert payload.enabled_modules is None

    def test_partial_update_single_field(self):
        payload = OrganisationUpdate(currency="USD")
        assert payload.currency == "USD"
        assert payload.legal_name is None

    def test_update_enabled_modules_requires_core_hr(self):
        with pytest.raises(ValueError, match="Core HR is mandatory"):
            OrganisationUpdate(enabled_modules=["leave_management"])


# ---------------------------------------------------------------------------
# OrganisationResponse / ListItem
# ---------------------------------------------------------------------------
class TestOrganisationResponse:
    def test_response_round_trip(self):
        now = datetime.now(timezone.utc)
        resp = OrganisationResponse(
            id="org-1",
            legal_name="Acme",
            address_id=None,
            date_of_incorporation=None,
            financial_year="calendar",
            currency="INR",
            timezone="IST",
            logo_asset_id=None,
            is_multiple_business_units=False,
            custom_fields=None,
            is_active=True,
            enabled_modules=["core_hr", "payroll"],
            setup_status="active",
            administrator=None,
            created_on=now,
            modified_on=now,
        )
        dumped = resp.model_dump()
        assert dumped["legal_name"] == "Acme"
        assert dumped["enabled_modules"] == ["core_hr", "payroll"]

    def test_list_item_shape(self):
        item = OrganisationListItem(
            id="org-1",
            legal_name="Acme",
            is_active=True,
            setup_status="active",
            enabled_modules_count=3,
        )
        assert item.enabled_modules_count == 3


# ---------------------------------------------------------------------------
# POST /super-admin/organisations — Add New Organisation (image 3)
# ---------------------------------------------------------------------------
class TestCreateOrganisationRoute:
    def _payload(self, **overrides) -> dict:
        body = {
            "legal_name": "Acme Corp",
            "enabled_modules": ["core_hr"],
            "setup_status": "pending",
            "send_activation": True,
            "administrator": {
                "name": "Jane Doe",
                "email": "jane@acme.com",
                "phone": "555-0100",
            },
        }
        body.update(overrides)
        return body

    @pytest.mark.asyncio
    async def test_create_org_with_activation_success(
        self, client: AsyncClient, auth_headers: dict
    ):
        org_doc = _sample_org_doc()
        admin_doc = _sample_admin_doc()

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.user_repo.get_user_by_email",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.org_repo.create_organisation",
                   new_callable=AsyncMock, return_value=org_doc), \
             patch("src.tenancy.service.user_repo.create_user",
                   new_callable=AsyncMock, return_value=admin_doc), \
             patch("src.tenancy.service.send_activation_email",
                   new_callable=AsyncMock) as mock_send:
            response = await client.post(ORGS_URL, json=self._payload(), headers=auth_headers)

        assert response.status_code == 201
        data = response.json()
        assert data["legal_name"] == "Acme Corp"
        assert data["setup_status"] == "pending"
        assert data["administrator"]["name"] == "Jane Doe"
        assert data["administrator"]["email"] == "jane@acme.com"
        mock_send.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_create_org_save_as_draft_skips_activation(
        self, client: AsyncClient, auth_headers: dict
    ):
        """'Save as Draft' → setup_status=draft, send_activation=False."""
        org_doc = _sample_org_doc(setup_status="draft")
        admin_doc = _sample_admin_doc()

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.user_repo.get_user_by_email",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.org_repo.create_organisation",
                   new_callable=AsyncMock, return_value=org_doc), \
             patch("src.tenancy.service.user_repo.create_user",
                   new_callable=AsyncMock, return_value=admin_doc), \
             patch("src.tenancy.service.send_activation_email",
                   new_callable=AsyncMock) as mock_send:
            response = await client.post(
                ORGS_URL,
                json=self._payload(setup_status="draft", send_activation=False),
                headers=auth_headers,
            )

        assert response.status_code == 201
        mock_send.assert_not_called()

    @pytest.mark.asyncio
    async def test_draft_with_activation_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        """send_activation=True with setup_status=draft is inconsistent."""
        with _super_admin_patch():
            response = await client.post(
                ORGS_URL,
                json=self._payload(setup_status="draft", send_activation=True),
                headers=auth_headers,
            )

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_INPUT"

    @pytest.mark.asyncio
    async def test_duplicate_org_name_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=_sample_org_doc()):
            response = await client.post(ORGS_URL, json=self._payload(), headers=auth_headers)

        assert response.status_code == 409
        assert response.json()["code"] == "ORG_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_duplicate_admin_email_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.user_repo.get_user_by_email",
                   new_callable=AsyncMock, return_value=_sample_admin_doc()):
            response = await client.post(ORGS_URL, json=self._payload(), headers=auth_headers)

        assert response.status_code == 409
        assert response.json()["code"] == "EMAIL_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_missing_core_hr_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _super_admin_patch():
            response = await client.post(
                ORGS_URL,
                json=self._payload(enabled_modules=["payroll"]),
                headers=auth_headers,
            )

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_admin_user_insert_failure_rolls_back_org(self):
        """If user insert fails after org insert, the org must be soft-deleted.

        Exercises the service directly — the rollback path re-raises, and
        bubbling a non-DomainException through ASGITransport is noisy.
        """
        from src.tenancy import service as org_service
        from src.tenancy.schemas import AdministratorInput, OrganisationCreate

        org_doc = _sample_org_doc()
        payload = OrganisationCreate(
            legal_name="Acme Corp",
            enabled_modules=["core_hr"],
            setup_status="pending",
            send_activation=True,
            administrator=AdministratorInput(
                name="Jane Doe", email="jane@acme.com", phone="555-0100"
            ),
        )

        with patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.user_repo.get_user_by_email",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.org_repo.create_organisation",
                   new_callable=AsyncMock, return_value=org_doc), \
             patch("src.tenancy.service.user_repo.create_user",
                   new_callable=AsyncMock, side_effect=RuntimeError("db down")), \
             patch("src.tenancy.service.org_repo.update_organisation",
                   new_callable=AsyncMock) as mock_update:
            with pytest.raises(RuntimeError, match="db down"):
                await org_service.create_organisation(payload, current_user_id="admin")

        mock_update.assert_awaited_once()
        called_id = mock_update.call_args.args[0]
        called_patch = mock_update.call_args.args[1]
        assert called_id == org_doc["id"]
        assert "deleted_on" in called_patch

    @pytest.mark.asyncio
    async def test_activation_email_failure_does_not_rollback(
        self, client: AsyncClient, auth_headers: dict
    ):
        """Email is best-effort: org + admin stay created even if email fails."""
        org_doc = _sample_org_doc()
        admin_doc = _sample_admin_doc()

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.user_repo.get_user_by_email",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.org_repo.create_organisation",
                   new_callable=AsyncMock, return_value=org_doc), \
             patch("src.tenancy.service.user_repo.create_user",
                   new_callable=AsyncMock, return_value=admin_doc), \
             patch("src.tenancy.service.send_activation_email",
                   new_callable=AsyncMock, side_effect=RuntimeError("smtp down")):
            response = await client.post(ORGS_URL, json=self._payload(), headers=auth_headers)

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_non_super_admin_forbidden(self, client: AsyncClient, auth_headers: dict):
        with _non_super_admin_patch():
            response = await client.post(ORGS_URL, json=self._payload(), headers=auth_headers)

        assert response.status_code == 403
        assert response.json()["code"] == "FORBIDDEN"

    @pytest.mark.asyncio
    async def test_unauthenticated(self, client: AsyncClient):
        response = await client.post(ORGS_URL, json=self._payload())
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /super-admin/organisations — list
# ---------------------------------------------------------------------------
class TestListOrganisationsRoute:
    @pytest.mark.asyncio
    async def test_list_success(self, client: AsyncClient, auth_headers: dict):
        docs = [
            _sample_org_doc(id="o1", legal_name="A", enabled_modules=["core_hr", "payroll"]),
            _sample_org_doc(id="o2", legal_name="B"),
        ]
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.list_organisations",
                   new_callable=AsyncMock, return_value=docs):
            response = await client.get(ORGS_URL, headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        assert data[0]["legal_name"] == "A"
        assert data[0]["enabled_modules_count"] == 2
        assert data[1]["enabled_modules_count"] == 1

    @pytest.mark.asyncio
    async def test_list_pagination_and_filters(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.list_organisations",
                   new_callable=AsyncMock, return_value=[]) as mock_list:
            response = await client.get(
                f"{ORGS_URL}?skip=10&limit=5&search=acme&setup_status=active&is_active=true",
                headers=auth_headers,
            )

        assert response.status_code == 200
        mock_list.assert_awaited_once_with(
            skip=10, limit=5, search="acme", setup_status="active", is_active=True,
        )

    @pytest.mark.asyncio
    async def test_list_invalid_setup_status_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _super_admin_patch():
            response = await client.get(f"{ORGS_URL}?setup_status=bogus", headers=auth_headers)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_list_non_super_admin_forbidden(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _non_super_admin_patch():
            response = await client.get(ORGS_URL, headers=auth_headers)

        assert response.status_code == 403


# ---------------------------------------------------------------------------
# GET /super-admin/organisations/{id} — View (image 4)
# ---------------------------------------------------------------------------
class TestGetOrganisationRoute:
    @pytest.mark.asyncio
    async def test_get_resolves_administrator(
        self, client: AsyncClient, auth_headers: dict
    ):
        org_doc = _sample_org_doc()
        admin_doc = _sample_admin_doc()

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=org_doc), \
             patch("src.tenancy.service.user_repo.get_org_admin",
                   new_callable=AsyncMock, return_value=admin_doc):
            response = await client.get(f"{ORGS_URL}/{org_doc['id']}", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "org-1"
        assert data["administrator"]["name"] == "Jane Doe"
        assert data["administrator"]["email"] == "jane@acme.com"
        assert data["administrator"]["phone"] == "555-0100"

    @pytest.mark.asyncio
    async def test_get_without_admin_returns_null(
        self, client: AsyncClient, auth_headers: dict
    ):
        org_doc = _sample_org_doc()
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=org_doc), \
             patch("src.tenancy.service.user_repo.get_org_admin",
                   new_callable=AsyncMock, return_value=None):
            response = await client.get(f"{ORGS_URL}/{org_doc['id']}", headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["administrator"] is None

    @pytest.mark.asyncio
    async def test_get_not_found(self, client: AsyncClient, auth_headers: dict):
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.get(f"{ORGS_URL}/missing", headers=auth_headers)

        assert response.status_code == 404
        assert response.json()["code"] == "ORG_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_get_non_super_admin_forbidden(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _non_super_admin_patch():
            response = await client.get(f"{ORGS_URL}/org-1", headers=auth_headers)

        assert response.status_code == 403


# ---------------------------------------------------------------------------
# PUT /super-admin/organisations/{id} — Edit (image 5)
# ---------------------------------------------------------------------------
class TestUpdateOrganisationRoute:
    @pytest.mark.asyncio
    async def test_update_org_fields_only(
        self, client: AsyncClient, auth_headers: dict
    ):
        existing = _sample_org_doc()
        updated = _sample_org_doc(legal_name="Acme Global", is_active=False)
        admin_doc = _sample_admin_doc()

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=existing), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.tenancy.service.org_repo.update_organisation",
                   new_callable=AsyncMock, return_value=updated), \
             patch("src.tenancy.service.user_repo.get_org_admin",
                   new_callable=AsyncMock, return_value=admin_doc):
            response = await client.put(
                f"{ORGS_URL}/org-1",
                json={"legal_name": "Acme Global", "is_active": False},
                headers=auth_headers,
            )

        assert response.status_code == 200
        data = response.json()
        assert data["legal_name"] == "Acme Global"
        assert data["is_active"] is False

    @pytest.mark.asyncio
    async def test_update_admin_fields_routed_to_user(
        self, client: AsyncClient, auth_headers: dict
    ):
        """Name/phone land on UserDocument immediately; email goes through
        the confirmation flow (pending_email set, old email still live)."""
        existing = _sample_org_doc()
        admin_doc = _sample_admin_doc()
        # After name/phone write + pending_email set by initiate_email_change
        updated_admin = _sample_admin_doc(
            first_name="Jane", last_name="Smith", phone="555-9999",
            pending_email="jane.smith@acme.com",
        )

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=existing), \
             patch("src.tenancy.service.user_repo.get_org_admin",
                   new_callable=AsyncMock, return_value=admin_doc), \
             patch("src.tenancy.service.initiate_email_change",
                   new_callable=AsyncMock) as mock_init_email, \
             patch("src.tenancy.service.user_repo.update_user",
                   new_callable=AsyncMock, return_value=updated_admin) as mock_user_update:
            response = await client.put(
                f"{ORGS_URL}/org-1",
                json={"administrator": {
                    "name": "Jane Smith",
                    "email": "jane.smith@acme.com",
                    "phone": "555-9999",
                }},
                headers=auth_headers,
            )

        assert response.status_code == 200
        data = response.json()
        assert data["administrator"]["name"] == "Jane Smith"
        # Email stays as the old one until the admin confirms via the link.
        assert data["administrator"]["email"] == "jane@acme.com"
        assert data["administrator"]["pending_email"] == "jane.smith@acme.com"
        mock_user_update.assert_awaited_once()
        mock_init_email.assert_awaited_once_with("admin-1", "jane.smith@acme.com")

    @pytest.mark.asyncio
    async def test_update_admin_email_clash_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        """initiate_email_change surfaces the 409 when the new email is taken."""
        from fastapi import status as http_status
        from src.exceptions import DomainException

        existing = _sample_org_doc()
        admin_doc = _sample_admin_doc()

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=existing), \
             patch("src.tenancy.service.user_repo.get_org_admin",
                   new_callable=AsyncMock, return_value=admin_doc), \
             patch("src.tenancy.service.initiate_email_change",
                   new_callable=AsyncMock,
                   side_effect=DomainException(
                       message="A user with this email already exists",
                       code="EMAIL_ALREADY_EXISTS",
                       status_code=http_status.HTTP_409_CONFLICT,
                   )):
            response = await client.put(
                f"{ORGS_URL}/org-1",
                json={"administrator": {"email": "taken@x.com"}},
                headers=auth_headers,
            )

        assert response.status_code == 409
        assert response.json()["code"] == "EMAIL_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_update_org_not_found(self, client: AsyncClient, auth_headers: dict):
        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.put(
                f"{ORGS_URL}/missing",
                json={"legal_name": "X"},
                headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "ORG_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_update_legal_name_clash_rejected(
        self, client: AsyncClient, auth_headers: dict
    ):
        existing = _sample_org_doc()
        other = _sample_org_doc(id="other", legal_name="Taken")

        with _super_admin_patch(), \
             patch("src.tenancy.service.org_repo.get_organisation_by_id",
                   new_callable=AsyncMock, return_value=existing), \
             patch("src.tenancy.service.org_repo.get_organisation_by_legal_name",
                   new_callable=AsyncMock, return_value=other):
            response = await client.put(
                f"{ORGS_URL}/org-1",
                json={"legal_name": "Taken"},
                headers=auth_headers,
            )

        assert response.status_code == 409
        assert response.json()["code"] == "ORG_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_update_enabled_modules_must_keep_core_hr(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _super_admin_patch():
            response = await client.put(
                f"{ORGS_URL}/org-1",
                json={"enabled_modules": ["payroll"]},
                headers=auth_headers,
            )

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_non_super_admin_forbidden(
        self, client: AsyncClient, auth_headers: dict
    ):
        with _non_super_admin_patch():
            response = await client.put(
                f"{ORGS_URL}/org-1",
                json={"legal_name": "X"},
                headers=auth_headers,
            )

        assert response.status_code == 403
