"""API tests for Categories CRUD endpoints."""
from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio

from src.main import app
from src.models import Category

from src.config import settings as _settings

# Derived from config so the suite follows whatever API_PREFIX the
# environment declares (empty locally, mounted under a gateway path in
# deployment) instead of asserting one hardcoded value.
PREFIX = _settings.API_PREFIX

# Ids come from the IAM stub fixtures so the two can't drift. They are
# ObjectId-shaped because every id crossing the API is typed PydanticObjectId.
from src.integrations.iam_client import (  # noqa: E402
    STUB_BU_HR_ID,
    STUB_BU_MAIN_ID,
    STUB_DEPT_HR_ID,
    STUB_DEPT_IT_ID,
    STUB_DEPT_SHARED_ID,
    STUB_ORG_ID,
    STUB_USER_ADMIN_ID,
    STUB_USER_EMPLOYEE_ID,
    STUB_USER_EMPLOYEE2_ID,
    STUB_USER_MANAGER_ID,
)

ORG_ID = STUB_ORG_ID
DEPT_ID = STUB_DEPT_IT_ID
BU_ID = STUB_BU_MAIN_ID  # the stub IT department belongs to this business unit
BU_HR_ID = STUB_BU_HR_ID
DEPT_HR_ID = STUB_DEPT_HR_ID
DEPT_SHARED_ID = STUB_DEPT_SHARED_ID  # belongs to both business units

