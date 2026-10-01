from copy import deepcopy
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_FIRST_NAME, TEST_USER_ID, TEST_USER_LAST_NAME


# All user endpoints require auth, so every test patches get_user_by_email
# in the dependencies module (NOT the repository) to avoid conflicts with
# repository patches in individual tests.

def _auth_patch():
    """Patch the JWT guard's user lookup so protected endpoints pass."""
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(id=TEST_USER_ID, email=TEST_USER_EMAIL, first_name=TEST_USER_FIRST_NAME, last_name=TEST_USER_LAST_NAME, is_super_admin=True),
    )


# ---------------------------------------------------------------------------
# POST /users
# ---------------------------------------------------------------------------
class TestCreateUser:
    @pytest.mark.asyncio
    async def test_create_user_success(self, client: AsyncClient, auth_headers: dict):
        new_user_doc = {
            **TEST_USER_DOC,
            "id": str(uuid4()),
            "email": "newuser@example.com",
            "first_name": "New",
            "last_name": "User",
            "status": "inactive",
        }

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None), \
             patch("src.users.service.repository.create_user", new_callable=AsyncMock, return_value=new_user_doc), \
             patch("src.users.service.send_activation_email", new_callable=AsyncMock):
            response = await client.post("/users", json={
                "email": "newuser@example.com",
                "password": "Secure@123",
                "auth_method": "local",
                "first_name": "New",
                "last_name": "User",
            }, headers=auth_headers)

        assert response.status_code == 201
        data = response.json()
        assert data["email"] == "newuser@example.com"
        assert data["first_name"] == "New"
        assert data["last_name"] == "User"
        assert data["status"] == "inactive"
        assert "password_hash" not in data

    @pytest.mark.asyncio
    async def test_create_user_duplicate_email(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.post("/users", json={
                "email": TEST_USER_EMAIL,
                "password": "Secure@123",
                "auth_method": "local",
                "first_name": "Duplicate",
                "last_name": "User",
            }, headers=auth_headers)

        assert response.status_code == 409
        assert response.json()["code"] == "EMAIL_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_create_local_user_without_password(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None):
            response = await client.post("/users", json={
                "email": "nopass@example.com",
                "auth_method": "local",
                "first_name": "No",
                "last_name": "Password",
            }, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "PASSWORD_REQUIRED"

    @pytest.mark.asyncio
    async def test_create_sso_user_without_azure_oid(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None):
            response = await client.post("/users", json={
                "email": "sso@example.com",
                "auth_method": "azure_sso",
                "first_name": "SSO",
                "last_name": "User",
            }, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "AZURE_OID_REQUIRED"

    @pytest.mark.asyncio
    async def test_create_user_unauthenticated(self, client: AsyncClient):
        response = await client.post("/users", json={
            "email": "new@example.com",
            "password": "Secure@123",
            "auth_method": "local",
            "first_name": "No",
            "last_name": "Auth",
        })

        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /users
# ---------------------------------------------------------------------------
class TestListUsers:
    @pytest.mark.asyncio
    async def test_list_users_success(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.list_users", new_callable=AsyncMock, return_value=[TEST_USER_DOC]):
            response = await client.get("/users", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["email"] == TEST_USER_EMAIL

    @pytest.mark.asyncio
    async def test_list_users_empty(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.list_users", new_callable=AsyncMock, return_value=[]):
            response = await client.get("/users", headers=auth_headers)

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_users_pagination(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.list_users", new_callable=AsyncMock, return_value=[]) as mock_list:
            response = await client.get("/users?skip=10&limit=5", headers=auth_headers)

        assert response.status_code == 200
        mock_list.assert_called_once_with(10, 5, organisation_id=None)


# ---------------------------------------------------------------------------
# GET /users/search
# ---------------------------------------------------------------------------
class TestSearchUsers:
    @pytest.mark.asyncio
    async def test_search_users_by_name(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.search_users", new_callable=AsyncMock, return_value=[TEST_USER_DOC]) as mock_search:
            response = await client.get("/users/search?q=test", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["email"] == TEST_USER_EMAIL
        mock_search.assert_called_once_with("test", 0, 20, organisation_id=None)

    @pytest.mark.asyncio
    async def test_search_users_by_email(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.search_users", new_callable=AsyncMock, return_value=[TEST_USER_DOC]):
            response = await client.get("/users/search?q=testuser@", headers=auth_headers)

        assert response.status_code == 200
        assert len(response.json()) == 1

    @pytest.mark.asyncio
    async def test_search_users_empty_results(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.search_users", new_callable=AsyncMock, return_value=[]):
            response = await client.get("/users/search?q=nobody", headers=auth_headers)

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_search_users_pagination(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.search_users", new_callable=AsyncMock, return_value=[]) as mock_search:
            response = await client.get("/users/search?q=test&skip=5&limit=10", headers=auth_headers)

        assert response.status_code == 200
        mock_search.assert_called_once_with("test", 5, 10, organisation_id=None)

    @pytest.mark.asyncio
    async def test_search_users_requires_query(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch():
            response = await client.get("/users/search", headers=auth_headers)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_search_users_unauthenticated(self, client: AsyncClient):
        response = await client.get("/users/search?q=test")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /users/{user_id}
# ---------------------------------------------------------------------------
class TestGetUser:
    @pytest.mark.asyncio
    async def test_get_user_success(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.get(f"/users/{TEST_USER_ID}", headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["id"] == TEST_USER_ID

    @pytest.mark.asyncio
    async def test_get_user_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=None):
            response = await client.get(f"/users/{str(uuid4())}", headers=auth_headers)

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"


# ---------------------------------------------------------------------------
# PUT /users/{user_id}
# ---------------------------------------------------------------------------
class TestUpdateUser:
    @pytest.mark.asyncio
    async def test_update_user_success(self, client: AsyncClient, auth_headers: dict):
        updated_doc = {**TEST_USER_DOC, "first_name": "Updated", "last_name": "Name"}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.users.service.repository.update_user", new_callable=AsyncMock, return_value=updated_doc):
            response = await client.put(f"/users/{TEST_USER_ID}", json={
                "first_name": "Updated",
                "last_name": "Name",
            }, headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["first_name"] == "Updated"

    @pytest.mark.asyncio
    async def test_update_user_duplicate_email(self, client: AsyncClient, auth_headers: dict):
        other_user = {**TEST_USER_DOC, "id": str(uuid4()), "email": "other@example.com"}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=other_user):
            response = await client.put(f"/users/{TEST_USER_ID}", json={
                "email": "other@example.com",
            }, headers=auth_headers)

        assert response.status_code == 409
        assert response.json()["code"] == "EMAIL_ALREADY_EXISTS"

    @pytest.mark.asyncio
    async def test_update_user_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=None):
            response = await client.put(f"/users/{str(uuid4())}", json={
                "first_name": "Ghost",
            }, headers=auth_headers)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_update_user_empty_body(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch():
            response = await client.put(f"/users/{TEST_USER_ID}", json={}, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_INPUT"


# ---------------------------------------------------------------------------
# DELETE /users/{user_id}
# ---------------------------------------------------------------------------
class TestDeleteUser:
    @pytest.mark.asyncio
    async def test_delete_user_success(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.users.service.repository.update_user", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.delete(f"/users/{TEST_USER_ID}", headers=auth_headers)

        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_user_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=None):
            response = await client.delete(f"/users/{str(uuid4())}", headers=auth_headers)

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"


# ---------------------------------------------------------------------------
# POST /users/{uid}/policies/{pid} — attach
# ---------------------------------------------------------------------------
class TestAttachPolicyToUser:
    @pytest.mark.asyncio
    async def test_attach_success(self, client: AsyncClient, auth_headers: dict):
        user_doc = {**TEST_USER_DOC, "organisation_id": None, "policy_ids": []}
        policy_doc = {"id": "pol-1", "organisation_id": None, "name": "P", "status": "active"}
        updated = {**user_doc, "policy_ids": ["pol-1"]}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user_doc), \
             patch("src.users.service.policy_repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=policy_doc), \
             patch("src.users.service.repository.attach_policy",
                   new_callable=AsyncMock, return_value=updated):
            response = await client.post(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 200
        assert "pol-1" in response.json()["policy_ids"]

    @pytest.mark.asyncio
    async def test_attach_is_idempotent(self, client: AsyncClient, auth_headers: dict):
        """Attaching an already-attached policy is a no-op success."""
        user_doc = {**TEST_USER_DOC, "organisation_id": None, "policy_ids": ["pol-1"]}
        policy_doc = {"id": "pol-1", "organisation_id": None, "name": "P", "status": "active"}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user_doc), \
             patch("src.users.service.policy_repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=policy_doc), \
             patch("src.users.service.repository.attach_policy",
                   new_callable=AsyncMock, return_value=user_doc) as mock_attach:
            response = await client.post(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 200
        assert response.json()["policy_ids"] == ["pol-1"]
        # attach_policy always runs; the idempotency lives inside the repo.
        mock_attach.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_attach_rejects_cross_org(self, client: AsyncClient, auth_headers: dict):
        """Policy at Acme, user at Beta -> 400 ORG_MISMATCH."""
        user_doc = {**TEST_USER_DOC, "organisation_id": "beta-org", "policy_ids": []}
        policy_doc = {"id": "pol-1", "organisation_id": "acme-org", "name": "P", "status": "active"}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user_doc), \
             patch("src.users.service.policy_repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=policy_doc):
            response = await client.post(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 400
        assert response.json()["code"] == "ORG_MISMATCH"

    @pytest.mark.asyncio
    async def test_attach_user_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.post(
                f"/users/missing/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_attach_policy_not_found(self, client: AsyncClient, auth_headers: dict):
        user_doc = {**TEST_USER_DOC, "organisation_id": None, "policy_ids": []}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user_doc), \
             patch("src.users.service.policy_repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.post(
                f"/users/{TEST_USER_ID}/policies/ghost", headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "POLICY_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_org_admin_attach_within_own_org(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Org admin at Acme can attach an Acme policy to an Acme user."""
        from src.auth.schemas import UserBase
        user_doc = {**TEST_USER_DOC, "organisation_id": "acme", "policy_ids": []}
        policy_doc = {"id": "pol-1", "organisation_id": "acme", "name": "P", "status": "active"}
        updated = {**user_doc, "policy_ids": ["pol-1"]}

        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=UserBase(
                id="admin-1", email="admin@acme.com", first_name="A", last_name="Admin",
                is_super_admin=False, is_org_admin=True, organisation_id="acme",
            ),
        ), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock, return_value=user_doc,
        ), patch(
            "src.users.service.policy_repo.get_policy_by_id",
            new_callable=AsyncMock, return_value=policy_doc,
        ), patch(
            "src.users.service.repository.attach_policy",
            new_callable=AsyncMock, return_value=updated,
        ):
            response = await client.post(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_org_admin_cannot_touch_other_org(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Org admin at Beta hits 404 on an Acme user (hide existence)."""
        from src.auth.schemas import UserBase
        acme_user = {**TEST_USER_DOC, "organisation_id": "acme", "policy_ids": []}

        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=UserBase(
                id="admin-1", email="admin@beta.com", first_name="A", last_name="Admin",
                is_super_admin=False, is_org_admin=True, organisation_id="beta",
            ),
        ), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock, return_value=acme_user,
        ):
            response = await client.post(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_attach_unauthenticated(self, client: AsyncClient):
        response = await client.post(f"/users/{TEST_USER_ID}/policies/pol-1")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# DELETE /users/{uid}/policies/{pid} — detach
# ---------------------------------------------------------------------------
class TestDetachPolicyFromUser:
    @pytest.mark.asyncio
    async def test_detach_success(self, client: AsyncClient, auth_headers: dict):
        user_doc = {**TEST_USER_DOC, "organisation_id": None, "policy_ids": ["pol-1"]}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user_doc), \
             patch("src.users.service.repository.detach_policy",
                   new_callable=AsyncMock, return_value=(True, user_doc)):
            response = await client.delete(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_detach_not_attached_returns_404(
        self, client: AsyncClient, auth_headers: dict,
    ):
        user_doc = {**TEST_USER_DOC, "organisation_id": None, "policy_ids": []}

        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user_doc), \
             patch("src.users.service.repository.detach_policy",
                   new_callable=AsyncMock, return_value=(False, user_doc)):
            response = await client.delete(
                f"/users/{TEST_USER_ID}/policies/never-attached", headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "POLICY_NOT_ATTACHED"

    @pytest.mark.asyncio
    async def test_detach_user_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.users.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.delete(
                f"/users/missing/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_detach_cross_org_hides_existence(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Org admin at Beta detaching from Acme user -> 404."""
        from src.auth.schemas import UserBase
        acme_user = {
            **TEST_USER_DOC, "organisation_id": "acme", "policy_ids": ["pol-1"],
        }

        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=UserBase(
                id="admin-1", email="admin@beta.com", first_name="A", last_name="Admin",
                is_super_admin=False, is_org_admin=True, organisation_id="beta",
            ),
        ), patch(
            "src.users.service.repository.get_user_by_id",
            new_callable=AsyncMock, return_value=acme_user,
        ):
            response = await client.delete(
                f"/users/{TEST_USER_ID}/policies/pol-1", headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"