DEV_SESSION = json.dumps({
    "id": STUB_USER_ADMIN_ID,
    "organisation_id": ORG_ID,
    "email": "admin@demo.local",
    "display_name": "Demo Admin",
    "is_super_admin": True,
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
async def cleanup_categories():
    yield
    # find_all, not a filter on organisation_id: that field is stored as an
    # ObjectId, so filtering by the string id matches nothing and the cleanup
    # silently no-ops — leaving rows that collide on the unique name index and
    # fail the *next* run with a 409. The test database is dedicated, so
    # clearing the collection outright is both safe and unambiguous.
    await Category.find_all().delete()


class TestListCategories:
    async def test_list_empty(self, client, cleanup_categories):
        resp = await client.get(f"{PREFIX}/categories")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data

    async def test_list_with_query(self, client, cleanup_categories):
        resp = await client.get(f"{PREFIX}/categories", params={"q": "aaaaaaaaaaaaaaaaaaaaaaaa"})
        assert resp.status_code == 200

    async def test_list_with_status_filter(self, client, cleanup_categories):
        resp = await client.get(f"{PREFIX}/categories", params={"status": "active"})
        assert resp.status_code == 200

    async def test_list_with_department_filter(self, client, cleanup_categories):
        resp = await client.get(f"{PREFIX}/categories", params={"department_id": DEPT_ID})
        assert resp.status_code == 200

    async def test_list_pagination(self, client, cleanup_categories):
        resp = await client.get(f"{PREFIX}/categories", params={"page": 1, "page_size": 5})
        assert resp.status_code == 200


class TestCreateCategory:
    async def test_create_success(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "IT Support Test",
            "description": "Test category for IT",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "IT Support Test"
        assert data["department_id"] == DEPT_ID
        assert data["business_unit_id"] == BU_ID
        assert data["restricted_visibility"] is False
        assert data["status"] == "active"
        assert "id" in data

    async def test_create_missing_business_unit(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "No BU Category",
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 422

    async def test_create_bu_department_mismatch(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Mismatch Category",
            # IT belongs to the main BU only, so the HR BU is a real, well-formed
            # id that still isn't linked to this department — which is what the
            # 400 is meant to catch. A malformed id would 422 at validation
            # instead and never reach the mismatch check.
            "business_unit_id": BU_HR_ID,
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "BUSINESS_UNIT_DEPARTMENT_MISMATCH"

    async def test_create_restricted(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Restricted Category",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
            "restricted_visibility": True,
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["restricted_visibility"] is True
        # No explicit scope sent — falls back to home, stored empty.
        assert data["visibility_business_unit_ids"] == []
        assert data["visibility_department_ids"] == []

    async def test_create_has_empty_visibility_scope_by_default(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Org Wide Category",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["visibility_business_unit_ids"] == []
        assert data["visibility_department_ids"] == []

    async def test_create_restricted_with_multi_scope(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Multi Scope Category",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
            "restricted_visibility": True,
            # Shared dept belongs to BOTH selected business units (intersection).
            "visibility_business_unit_ids": [BU_ID, BU_HR_ID],
            "visibility_department_ids": [DEPT_SHARED_ID],
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["restricted_visibility"] is True
        assert set(data["visibility_business_unit_ids"]) == {BU_ID, BU_HR_ID}
        assert data["visibility_department_ids"] == [DEPT_SHARED_ID]

    async def test_create_restricted_scope_department_not_in_all_bus(self, client, cleanup_categories):
        # dept_demo_it belongs only to bu_demo_main, not bu_demo_hr, so it is
        # not in the intersection of the two selected BUs -> mismatch.
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Bad Scope Category",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
            "restricted_visibility": True,
            "visibility_business_unit_ids": [BU_ID, BU_HR_ID],
            "visibility_department_ids": [DEPT_ID],
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "BUSINESS_UNIT_DEPARTMENT_MISMATCH"

    async def test_create_name_too_short(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "ab",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 422

    async def test_create_missing_department(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Valid Name",
        })
        assert resp.status_code == 422

    async def test_create_duplicate_name(self, client, cleanup_categories):
        await client.post(f"{PREFIX}/categories", json={
            "name": "Duplicate Test",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Duplicate Test",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 409
        assert resp.json()["code"] == "CATEGORY_NAME_EXISTS"


class TestGetCategory:
    async def test_get_success(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Get Test Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        cat_id = create_resp.json()["id"]
        resp = await client.get(f"{PREFIX}/categories/{cat_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == cat_id

    async def test_get_not_found(self, client, cleanup_categories):
        resp = await client.get(f"{PREFIX}/categories/aaaaaaaaaaaaaaaaaaaaaaaa")
        assert resp.status_code == 404


class TestUpdateCategory:
    async def test_update_name(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Update Test Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        cat_id = create_resp.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "name": "Updated Name",
        })
        assert resp.status_code == 200
        assert resp.json()["name"] == "Updated Name"

    async def test_update_description(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Desc Update Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        cat_id = create_resp.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "description": "New description",
        })
        assert resp.status_code == 200
        assert resp.json()["description"] == "New description"

    async def test_update_status(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Status Update Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        cat_id = create_resp.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "status": "inactive",
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "inactive"

    async def test_update_set_multi_visibility_scope(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Scope Update Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        cat_id = create_resp.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "restricted_visibility": True,
            "visibility_business_unit_ids": [BU_ID, BU_HR_ID],
            "visibility_department_ids": [DEPT_SHARED_ID],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["restricted_visibility"] is True
        assert set(data["visibility_business_unit_ids"]) == {BU_ID, BU_HR_ID}
        assert data["visibility_department_ids"] == [DEPT_SHARED_ID]

    async def test_update_clears_scope_when_unrestricted(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Scope Clear Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
            "restricted_visibility": True,
            "visibility_business_unit_ids": [BU_ID, BU_HR_ID],
            "visibility_department_ids": [DEPT_SHARED_ID],
        })
        cat_id = create_resp.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "restricted_visibility": False,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["restricted_visibility"] is False
        assert data["visibility_business_unit_ids"] == []
        assert data["visibility_department_ids"] == []

    async def test_update_not_found(self, client, cleanup_categories):
        resp = await client.put(f"{PREFIX}/categories/aaaaaaaaaaaaaaaaaaaaaaaa", json={"name": "Valid Name"})
        assert resp.status_code == 404


class TestDeleteCategory:
    async def test_delete_success(self, client, cleanup_categories):
        create_resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Delete Test Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        cat_id = create_resp.json()["id"]
        resp = await client.delete(f"{PREFIX}/categories/{cat_id}")
        assert resp.status_code == 204

    async def test_delete_not_found(self, client, cleanup_categories):
        resp = await client.delete(f"{PREFIX}/categories/aaaaaaaaaaaaaaaaaaaaaaaa")
        assert resp.status_code == 404


class TestMultiDepartmentCategory:
    """D9 — a category is scoped to one business unit and a list of departments.

    The stub fixtures line up for this: IT and Facilities both sit under the
    main business unit, EMPLOYEE2 belongs to IT only and EMPLOYEE belongs to
    both, which is exactly what the pruning rule has to tell apart.
    """

    async def test_create_with_department_list(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Multi Dept Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID, DEPT_SHARED_ID],
        })
        assert resp.status_code == 201, resp.json()
        data = resp.json()
        assert data["department_ids"] == [DEPT_ID, DEPT_SHARED_ID]
        # The deprecated scalar is dual-written as the first entry (D12).
        assert data["department_id"] == DEPT_ID
        assert data["department_names"] == ["IT", "Facilities"]

    async def test_legacy_scalar_is_promoted(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Legacy Scalar Cat",
            "business_unit_id": BU_ID,
            "department_id": DEPT_ID,
        })
        assert resp.status_code == 201
        assert resp.json()["department_ids"] == [DEPT_ID]

    async def test_department_outside_the_business_unit_rejected(
        self, client, cleanup_categories
    ):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Bad Multi Cat",
            "business_unit_id": BU_ID,
            # HR belongs to the HR business unit only.
            "department_ids": [DEPT_ID, DEPT_HR_ID],
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "BUSINESS_UNIT_DEPARTMENT_MISMATCH"

    async def test_empty_department_list_rejected(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "No Dept Cat",
            "business_unit_id": BU_ID,
            "department_ids": [],
        })
        assert resp.status_code == 422

    async def test_roster_spans_both_departments(self, client, cleanup_categories):
        """The roster is validated against the union, and each row carries the
        department it was found under plus the codes the pickers render."""
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Roster Multi Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID, DEPT_SHARED_ID],
            "executors": [
                {"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"},
                {"user_id": STUB_USER_EMPLOYEE2_ID, "role": "secondary"},
            ],
        })
        assert resp.status_code == 201, resp.json()
        by_id = {e["user_id"]: e for e in resp.json()["executors"]}
        assert by_id[STUB_USER_EMPLOYEE_ID]["role"] == "primary"
        assert by_id[STUB_USER_EMPLOYEE2_ID]["role"] == "secondary"
        # Snapshot fields the Ticket Type chips and the employee list render.
        assert by_id[STUB_USER_EMPLOYEE_ID]["emp_code"] == "EMP013"
        assert by_id[STUB_USER_EMPLOYEE_ID]["department_code"] == "IT"
        assert by_id[STUB_USER_EMPLOYEE_ID]["email"] == "employee@demo.local"

    async def test_head_is_flagged_not_stored(self, client, cleanup_categories):
        """D3 — heads render locked. The flag is derived, never persisted."""
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Head Flag Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "executors": [
                {"user_id": STUB_USER_MANAGER_ID, "role": "primary"},
                {"user_id": STUB_USER_EMPLOYEE_ID, "role": "secondary"},
            ],
        })
        assert resp.status_code == 201, resp.json()
        by_id = {e["user_id"]: e for e in resp.json()["executors"]}
        assert by_id[STUB_USER_MANAGER_ID]["is_department_head"] is True
        assert by_id[STUB_USER_EMPLOYEE_ID]["is_department_head"] is False

    async def test_executor_outside_every_department_rejected(
        self, client, cleanup_categories
    ):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Outsider Roster Cat",
            "business_unit_id": BU_HR_ID,
            "department_ids": [DEPT_HR_ID],
            # EMPLOYEE2 is in IT only, and HR's only member is the head. The
            # head is named primary purely to clear the "a roster needs a
            # primary" schema rule, so the 400 below is the department check
            # rejecting EMPLOYEE2 rather than a 422 from validation.
            "executors": [
                {"user_id": STUB_USER_MANAGER_ID, "role": "primary"},
                {"user_id": STUB_USER_EMPLOYEE2_ID, "role": "secondary"},
            ],
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "EXECUTOR_NOT_IN_DEPARTMENT"

    async def test_update_replaces_the_department_list(self, client, cleanup_categories):
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "Dept Swap Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
        })
        cat_id = create.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "department_ids": [DEPT_SHARED_ID, DEPT_ID],
        })
        assert resp.status_code == 200, resp.json()
        data = resp.json()
        assert data["department_ids"] == [DEPT_SHARED_ID, DEPT_ID]
        assert data["department_id"] == DEPT_SHARED_ID

    async def test_removing_a_department_prunes_only_its_executors(
        self, client, cleanup_categories
    ):
        """§5.2 — pruning, not clearing. EMPLOYEE is in both departments and
        survives; EMPLOYEE2 is in IT alone and goes with it."""
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "Prune Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID, DEPT_SHARED_ID],
            "executors": [
                {"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"},
                {"user_id": STUB_USER_EMPLOYEE2_ID, "role": "secondary"},
            ],
        })
        cat_id = create.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "department_ids": [DEPT_SHARED_ID],
        })
        assert resp.status_code == 200, resp.json()
        kept = {e["user_id"]: e for e in resp.json()["executors"]}
        assert STUB_USER_EMPLOYEE_ID in kept
        assert STUB_USER_EMPLOYEE2_ID not in kept
        # The survivor is re-stamped with a department that still exists.
        assert kept[STUB_USER_EMPLOYEE_ID]["department_code"] == "FAC"

    async def test_update_cannot_clear_every_department(
        self, client, cleanup_categories
    ):
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "No Clear Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
        })
        cat_id = create.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "department_ids": [],
        })
        assert resp.status_code == 422

    async def test_list_filter_matches_a_non_primary_department(
        self, client, cleanup_categories
    ):
        await client.post(f"{PREFIX}/categories", json={
            "name": "Filter Multi Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID, DEPT_SHARED_ID],
        })
        # Facilities is department_ids[1] — array membership, not just the first.
        resp = await client.get(
            f"{PREFIX}/categories", params={"department_id": DEPT_SHARED_ID}
        )
        assert resp.status_code == 200
        assert "Filter Multi Cat" in {c["name"] for c in resp.json()["items"]}

    async def test_roster_exclusivity_round_trips(self, client, cleanup_categories):
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Exclusive Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
            "roster_is_exclusive": True,
        })
        assert resp.status_code == 201
        assert resp.json()["roster_is_exclusive"] is True

    async def test_roster_survives_an_edit_of_a_restricted_category(
        self, client, cleanup_categories
    ):
        """Regression: the visibility scope must not be mistaken for the
        staffing departments.

        `update_category` resolves the roster against the category's STAFFING
        departments. A local named `eff_depts` was being reused for the
        visibility scope — normally empty — so any edit of a restricted
        category validated the roster against nothing and either 400'd or
        silently emptied it. The reassign picker then fell back to the whole
        department, which is how this surfaced.
        """
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "Restricted Roster Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "restricted_visibility": True,
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
        })
        assert create.status_code == 201, create.json()
        cat_id = create.json()["id"]

        # Exactly what CategoryForm PUTs: the whole payload every time, so the
        # visibility branch is always entered.
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "name": "Restricted Roster Cat Renamed",
            "restricted_visibility": True,
            "visibility_business_unit_ids": [],
            "visibility_department_ids": [],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
        })
        assert resp.status_code == 200, resp.json()
        data = resp.json()
        assert [e["user_id"] for e in data["executors"]] == [STUB_USER_EMPLOYEE_ID]
        assert data["executors"][0]["role"] == "primary"
        # The staffing department is untouched by a visibility-only edit.
        assert data["department_ids"] == [DEPT_ID]

    async def test_restricted_edit_does_not_prune_an_untouched_roster(
        self, client, cleanup_categories
    ):
        """Same bug, the other path: the PRUNE branch.

        Sending `department_ids` (even unchanged) with no `executors` runs
        `_prune_executors` against the staffing departments. Under the shadowing
        bug it pruned against the visibility scope instead, so a restricted
        category lost its whole roster on a scope edit — silently, with a 200.
        """
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "Restricted Prune Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID, DEPT_SHARED_ID],
            "restricted_visibility": True,
            "executors": [
                {"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"},
                {"user_id": STUB_USER_EMPLOYEE2_ID, "role": "secondary"},
            ],
        })
        assert create.status_code == 201, create.json()
        cat_id = create.json()["id"]

        # department_ids sent (unchanged) => the prune branch runs; the
        # visibility scope is a DIFFERENT list and must not be mistaken for it.
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "department_ids": [DEPT_ID, DEPT_SHARED_ID],
            "restricted_visibility": True,
            "visibility_business_unit_ids": [BU_ID, BU_HR_ID],
            "visibility_department_ids": [DEPT_SHARED_ID],
        })
        assert resp.status_code == 200, resp.json()
        data = resp.json()
        assert sorted(e["user_id"] for e in data["executors"]) == sorted(
            [STUB_USER_EMPLOYEE_ID, STUB_USER_EMPLOYEE2_ID]
        ), "a scope edit must not prune executors of the staffing departments"
        assert data["visibility_department_ids"] == [DEPT_SHARED_ID]

    async def test_moving_the_business_unit_alone_is_rejected_when_it_orphans_departments(
        self, client, cleanup_categories
    ):
        """Tripwire: the roster can never outlive its departments' business unit.

        Changing `business_unit_id` on its own does NOT re-validate the roster —
        and does not need to. `_ensure_bu_and_depts` re-checks the category's
        existing departments against the incoming BU, so a BU move that would
        orphan them fails before anything is written. The roster is only ever
        validated against departments, and those are still valid by construction.

        This test exists to keep that true: if someone ever relaxes the
        department check on a BU-only change, this goes red rather than silently
        leaving executors attached to a department outside the new BU.
        """
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "BU Move Cat",
            "business_unit_id": BU_ID,
            # IT belongs to the main BU only.
            "department_ids": [DEPT_ID],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
        })
        assert create.status_code == 201, create.json()
        cat_id = create.json()["id"]

        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "business_unit_id": BU_HR_ID,
        })
        assert resp.status_code == 400
        assert resp.json()["code"] == "BUSINESS_UNIT_DEPARTMENT_MISMATCH"

        # Nothing was written — the roster and the BU are untouched.
        after = await client.get(f"{PREFIX}/categories/{cat_id}")
        assert after.status_code == 200
        body = after.json()
        assert body["business_unit_id"] == BU_ID
        assert [e["user_id"] for e in body["executors"]] == [STUB_USER_EMPLOYEE_ID]

    async def test_moving_the_business_unit_alone_keeps_a_still_valid_roster(
        self, client, cleanup_categories
    ):
        """The permitted case: a department shared by both business units.

        Here the BU move is legitimate — the staffing department belongs to the
        new BU too — so the roster stays valid and must survive untouched.
        """
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "BU Move Shared Cat",
            "business_unit_id": BU_ID,
            # Facilities belongs to BOTH business units.
            "department_ids": [DEPT_SHARED_ID],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
        })
        assert create.status_code == 201, create.json()
        cat_id = create.json()["id"]

        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "business_unit_id": BU_HR_ID,
        })
        assert resp.status_code == 200, resp.json()
        body = resp.json()
        assert body["business_unit_id"] == BU_HR_ID
        assert body["department_ids"] == [DEPT_SHARED_ID]
        assert [e["user_id"] for e in body["executors"]] == [STUB_USER_EMPLOYEE_ID]

    async def test_a_roster_with_no_primary_is_rejected(
        self, client, cleanup_categories
    ):
        """Named executors but nobody to hand tickets out to.

        Primaries assign, reassign and receive escalations. An all-secondary
        roster lists people to do the work and nobody to distribute it — and
        because a department head is still an implicit primary, it would run on
        someone the roster never mentions.
        """
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "No Primary Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "secondary"}],
        })
        assert resp.status_code == 422, resp.json()
        assert "primary" in resp.json()["detail"].lower()

    async def test_an_empty_roster_is_still_allowed(
        self, client, cleanup_categories
    ):
        """The rule is conditional — empty means "the department handles it".

        Every category that predates rosters is in this state (D4), so an
        unconditional primary requirement would make them unsaveable.
        """
        resp = await client.post(f"{PREFIX}/categories", json={
            "name": "Empty Roster Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "executors": [],
        })
        assert resp.status_code == 201, resp.json()
        assert resp.json()["executors"] == []

    async def test_updating_a_roster_to_all_secondary_is_rejected(
        self, client, cleanup_categories
    ):
        """The same rule on the update path — demoting the last primary."""
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "Demote Last Primary Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
        })
        assert create.status_code == 201, create.json()
        cat_id = create.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "secondary"}],
        })
        assert resp.status_code == 422, resp.json()

    async def test_clearing_the_roster_drops_exclusivity(
        self, client, cleanup_categories
    ):
        """A lockdown nobody asked for must not survive a re-roster."""
        create = await client.post(f"{PREFIX}/categories", json={
            "name": "Exclusive Clear Cat",
            "business_unit_id": BU_ID,
            "department_ids": [DEPT_ID],
            "executors": [{"user_id": STUB_USER_EMPLOYEE_ID, "role": "primary"}],
            "roster_is_exclusive": True,
        })
        cat_id = create.json()["id"]
        resp = await client.put(f"{PREFIX}/categories/{cat_id}", json={"executors": []})
        assert resp.status_code == 200
        assert resp.json()["executors"] == []
        assert resp.json()["roster_is_exclusive"] is False
