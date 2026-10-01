"""Tests for the Announcements module — src/modules/announcements.

This suite was originally written against a second, parallel implementation of
this feature that lived at src/modules/organisation/announcements. The two were
authored independently from the same commit, landed on one branch, and merged
without conflict because they occupied different paths — leaving `src/main.py`
importing both routers as ``announcements_router``, where the later import won
and the earlier module became unreachable. The unreachable copy has since been
deleted and this suite repointed at the module that is served. Where the two
contracts genuinely differed, the assertions follow the surviving one (publish
and unpublish are idempotent rather than 409; attachments travel as a whole list
on PATCH rather than through attach / detach routes).

The interesting logic in this module lives in the service layer (tenancy
scoping, the department / business-unit targeting filter and the
draft → published lifecycle), and all of it is expressed as Mongo queries
against Beanie documents rather than through a repository seam. So instead of
stubbing the service out (as tests/test_exit_management.py does for its routing
smoke tests), these tests drive the real router + guard + service stack over a
small in-memory stand-in for the document API. That makes the visibility filter
testable as *behaviour* — "who actually sees this row" — rather than as a query
dict.

Conventions follow the existing suite:
  - the shared ``client`` / ``auth_headers`` fixtures from tests/conftest.py are
    reused unchanged; nothing new was added there,
  - callers are modelled by patching ``get_user_by_email`` plus the Valkey
    session grid, exactly as tests/test_authorization.py does,
  - cross-tenant reads assert **404**, never 403, as tests/test_tenancy.py does.
"""

import re
from contextlib import ExitStack, contextmanager
from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.models import AssetDocument
from src.modules.announcements import service as announcement_service  # noqa: F401
from src.modules.announcements.models import (
    AnnouncementAttachment,
    AnnouncementDocument,
    AnnouncementStatusEnum,
)
from src.modules.organisation.models import (
    BusinessUnitDocument,
    DepartmentDocument,
    EmployeeDocument,
)

BASE = "/announcements"


def _oid(suffix: str) -> PydanticObjectId:
    """Build a stable, readable ObjectId from a two-character suffix."""
    return PydanticObjectId(f"507f1f77bcf86cd7994300{suffix}")


ORG_A = _oid("a1")
ORG_B = _oid("b1")

DEPT_ENGINEERING = _oid("d1")
DEPT_SALES = _oid("d2")
BU_NORTH = _oid("e1")
BU_SOUTH = _oid("e2")

ASSET_ONE = _oid("f1")
ASSET_TWO = _oid("f2")


# ---------------------------------------------------------------------------
# Callers
# ---------------------------------------------------------------------------
def _user(
    user_id: PydanticObjectId,
    organisation_id: PydanticObjectId | None,
    *,
    is_super_admin: bool = False,
    is_org_admin: bool = False,
) -> UserBase:
    return UserBase(
        id=str(user_id),
        email=f"{user_id}@example.com",
        first_name="Test",
        last_name="User",
        is_super_admin=is_super_admin,
        is_org_admin=is_org_admin,
        organisation_id=str(organisation_id) if organisation_id else None,
    )


ADMIN_A = _user(_oid("11"), ORG_A, is_org_admin=True)
ADMIN_B = _user(_oid("12"), ORG_B, is_org_admin=True)
SUPER_ADMIN = _user(_oid("13"), ORG_A, is_super_admin=True)
SUPER_ADMIN_NO_ORG = _user(_oid("14"), None, is_super_admin=True)

STAFF_ENGINEERING = _user(_oid("21"), ORG_A)   # employee record: Engineering / North
STAFF_SALES = _user(_oid("22"), ORG_A)         # employee record: Sales / South
STAFF_UNASSIGNED = _user(_oid("23"), ORG_A)    # employee record with no BU/department
STAFF_NO_RECORD = _user(_oid("24"), ORG_A)     # no employee record at all

# Permission grids as written into the Valkey session at login.
VIEW_ONLY = {
    "core_hr": {
        "acl": "viewer",
        "actions": {"view_announcements": True, "manage_announcements": False},
    }
}
MANAGE_ONLY = {
    "core_hr": {
        "acl": "editor",
        "actions": {"view_announcements": False, "manage_announcements": True},
    }
}


@contextmanager
def acting_as(caller: UserBase, permissions: dict | None = None):
    """Run the block as ``caller``, holding exactly ``permissions``.

    Args:
        caller: The authenticated user the request should resolve to.
        permissions: The resolved permission grid. ``None`` means "no grants at
            all" — the guard then finds neither a cached session nor any
            resolvable grant, which is the correct model for an unprivileged
            caller. Ignored for super / org admins, who bypass the guard.
    """
    with ExitStack() as stack:
        stack.enter_context(
            patch(
                "src.auth.utils.dependencies.get_user_by_email",
                new_callable=AsyncMock,
                return_value=caller,
            )
        )
        session = None if permissions is None else {"permissions": permissions}
        stack.enter_context(
            patch(
                "src.auth.utils.authorization.get_user_session",
                new_callable=AsyncMock,
                return_value=session,
            )
        )
        stack.enter_context(
            patch(
                "src.auth.utils.authorization.resolve_user_permissions",
                new_callable=AsyncMock,
                return_value=permissions or {},
            )
        )
        yield


# ---------------------------------------------------------------------------
# In-memory stand-in for the Beanie document API
#
# Only the surface the announcements service actually touches is implemented:
# find / find_one / insert / save / get, plus the handful of Mongo operators the
# module's queries use ($and, $or, $in, $ne, $size, $exists, $regex).
# ---------------------------------------------------------------------------
def _field(doc, name: str):
    return doc.id if name == "_id" else getattr(doc, name, None)


def _match_operators(value, condition: dict) -> bool:
    for operator, operand in condition.items():
        if operator == "$in":
            candidates = list(value) if isinstance(value, list) else [value]
            if not any(candidate in operand for candidate in candidates):
                return False
        elif operator == "$ne":
            # Whole-value inequality — on a list field this is "the array is not
            # exactly this", NOT "does not contain".
            if (value if value is not None else []) == operand:
                return False
        elif operator == "$size":
            if len(value or []) != operand:
                return False
        elif operator == "$exists":
            if (value is not None) != operand:
                return False
        elif operator == "$regex":
            flags = re.IGNORECASE if "i" in condition.get("$options", "") else 0
            if value is None or not re.search(operand, str(value), flags):
                return False
        elif operator == "$not":
            # The employee page's `scope=targeted` filter is expressed as
            # {"$not": {"$size": 0}} — "this allow-list has at least one entry".
            if _match_operators(value, operand):
                return False
        elif operator == "$options":
            continue
        else:  # pragma: no cover - guards against silently passing new operators
            raise NotImplementedError(f"Operator {operator} is not supported by the test double")
    return True


def _match_field(value, condition) -> bool:
    if isinstance(condition, dict) and any(key.startswith("$") for key in condition):
        return _match_operators(value, condition)
    if isinstance(value, list):
        return condition in value  # Mongo array-contains equality semantics
    return value == condition


def _matches(doc, query: dict) -> bool:
    for key, condition in query.items():
        if key == "$and":
            if not all(_matches(doc, sub) for sub in condition):
                return False
        elif key == "$or":
            if not any(_matches(doc, sub) for sub in condition):
                return False
        elif not _match_field(_field(doc, key), condition):
            return False
    return True


def _sort_key(value):
    """Order-preserving key that tolerates None (drafts have no posted_date)."""
    return (0, 0) if value is None else (1, value)


def _merge(conditions) -> dict:
    """Fold Beanie's varargs query form into one query dict.

    The service calls ``find_one(Doc.field == value, OTHER, NOT_DELETED)`` —
    several positional conditions ANDed together — as well as the single-dict
    form. Both land here.
    """
    merged: dict = {}
    for condition in conditions:
        if condition:
            merged.update(condition)
    return merged


class _ExprField:
    """Stand-in for the ``ExpressionField`` that ``init_beanie`` installs.

    Parts of the service build queries as ``Document.field == value`` instead of
    a literal dict. Those class attributes only exist once Beanie has
    initialised against a real motor client, which this suite deliberately never
    does — without a stand-in the comparison raises ``AttributeError``. Rendering
    to the same ``{field: value}`` dict keeps the query path identical.

    Not a descriptor, so instance attribute lookup still finds the real field
    value in the document's own ``__dict__``.
    """

    def __init__(self, name: str):
        self._name = name

    def __eq__(self, other):
        return {self._name: other}

    def __hash__(self):
        return hash(self._name)


class _FakeCursor:
    """The slice of Beanie's FindMany API the service chains onto."""

    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, *keys):
        for key in reversed(keys):
            descending = key.startswith("-")
            name = key.lstrip("-+")
            self._docs.sort(key=lambda doc: _sort_key(_field(doc, name)), reverse=descending)
        return self

    def skip(self, count: int):
        self._docs = self._docs[count:]
        return self

    def limit(self, count: int):
        self._docs = self._docs[:count]
        return self

    async def count(self) -> int:
        return len(self._docs)

    async def to_list(self, length=None):
        return list(self._docs)

    async def __aiter__(self):
        # `_to_response` streams the business-unit / department name lookups with
        # `async for` rather than `.to_list()`, so the cursor has to be an async
        # iterable as well as awaitable-by-method.
        for doc in self._docs:
            yield doc


class FakeMongo:
    """Seedable in-memory collections for the documents this module reads."""

    def __init__(self):
        self.announcements: list[AnnouncementDocument] = []
        self.employees: list[EmployeeDocument] = []
        self.business_units: list[BusinessUnitDocument] = []
        self.departments: list[DepartmentDocument] = []
        self.assets: list[AssetDocument] = []

    # -- seeding ---------------------------------------------------------
    def add_announcement(
        self,
        *,
        organisation_id: PydanticObjectId = ORG_A,
        title: str = "Quarterly update",
        description: str = "Body text",
        department_ids: list[PydanticObjectId] | None = None,
        business_unit_ids: list[PydanticObjectId] | None = None,
        status: AnnouncementStatusEnum = AnnouncementStatusEnum.DRAFT,
        posted_date: datetime | None = None,
        deleted_on: datetime | None = None,
        attachments: list[AnnouncementAttachment] | None = None,
        created_on: datetime | None = None,
    ) -> AnnouncementDocument:
        doc = AnnouncementDocument(
            organisation_id=organisation_id,
            business_unit_ids=business_unit_ids or [],
            department_ids=department_ids or [],
            title=title,
            description=description,
            attachments=attachments or [],
            status=status,
            posted_date=posted_date,
            published_by="seed-actor" if status == AnnouncementStatusEnum.PUBLISHED else None,
            is_active=deleted_on is None,
            created_by="seed-actor",
            created_on=created_on or datetime.now(timezone.utc),
            deleted_on=deleted_on,
        )
        doc.id = PydanticObjectId()
        self.announcements.append(doc)
        return doc

    def add_employee(
        self,
        user: UserBase,
        *,
        organisation_id: PydanticObjectId = ORG_A,
        department_id: PydanticObjectId | None = None,
        business_unit_id: PydanticObjectId | None = None,
    ) -> EmployeeDocument:
        doc = EmployeeDocument(
            organisation_id=organisation_id,
            user_id=PydanticObjectId(user.id),
            department_id=department_id,
            business_unit_id=business_unit_id,
        )
        doc.id = PydanticObjectId()
        self.employees.append(doc)
        return doc

    def add_department(
        self,
        department_id: PydanticObjectId,
        name: str,
        organisation_id=ORG_A,
        business_units: list[PydanticObjectId] | None = None,
    ):
        # Departments are business-unit scoped. An empty `business_units` means
        # unscoped, which `_validate_targets` allows under any unit.
        doc = DepartmentDocument(
            organisation_id=organisation_id,
            department_name=name,
            business_units=business_units or [],
        )
        doc.id = department_id
        self.departments.append(doc)
        return doc

    def add_business_unit(self, business_unit_id: PydanticObjectId, name: str, organisation_id=ORG_A):
        doc = BusinessUnitDocument(
            organisation_id=organisation_id,
            address_id=PydanticObjectId(),
            business_unit_name=name,
            date_of_incorporation=date(2020, 1, 1),
        )
        doc.id = business_unit_id
        self.business_units.append(doc)
        return doc

    def add_asset(self, asset_id: PydanticObjectId, file_name: str = "policy.pdf") -> AssetDocument:
        doc = AssetDocument(
            file_name=file_name,
            file_size=12,
            mime_type="application/pdf",
            storage_key=f"announcements/{asset_id}",
            file_url=f"https://cdn.example/{asset_id}",
            folder="announcements",
        )
        doc.id = asset_id
        self.assets.append(doc)
        return doc

    # -- fake driver -----------------------------------------------------
    def _find(self, bucket):
        def find(*args, **kwargs):
            return _FakeCursor(doc for doc in bucket if _matches(doc, _merge(args)))

        return find

    def _find_one(self, bucket):
        async def find_one(*args, **kwargs):
            query = _merge(args)
            for doc in bucket:
                if _matches(doc, query):
                    return doc
            return None

        return find_one

    def _get(self, bucket):
        async def get(document_id, *args, **kwargs):
            for doc in bucket:
                if doc.id == document_id:
                    return doc
            return None

        return get

    def _persist(self):
        bucket = self.announcements

        async def persist(doc, *args, **kwargs):
            if doc.id is None:
                doc.id = PydanticObjectId()
            if not any(existing is doc for existing in bucket):
                bucket.append(doc)
            return doc

        return persist

    def patches(self):
        persist = self._persist()
        # Beanie's Document.__init__ asserts the collection was initialised; these
        # tests never touch a real motor client, so stub the accessor out.
        collection = MagicMock()
        stubs = [
            patch.object(document, "get_motor_collection", lambda *args, **kwargs: collection)
            for document in (
                AnnouncementDocument,
                EmployeeDocument,
                BusinessUnitDocument,
                DepartmentDocument,
                AssetDocument,
            )
        ]
        # Class-level field expressions the service uses in place of query dicts.
        expression_fields = [
            patch.object(EmployeeDocument, "organisation_id",
                         _ExprField("organisation_id"), create=True),
            patch.object(EmployeeDocument, "user_id", _ExprField("user_id"), create=True),
        ]
        return stubs + expression_fields + [
            patch.object(AnnouncementDocument, "find", self._find(self.announcements)),
            patch.object(AnnouncementDocument, "find_one", self._find_one(self.announcements)),
            patch.object(AnnouncementDocument, "insert", persist),
            patch.object(AnnouncementDocument, "save", persist),
            patch.object(EmployeeDocument, "find_one", self._find_one(self.employees)),
            patch.object(BusinessUnitDocument, "find", self._find(self.business_units)),
            patch.object(DepartmentDocument, "find", self._find(self.departments)),
            # `_validate_attachments` counts assets before accepting them; the
            # dead module never checked, so this bucket had no `find` stub.
            patch.object(AssetDocument, "find", self._find(self.assets)),
            patch.object(AssetDocument, "get", self._get(self.assets)),
        ]


@pytest.fixture
def store():
    """In-memory document layer + a silenced audit outbox."""
    fake = FakeMongo()
    with ExitStack() as stack:
        for document_patch in fake.patches():
            stack.enter_context(document_patch)
        stack.enter_context(
            patch(
                "src.modules.announcements.service.outbox.publish_audit_log",
                new_callable=AsyncMock,
            )
        )
        yield fake


@pytest.fixture
def org_a_staff(store: FakeMongo):
    """The three employee shapes the targeting filter has to distinguish."""
    store.add_employee(STAFF_ENGINEERING, department_id=DEPT_ENGINEERING, business_unit_id=BU_NORTH)
    store.add_employee(STAFF_SALES, department_id=DEPT_SALES, business_unit_id=BU_SOUTH)
    store.add_employee(STAFF_UNASSIGNED)
    return store


def _published(**kwargs) -> dict:
    """Keyword defaults for a published announcement."""
    kwargs.setdefault("status", AnnouncementStatusEnum.PUBLISHED)
    kwargs.setdefault("posted_date", datetime.now(timezone.utc))
    return kwargs


async def _feed_titles(client: AsyncClient, headers: dict, query: str = "") -> list[str]:
    response = await client.get(f"{BASE}/my-announcements{query}", headers=headers)
    assert response.status_code == 200, response.text
    return [item["title"] for item in response.json()]


async def _list_titles(client: AsyncClient, headers: dict, query: str = "") -> list[str]:
    response = await client.get(f"{BASE}/{query}", headers=headers)
    assert response.status_code == 200, response.text
    return [item["title"] for item in response.json()["items"]]


# ---------------------------------------------------------------------------
# Admin list filters
# ---------------------------------------------------------------------------
class TestListFilters:
    """`department_id` / `business_unit_id` match an EXPLICIT target only.

    An org-wide announcement reaches every department and business unit, but it
    is not what an admin filtering for one of them is asking to see.
    """

    @pytest.fixture
    def targeted(self, store: FakeMongo) -> FakeMongo:
        store.add_announcement(title="Eng north", department_ids=[DEPT_ENGINEERING],
                               business_unit_ids=[BU_NORTH])
        store.add_announcement(title="Sales south", department_ids=[DEPT_SALES],
                               business_unit_ids=[BU_SOUTH])
        store.add_announcement(title="Eng south", department_ids=[DEPT_ENGINEERING],
                               business_unit_ids=[BU_SOUTH])
        store.add_announcement(title="Org wide")
        return store

    @pytest.mark.asyncio
    async def test_department_filter(
        self, client: AsyncClient, auth_headers: dict, targeted: FakeMongo
    ):
        with acting_as(ADMIN_A):
            titles = await _list_titles(
                client, auth_headers, f"?department_id={DEPT_ENGINEERING}"
            )
        assert sorted(titles) == ["Eng north", "Eng south"]

    @pytest.mark.asyncio
    async def test_business_unit_filter(
        self, client: AsyncClient, auth_headers: dict, targeted: FakeMongo
    ):
        with acting_as(ADMIN_A):
            titles = await _list_titles(
                client, auth_headers, f"?business_unit_id={BU_SOUTH}"
            )
        assert sorted(titles) == ["Eng south", "Sales south"]

    @pytest.mark.asyncio
    async def test_both_filters_are_combined_with_and(
        self, client: AsyncClient, auth_headers: dict, targeted: FakeMongo
    ):
        with acting_as(ADMIN_A):
            titles = await _list_titles(
                client,
                auth_headers,
                f"?department_id={DEPT_ENGINEERING}&business_unit_id={BU_NORTH}",
            )
        assert titles == ["Eng north"]

    @pytest.mark.asyncio
    async def test_business_unit_filter_reports_the_unpaged_total(
        self, client: AsyncClient, auth_headers: dict, targeted: FakeMongo
    ):
        """`total` counts the filtered set, not the whole organisation."""
        with acting_as(ADMIN_A):
            response = await client.get(
                f"{BASE}/?business_unit_id={BU_SOUTH}&limit=1", headers=auth_headers
            )
        body = response.json()
        assert body["total"] == 2
        assert len(body["items"]) == 1

    @pytest.mark.asyncio
    async def test_filters_never_reach_across_organisations(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_announcement(organisation_id=ORG_B, title="Org B north",
                               business_unit_ids=[BU_NORTH])

        with acting_as(ADMIN_A):
            titles = await _list_titles(
                client, auth_headers, f"?business_unit_id={BU_NORTH}"
            )
        assert titles == []

    @pytest.mark.asyncio
    async def test_filters_compose_with_search_and_status(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_announcement(**_published(title="Q3 results",
                                            business_unit_ids=[BU_NORTH]))
        store.add_announcement(title="Q3 draft", business_unit_ids=[BU_NORTH])
        store.add_announcement(**_published(title="Picnic",
                                            business_unit_ids=[BU_NORTH]))

        with acting_as(ADMIN_A):
            titles = await _list_titles(
                client,
                auth_headers,
                f"?business_unit_id={BU_NORTH}&status=published&search=q3",
            )
        assert titles == ["Q3 results"]


# ---------------------------------------------------------------------------
# Tenancy isolation
# ---------------------------------------------------------------------------
class TestTenancyIsolation:
    @pytest.mark.asyncio
    async def test_list_hides_other_orgs_announcements(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_announcement(organisation_id=ORG_A, title="Org A notice")
        store.add_announcement(organisation_id=ORG_B, title="Org B notice")

        with acting_as(ADMIN_B):
            response = await client.get(f"{BASE}/", headers=auth_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert [item["title"] for item in body["items"]] == ["Org B notice"]

    @pytest.mark.asyncio
    async def test_cross_org_get_returns_404_not_403(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """403 would confirm the row exists; the contract requires 404."""
        foreign = store.add_announcement(organisation_id=ORG_B)

        with acting_as(ADMIN_A):
            response = await client.get(f"{BASE}/{foreign.id}", headers=auth_headers)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_cross_org_patch_returns_404_not_403(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        foreign = store.add_announcement(organisation_id=ORG_B, title="Untouched")

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{foreign.id}", json={"title": "Hijacked"}, headers=auth_headers
            )

        assert response.status_code == 404
        assert foreign.title == "Untouched"

    @pytest.mark.asyncio
    async def test_cross_org_delete_returns_404_not_403(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        foreign = store.add_announcement(organisation_id=ORG_B)

        with acting_as(ADMIN_A):
            response = await client.delete(f"{BASE}/{foreign.id}", headers=auth_headers)

        assert response.status_code == 404
        assert foreign.deleted_on is None

    @pytest.mark.asyncio
    async def test_cross_org_publish_returns_404(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        foreign = store.add_announcement(organisation_id=ORG_B)

        with acting_as(ADMIN_A):
            response = await client.patch(f"{BASE}/{foreign.id}/publish", headers=auth_headers)

        assert response.status_code == 404
        assert foreign.status == AnnouncementStatusEnum.DRAFT

    @pytest.mark.asyncio
    async def test_super_admin_gets_no_implicit_cross_org_read(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """Being a super admin is not a licence to read another tenant's rows.

        `_get_doc` used to load by id and then delegate to `check_org_access`,
        which returns early for super admins — every organisation's
        announcements were readable and editable. The organisation is now part
        of the query, so a super admin sees exactly their own org's rows.
        """
        foreign = store.add_announcement(organisation_id=ORG_B, title="Org B only")

        with acting_as(SUPER_ADMIN, {}):     # organisation_id == ORG_A
            fetched = await client.get(f"{BASE}/{foreign.id}", headers=auth_headers)
            patched = await client.patch(
                f"{BASE}/{foreign.id}", json={"title": "Hijacked"}, headers=auth_headers
            )
            deleted = await client.delete(f"{BASE}/{foreign.id}", headers=auth_headers)

        assert fetched.status_code == 404
        assert patched.status_code == 404
        assert deleted.status_code == 404
        assert foreign.title == "Org B only"
        assert foreign.deleted_on is None

    @pytest.mark.asyncio
    async def test_super_admin_without_org_context_is_rejected_on_detail_routes(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """No org on the caller means no tenant to scope to — 403, not a wildcard."""
        doc = store.add_announcement(organisation_id=ORG_A)

        with acting_as(SUPER_ADMIN_NO_ORG, {}):
            response = await client.get(f"{BASE}/{doc.id}", headers=auth_headers)

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_cross_org_announcement_absent_from_employee_feed(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        foreign = org_a_staff.add_announcement(
            **_published(organisation_id=ORG_B, title="Org B broadcast")
        )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            titles = await _feed_titles(client, auth_headers)
            detail = await client.get(
                f"{BASE}/my-announcements/{foreign.id}", headers=auth_headers
            )

        assert titles == []
        assert detail.status_code == 404

    @pytest.mark.asyncio
    async def test_soft_deleted_returns_404_on_every_route(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        deleted = store.add_announcement(
            **_published(organisation_id=ORG_A, deleted_on=datetime.now(timezone.utc))
        )

        with acting_as(ADMIN_A):
            get_response = await client.get(f"{BASE}/{deleted.id}", headers=auth_headers)
            patch_response = await client.patch(
                f"{BASE}/{deleted.id}", json={"title": "New"}, headers=auth_headers
            )
            delete_response = await client.delete(f"{BASE}/{deleted.id}", headers=auth_headers)
            unpublish_response = await client.patch(
                f"{BASE}/{deleted.id}/unpublish", headers=auth_headers
            )
            list_response = await client.get(f"{BASE}/", headers=auth_headers)

        assert get_response.status_code == 404
        assert patch_response.status_code == 404
        assert delete_response.status_code == 404
        assert unpublish_response.status_code == 404
        assert list_response.json()["total"] == 0

    @pytest.mark.asyncio
    async def test_soft_deleted_returns_404_on_every_employee_route(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_asset(ASSET_ONE)
        org_a_staff.add_announcement(**_published(title="Live"))
        deleted = org_a_staff.add_announcement(
            **_published(
                title="Deleted",
                deleted_on=datetime.now(timezone.utc),
                attachments=[
                    AnnouncementAttachment(
                        asset_id=ASSET_ONE, file_name="a.pdf", mime_type="application/pdf", size=1
                    )
                ],
            )
        )

        with patch("src.storage.storage.download", return_value=b"bytes"):
            with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
                titles = await _feed_titles(client, auth_headers)
                detail = await client.get(
                    f"{BASE}/my-announcements/{deleted.id}", headers=auth_headers
                )
                download = await client.get(
                    f"{BASE}/my-announcements/{deleted.id}/attachments/{ASSET_ONE}/download",
                    headers=auth_headers,
                )

        assert titles == ["Live"]
        assert detail.status_code == 404
        assert download.status_code == 404

    @pytest.mark.asyncio
    async def test_body_organisation_id_is_ignored_on_create(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        with acting_as(ADMIN_A):
            response = await client.post(
                f"{BASE}/",
                json={
                    "title": "Planted",
                    "description": "Body",
                    "organisation_id": str(ORG_B),
                },
                headers=auth_headers,
            )

        assert response.status_code == 201
        assert response.json()["organisation_id"] == str(ORG_A)
        assert store.announcements[0].organisation_id == ORG_A

    @pytest.mark.asyncio
    async def test_body_organisation_id_is_ignored_on_update(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        own = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{own.id}",
                json={"title": "Renamed", "organisation_id": str(ORG_B)},
                headers=auth_headers,
            )

        assert response.status_code == 200
        assert response.json()["organisation_id"] == str(ORG_A)
        assert own.organisation_id == ORG_A


# ---------------------------------------------------------------------------
# The paged employee page (GET /my-announcements/all)
# ---------------------------------------------------------------------------
class TestMyAnnouncementsPage:
    """The "View all" page. Same visibility rules as the card, plus paging."""

    @pytest.fixture
    def feed(self, org_a_staff: FakeMongo) -> FakeMongo:
        base = datetime.now(timezone.utc)
        org_a_staff.add_announcement(
            **_published(title="All hands", posted_date=base - timedelta(days=1))
        )
        org_a_staff.add_announcement(
            **_published(
                title="Engineering sprint",
                department_ids=[DEPT_ENGINEERING],
                posted_date=base - timedelta(days=2),
            )
        )
        org_a_staff.add_announcement(
            **_published(
                title="Sales kickoff",
                department_ids=[DEPT_SALES],
                posted_date=base - timedelta(days=3),
            )
        )
        org_a_staff.add_announcement(title="Unpublished plan")
        return org_a_staff

    @staticmethod
    async def _page(client: AsyncClient, headers: dict, query: str = "") -> dict:
        response = await client.get(f"{BASE}/my-announcements/all{query}", headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    @pytest.mark.asyncio
    async def test_literal_all_is_not_taken_for_an_announcement_id(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        """Route order: `/all` must win over `/{announcement_id}`."""
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers)
        assert "items" in body and "total" in body

    @pytest.mark.asyncio
    async def test_page_honours_the_same_targeting_as_the_card(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers)
        assert [item["title"] for item in body["items"]] == [
            "All hands",
            "Engineering sprint",
        ]
        assert body["total"] == 2

        with acting_as(STAFF_SALES, VIEW_ONLY):
            body = await self._page(client, auth_headers)
        assert [item["title"] for item in body["items"]] == ["All hands", "Sales kickoff"]

    @pytest.mark.asyncio
    async def test_drafts_never_appear(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers)
        assert "Unpublished plan" not in [item["title"] for item in body["items"]]

    @pytest.mark.asyncio
    async def test_search_narrows_the_page_and_the_total(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers, "?search=sprint")
        assert [item["title"] for item in body["items"]] == ["Engineering sprint"]
        assert body["total"] == 1

    @pytest.mark.asyncio
    async def test_org_wide_scope_filter(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers, "?scope=org_wide")
        assert [item["title"] for item in body["items"]] == ["All hands"]

    @pytest.mark.asyncio
    async def test_targeted_scope_filter(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers, "?scope=targeted")
        assert [item["title"] for item in body["items"]] == ["Engineering sprint"]

    @pytest.mark.asyncio
    async def test_paging_keeps_the_unpaged_total(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            first = await self._page(client, auth_headers, "?limit=1")
            second = await self._page(client, auth_headers, "?limit=1&skip=1")
        assert first["total"] == second["total"] == 2
        assert [item["title"] for item in first["items"]] == ["All hands"]
        assert [item["title"] for item in second["items"]] == ["Engineering sprint"]

    @pytest.mark.asyncio
    async def test_page_is_guarded_by_view_announcements(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        """The admin-only grant does not open the employee page."""
        with acting_as(STAFF_ENGINEERING, MANAGE_ONLY):
            response = await client.get(f"{BASE}/my-announcements/all", headers=auth_headers)
        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_page_never_crosses_organisations(
        self, client: AsyncClient, auth_headers: dict, feed: FakeMongo
    ):
        feed.add_announcement(**_published(organisation_id=ORG_B, title="Org B all hands"))

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            body = await self._page(client, auth_headers)
        assert "Org B all hands" not in [item["title"] for item in body["items"]]


# ---------------------------------------------------------------------------
# Department / business-unit targeting
# ---------------------------------------------------------------------------
class TestEmployeeTargeting:
    @pytest.mark.asyncio
    async def test_empty_targeting_is_org_wide(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(**_published(title="Everyone"))

        for caller in (STAFF_ENGINEERING, STAFF_SALES, STAFF_UNASSIGNED, STAFF_NO_RECORD):
            with acting_as(caller, VIEW_ONLY):
                assert await _feed_titles(client, auth_headers) == ["Everyone"], caller.id

    @pytest.mark.asyncio
    async def test_department_targeting_excludes_other_departments(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(
            **_published(title="Engineering only", department_ids=[DEPT_ENGINEERING])
        )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Engineering only"]

        with acting_as(STAFF_SALES, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == []

    @pytest.mark.asyncio
    async def test_business_unit_targeting_excludes_other_units(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(
            **_published(title="North only", business_unit_ids=[BU_NORTH])
        )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["North only"]

        with acting_as(STAFF_SALES, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == []

    @pytest.mark.asyncio
    async def test_combined_targeting_requires_both_to_match(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        """Engineering ∧ South matches nobody seeded: the clauses are ANDed."""
        org_a_staff.add_announcement(
            **_published(
                title="Engineering in the South",
                department_ids=[DEPT_ENGINEERING],
                business_unit_ids=[BU_SOUTH],
            )
        )
        org_a_staff.add_announcement(
            **_published(
                title="Engineering in the North",
                department_ids=[DEPT_ENGINEERING],
                business_unit_ids=[BU_NORTH],
            )
        )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Engineering in the North"]

        with acting_as(STAFF_SALES, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == []

    @pytest.mark.asyncio
    async def test_multi_department_targeting_matches_any_listed_department(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(
            **_published(title="Both teams", department_ids=[DEPT_ENGINEERING, DEPT_SALES])
        )

        with acting_as(STAFF_SALES, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Both teams"]

    @pytest.mark.asyncio
    async def test_caller_without_employee_record_sees_only_org_wide(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(**_published(title="Everyone"))
        org_a_staff.add_announcement(
            **_published(title="Engineering only", department_ids=[DEPT_ENGINEERING])
        )
        org_a_staff.add_announcement(**_published(title="North only", business_unit_ids=[BU_NORTH]))

        with acting_as(STAFF_NO_RECORD, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Everyone"]

    @pytest.mark.asyncio
    async def test_employee_without_department_sees_only_org_wide(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(**_published(title="Everyone"))
        org_a_staff.add_announcement(
            **_published(title="Engineering only", department_ids=[DEPT_ENGINEERING])
        )

        with acting_as(STAFF_UNASSIGNED, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Everyone"]

    @pytest.mark.asyncio
    async def test_drafts_never_appear_in_feed(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_announcement(title="Org-wide draft")
        org_a_staff.add_announcement(title="Targeted draft", department_ids=[DEPT_ENGINEERING])
        org_a_staff.add_announcement(**_published(title="Published"))

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Published"]

    @pytest.mark.asyncio
    async def test_feed_is_ordered_by_posted_date_descending(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        now = datetime.now(timezone.utc)
        org_a_staff.add_announcement(**_published(title="Middle", posted_date=now - timedelta(days=2)))
        org_a_staff.add_announcement(**_published(title="Oldest", posted_date=now - timedelta(days=9)))
        org_a_staff.add_announcement(**_published(title="Newest", posted_date=now))

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Newest", "Middle", "Oldest"]

    @pytest.mark.asyncio
    async def test_feed_limit_is_honoured(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        now = datetime.now(timezone.utc)
        for index in range(6):
            org_a_staff.add_announcement(
                **_published(title=f"Notice {index}", posted_date=now - timedelta(hours=index))
            )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers, "?limit=2") == ["Notice 0", "Notice 1"]

    @pytest.mark.asyncio
    async def test_feed_default_limit_is_five(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        now = datetime.now(timezone.utc)
        for index in range(8):
            org_a_staff.add_announcement(
                **_published(title=f"Notice {index}", posted_date=now - timedelta(hours=index))
            )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert len(await _feed_titles(client, auth_headers)) == 5

    @pytest.mark.asyncio
    async def test_feed_limit_is_bounded_by_the_route(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        """`Query(le=100)` is the ONLY bound — the service applies none of its own.

        The shadowed module clamped a second time inside
        `list_my_announcements` (MY_ANNOUNCEMENTS_MAX_LIMIT = 20). The live one
        passes `limit` straight to the cursor, so the route's bound is
        load-bearing rather than belt-and-braces.
        """
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            accepted = await client.get(
                f"{BASE}/my-announcements?limit=100", headers=auth_headers
            )
            rejected = await client.get(
                f"{BASE}/my-announcements?limit=101", headers=auth_headers
            )

        assert accepted.status_code == 200
        assert rejected.status_code == 422

    @pytest.mark.asyncio
    async def test_service_applies_no_limit_of_its_own(self, org_a_staff: FakeMongo):
        """Called directly, the service honours whatever limit it is handed."""
        now = datetime.now(timezone.utc)
        for index in range(25):
            org_a_staff.add_announcement(
                **_published(title=f"Notice {index}", posted_date=now - timedelta(hours=index))
            )

        results = await announcement_service.list_my_announcements(
            caller=STAFF_ENGINEERING, limit=1000
        )

        assert len(results) == 25

    @pytest.mark.asyncio
    async def test_detail_route_404s_when_caller_is_not_targeted(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        targeted = org_a_staff.add_announcement(
            **_published(title="Engineering only", department_ids=[DEPT_ENGINEERING])
        )

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            allowed = await client.get(
                f"{BASE}/my-announcements/{targeted.id}", headers=auth_headers
            )
        with acting_as(STAFF_SALES, VIEW_ONLY):
            denied = await client.get(
                f"{BASE}/my-announcements/{targeted.id}", headers=auth_headers
            )

        assert allowed.status_code == 200
        assert denied.status_code == 404

    @pytest.mark.asyncio
    async def test_detail_route_404s_for_a_draft(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        draft = org_a_staff.add_announcement(title="Not yet")

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            response = await client.get(f"{BASE}/my-announcements/{draft.id}", headers=auth_headers)

        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
class TestAudienceCoherence:
    """A business unit and a department must be able to overlap.

    Targeting ANDs the two lists against the employee's own BU and department,
    so a department outside every selected business unit produces an audience of
    nobody — published successfully, delivered to no one.
    """

    @staticmethod
    async def _create(client: AsyncClient, headers: dict, bu_ids, dept_ids):
        return await client.post(
            f"{BASE}/",
            json={
                "title": "Notice",
                "description": "Body",
                "business_unit_ids": [str(b) for b in bu_ids],
                "department_ids": [str(d) for d in dept_ids],
            },
            headers=headers,
        )

    @pytest.mark.asyncio
    async def test_department_outside_the_selected_business_unit_is_rejected(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_business_unit(BU_NORTH, "North")
        store.add_business_unit(BU_SOUTH, "South")
        store.add_department(DEPT_SALES, "Sales", business_units=[BU_SOUTH])

        with acting_as(ADMIN_A):
            response = await self._create(client, auth_headers, [BU_NORTH], [DEPT_SALES])

        assert response.status_code == 400
        assert "Sales" in response.json()["detail"]
        assert store.announcements == []

    @pytest.mark.asyncio
    async def test_department_inside_the_selected_business_unit_is_accepted(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_business_unit(BU_NORTH, "North")
        store.add_department(DEPT_ENGINEERING, "Engineering", business_units=[BU_NORTH])

        with acting_as(ADMIN_A):
            response = await self._create(
                client, auth_headers, [BU_NORTH], [DEPT_ENGINEERING]
            )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_a_department_spanning_several_units_matches_any_of_them(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_business_unit(BU_NORTH, "North")
        store.add_business_unit(BU_SOUTH, "South")
        store.add_department(
            DEPT_ENGINEERING, "Engineering", business_units=[BU_NORTH, BU_SOUTH]
        )

        with acting_as(ADMIN_A):
            response = await self._create(
                client, auth_headers, [BU_SOUTH], [DEPT_ENGINEERING]
            )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_an_unscoped_department_is_allowed_under_any_unit(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """Empty `business_units` means unscoped — older rows stay addressable."""
        store.add_business_unit(BU_NORTH, "North")
        store.add_department(DEPT_SALES, "Sales")  # no business_units

        with acting_as(ADMIN_A):
            response = await self._create(client, auth_headers, [BU_NORTH], [DEPT_SALES])

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_departments_alone_are_not_constrained(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """With no business unit selected the announcement spans every unit."""
        store.add_department(DEPT_SALES, "Sales", business_units=[BU_SOUTH])

        with acting_as(ADMIN_A):
            response = await self._create(client, auth_headers, [], [DEPT_SALES])

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_the_same_rule_applies_on_update(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_business_unit(BU_NORTH, "North")
        store.add_department(DEPT_SALES, "Sales", business_units=[BU_SOUTH])
        draft = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{draft.id}",
                json={
                    "business_unit_ids": [str(BU_NORTH)],
                    "department_ids": [str(DEPT_SALES)],
                },
                headers=auth_headers,
            )

        assert response.status_code == 400
        assert draft.department_ids == []


class TestLifecycle:
    @pytest.mark.asyncio
    async def test_create_always_lands_in_draft(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        with acting_as(ADMIN_A):
            response = await client.post(
                f"{BASE}/",
                json={
                    "title": "Forced publish attempt",
                    "description": "Body",
                    "status": "published",
                    "posted_date": "2026-01-01T00:00:00Z",
                    "published_by": "someone-else",
                },
                headers=auth_headers,
            )

        assert response.status_code == 201
        body = response.json()
        assert body["status"] == "draft"
        assert body["posted_date"] is None
        assert body["published_by"] is None
        assert store.announcements[0].status == AnnouncementStatusEnum.DRAFT

    @pytest.mark.asyncio
    async def test_publish_stamps_posted_date_and_published_by(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        draft = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.patch(f"{BASE}/{draft.id}/publish", headers=auth_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "published"
        assert body["posted_date"] is not None
        assert body["published_by"] == ADMIN_A.id
        assert draft.status == AnnouncementStatusEnum.PUBLISHED

    @pytest.mark.asyncio
    async def test_republishing_is_idempotent_and_keeps_the_original_posted_date(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """The live module no-ops instead of 409ing (the shadowed one conflicted).

        The guarantee that matters either way is that `posted_date` is not
        re-stamped — a second publish must not silently move an announcement
        back to the top of every employee's feed.
        """
        posted = datetime.now(timezone.utc) - timedelta(days=1)
        published = store.add_announcement(**_published(organisation_id=ORG_A, posted_date=posted))

        with acting_as(ADMIN_A):
            response = await client.patch(f"{BASE}/{published.id}/publish", headers=auth_headers)

        assert response.status_code == 200
        assert published.posted_date == posted  # unchanged

    @pytest.mark.asyncio
    async def test_patching_a_published_announcement_conflicts(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        published = store.add_announcement(**_published(organisation_id=ORG_A, title="Original"))

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{published.id}", json={"title": "Edited"}, headers=auth_headers
            )

        assert response.status_code == 409
        assert published.title == "Original"

    @pytest.mark.asyncio
    async def test_patching_a_draft_succeeds(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        # `_validate_targets` rejects ids with no live row in the caller's org,
        # so the department has to exist before it can be targeted.
        store.add_department(DEPT_SALES, "Sales")
        draft = store.add_announcement(organisation_id=ORG_A, title="Original")

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{draft.id}",
                json={"title": "Edited", "department_ids": [str(DEPT_SALES)]},
                headers=auth_headers,
            )

        assert response.status_code == 200
        assert response.json()["title"] == "Edited"
        assert draft.department_ids == [DEPT_SALES]

    @pytest.mark.asyncio
    async def test_unpublish_returns_to_draft_and_clears_posted_date(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        published = store.add_announcement(**_published(organisation_id=ORG_A))

        with acting_as(ADMIN_A):
            response = await client.patch(f"{BASE}/{published.id}/unpublish", headers=auth_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "draft"
        assert body["posted_date"] is None
        assert published.posted_date is None

    @pytest.mark.asyncio
    async def test_unpublishing_a_draft_is_idempotent(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """Also a no-op rather than a 409 in the live module."""
        draft = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.patch(f"{BASE}/{draft.id}/unpublish", headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["status"] == "draft"
        assert draft.status == AnnouncementStatusEnum.DRAFT

    @pytest.mark.asyncio
    async def test_unpublished_announcement_leaves_the_employee_feed(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        published = org_a_staff.add_announcement(**_published(title="Live"))

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == ["Live"]
        with acting_as(ADMIN_A):
            await client.patch(f"{BASE}/{published.id}/unpublish", headers=auth_headers)
        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            assert await _feed_titles(client, auth_headers) == []

    @pytest.mark.asyncio
    async def test_delete_is_soft_and_row_survives(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        doc = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.delete(f"{BASE}/{doc.id}", headers=auth_headers)

        assert response.status_code == 204
        assert len(store.announcements) == 1          # row retained
        assert store.announcements[0].deleted_on is not None
        assert store.announcements[0].is_active is False
        assert store.announcements[0].created_by == "seed-actor"  # audit fields retained


# ---------------------------------------------------------------------------
# Permission split
# ---------------------------------------------------------------------------
ADMIN_ROUTES = [
    ("post", f"{BASE}/", {"title": "T", "description": "D"}),
    ("get", f"{BASE}/", None),
    ("get", f"{BASE}/{{id}}", None),
    ("patch", f"{BASE}/{{id}}", {"title": "T"}),
    ("patch", f"{BASE}/{{id}}/publish", None),
    ("patch", f"{BASE}/{{id}}/unpublish", None),
    ("delete", f"{BASE}/{{id}}", None),
    ("get", f"{BASE}/{{id}}/attachments/{ASSET_ONE}/download", None),
]


class TestPermissionSplit:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
    async def test_view_only_caller_is_forbidden_on_admin_routes(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo, method, path, body
    ):
        doc = store.add_announcement(organisation_id=ORG_A)
        url = path.format(id=doc.id)

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            kwargs = {"headers": auth_headers}
            if body is not None:
                kwargs["json"] = body
            response = await getattr(client, method)(url, **kwargs)

        assert response.status_code == 403
        assert response.json()["code"] == "FORBIDDEN"

    @pytest.mark.asyncio
    async def test_caller_with_no_grants_is_forbidden(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, None):
            admin = await client.get(f"{BASE}/", headers=auth_headers)
            feed = await client.get(f"{BASE}/my-announcements", headers=auth_headers)

        assert admin.status_code == 403
        assert feed.status_code == 403

    @pytest.mark.asyncio
    async def test_manage_only_caller_reaches_admin_routes(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        doc = store.add_announcement(organisation_id=ORG_A)

        with acting_as(STAFF_ENGINEERING, MANAGE_ONLY):
            listed = await client.get(f"{BASE}/", headers=auth_headers)
            fetched = await client.get(f"{BASE}/{doc.id}", headers=auth_headers)
            created = await client.post(
                f"{BASE}/", json={"title": "T", "description": "D"}, headers=auth_headers
            )
            published = await client.patch(f"{BASE}/{doc.id}/publish", headers=auth_headers)

        assert listed.status_code == 200
        assert fetched.status_code == 200
        assert created.status_code == 201
        assert published.status_code == 200

    @pytest.mark.asyncio
    async def test_manage_only_caller_is_forbidden_on_the_employee_feed(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        with acting_as(STAFF_ENGINEERING, MANAGE_ONLY):
            response = await client.get(f"{BASE}/my-announcements", headers=auth_headers)

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_org_admin_bypasses_both_guards(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """Same model as tests/test_authorization.py: admins never hit the grid."""
        store.add_announcement(**_published(organisation_id=ORG_A))

        with acting_as(ADMIN_A, {}):
            admin = await client.get(f"{BASE}/", headers=auth_headers)
            feed = await client.get(f"{BASE}/my-announcements", headers=auth_headers)

        assert admin.status_code == 200
        assert feed.status_code == 200

    @pytest.mark.asyncio
    async def test_super_admin_bypasses_both_guards(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_announcement(**_published(organisation_id=ORG_A))

        with acting_as(SUPER_ADMIN, {}):
            admin = await client.get(f"{BASE}/", headers=auth_headers)
            feed = await client.get(f"{BASE}/my-announcements", headers=auth_headers)

        assert admin.status_code == 200
        assert feed.status_code == 200

    @pytest.mark.asyncio
    async def test_caller_without_org_context_is_rejected(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """Passing the guard is not enough — the service still needs a tenant."""
        with acting_as(SUPER_ADMIN_NO_ORG, {}):
            response = await client.get(f"{BASE}/", headers=auth_headers)

        assert response.status_code == 403


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------
class TestAttachments:
    @pytest.mark.asyncio
    async def test_untargeted_employee_cannot_download_attachment(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        """A valid announcement_id + asset_id pair is not entitlement."""
        org_a_staff.add_asset(ASSET_ONE)
        targeted = org_a_staff.add_announcement(
            **_published(
                department_ids=[DEPT_ENGINEERING],
                attachments=[
                    AnnouncementAttachment(
                        asset_id=ASSET_ONE, file_name="policy.pdf", mime_type="application/pdf", size=12
                    )
                ],
            )
        )

        with patch("src.storage.storage.download", return_value=b"file-bytes") as download:
            with acting_as(STAFF_SALES, VIEW_ONLY):
                response = await client.get(
                    f"{BASE}/my-announcements/{targeted.id}/attachments/{ASSET_ONE}/download",
                    headers=auth_headers,
                )

        assert response.status_code == 404
        download.assert_not_called()

    @pytest.mark.asyncio
    async def test_targeted_employee_can_download_attachment(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_asset(ASSET_ONE)
        targeted = org_a_staff.add_announcement(
            **_published(
                department_ids=[DEPT_ENGINEERING],
                attachments=[
                    AnnouncementAttachment(
                        asset_id=ASSET_ONE, file_name="policy.pdf", mime_type="application/pdf", size=12
                    )
                ],
            )
        )

        with patch("src.storage.storage.download", return_value=b"file-bytes"):
            with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
                response = await client.get(
                    f"{BASE}/my-announcements/{targeted.id}/attachments/{ASSET_ONE}/download",
                    headers=auth_headers,
                )

        assert response.status_code == 200
        assert response.content == b"file-bytes"

    @pytest.mark.asyncio
    async def test_employee_cannot_download_an_asset_from_another_announcement(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_asset(ASSET_TWO)
        visible = org_a_staff.add_announcement(**_published(title="Everyone"))
        org_a_staff.add_announcement(
            **_published(
                title="Engineering only",
                department_ids=[DEPT_SALES],
                attachments=[
                    AnnouncementAttachment(
                        asset_id=ASSET_TWO, file_name="secret.pdf", mime_type="application/pdf", size=9
                    )
                ],
            )
        )

        with patch("src.storage.storage.download", return_value=b"secret"):
            with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
                response = await client.get(
                    f"{BASE}/my-announcements/{visible.id}/attachments/{ASSET_TWO}/download",
                    headers=auth_headers,
                )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_admin_cannot_download_a_cross_org_attachment(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_asset(ASSET_ONE)
        foreign = store.add_announcement(
            organisation_id=ORG_B,
            attachments=[
                AnnouncementAttachment(
                    asset_id=ASSET_ONE, file_name="policy.pdf", mime_type="application/pdf", size=12
                )
            ],
        )

        with patch("src.storage.storage.download", return_value=b"file-bytes"):
            with acting_as(ADMIN_A):
                response = await client.get(
                    f"{BASE}/{foreign.id}/attachments/{ASSET_ONE}/download", headers=auth_headers
                )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_attachments_are_replaced_wholesale_by_patch(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """There is no attach / detach route — the whole list travels on PATCH.

        The shadowed module exposed POST and DELETE `/{id}/attachments`; the
        live one has neither, so the FE sends the full set it wants to keep and
        the service validates every asset id against the assets collection.
        """
        store.add_asset(ASSET_ONE)
        store.add_asset(ASSET_TWO, file_name="b.pdf")
        doc = store.add_announcement(
            organisation_id=ORG_A,
            attachments=[
                AnnouncementAttachment(
                    asset_id=ASSET_ONE, file_name="a.pdf", mime_type="application/pdf", size=1
                ),
            ],
        )

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{doc.id}",
                json={
                    "attachments": [
                        {
                            "asset_id": str(ASSET_TWO),
                            "file_name": "b.pdf",
                            "mime_type": "application/pdf",
                            "size": 2,
                        }
                    ]
                },
                headers=auth_headers,
            )
            refetched = await client.get(f"{BASE}/{doc.id}", headers=auth_headers)

        assert response.status_code == 200
        assert [att["asset_id"] for att in response.json()["attachments"]] == [str(ASSET_TWO)]
        assert [att["asset_id"] for att in refetched.json()["attachments"]] == [str(ASSET_TWO)]

    @pytest.mark.asyncio
    async def test_patching_an_unknown_asset_id_is_rejected(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """`_validate_attachments` refuses asset ids with no row behind them."""
        doc = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.patch(
                f"{BASE}/{doc.id}",
                json={
                    "attachments": [
                        {
                            "asset_id": str(ASSET_TWO),
                            "file_name": "ghost.pdf",
                            "mime_type": "application/pdf",
                            "size": 1,
                        }
                    ]
                },
                headers=auth_headers,
            )

        assert response.status_code == 400


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------
class TestResponseShape:
    @pytest.mark.asyncio
    async def test_target_names_are_empty_arrays_for_an_org_wide_announcement(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        doc = store.add_announcement(organisation_id=ORG_A)

        with acting_as(ADMIN_A):
            response = await client.get(f"{BASE}/{doc.id}", headers=auth_headers)

        body = response.json()
        assert body["business_unit_names"] == []
        assert body["department_names"] == []
        assert body["business_unit_ids"] == []
        assert body["department_ids"] == []

    @pytest.mark.asyncio
    async def test_target_names_are_resolved_for_a_targeted_announcement(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_department(DEPT_ENGINEERING, "Engineering")
        store.add_business_unit(BU_NORTH, "North")
        doc = store.add_announcement(
            organisation_id=ORG_A,
            department_ids=[DEPT_ENGINEERING],
            business_unit_ids=[BU_NORTH],
        )

        with acting_as(ADMIN_A):
            response = await client.get(f"{BASE}/{doc.id}", headers=auth_headers)

        body = response.json()
        assert body["department_names"] == ["Engineering"]
        assert body["business_unit_names"] == ["North"]

    @pytest.mark.asyncio
    async def test_a_foreign_target_name_is_not_echoed_back(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        """Name resolution is scoped to the announcement's own organisation.

        `_validate_targets` blocks foreign ids on write, but rows predating it
        (or written by any path around it) must not leak the other tenant's
        name on read. The id still comes back — it is already on the row — but
        the name it resolves to does not.
        """
        store.add_department(DEPT_ENGINEERING, "Org B Engineering", organisation_id=ORG_B)
        store.add_business_unit(BU_NORTH, "Org B North", organisation_id=ORG_B)
        doc = store.add_announcement(
            organisation_id=ORG_A,
            department_ids=[DEPT_ENGINEERING],
            business_unit_ids=[BU_NORTH],
        )

        with acting_as(ADMIN_A):
            response = await client.get(f"{BASE}/{doc.id}", headers=auth_headers)

        body = response.json()
        assert body["department_names"] == []
        assert body["business_unit_names"] == []
        assert body["department_ids"] == [str(DEPT_ENGINEERING)]

    @pytest.mark.asyncio
    async def test_list_response_carries_names_and_unpaged_total(
        self, client: AsyncClient, auth_headers: dict, store: FakeMongo
    ):
        store.add_department(DEPT_ENGINEERING, "Engineering")
        now = datetime.now(timezone.utc)
        for index in range(3):
            store.add_announcement(
                organisation_id=ORG_A,
                title=f"Notice {index}",
                department_ids=[DEPT_ENGINEERING],
                created_on=now - timedelta(hours=index),
            )

        with acting_as(ADMIN_A):
            response = await client.get(f"{BASE}/?limit=2", headers=auth_headers)

        body = response.json()
        assert body["total"] == 3          # unpaged count
        assert len(body["items"]) == 2     # paged items
        assert all(item["department_names"] == ["Engineering"] for item in body["items"])

    @pytest.mark.asyncio
    async def test_feed_response_carries_names(
        self, client: AsyncClient, auth_headers: dict, org_a_staff: FakeMongo
    ):
        org_a_staff.add_department(DEPT_ENGINEERING, "Engineering")
        org_a_staff.add_announcement(**_published(department_ids=[DEPT_ENGINEERING]))

        with acting_as(STAFF_ENGINEERING, VIEW_ONLY):
            response = await client.get(f"{BASE}/my-announcements", headers=auth_headers)

        assert response.status_code == 200
        assert response.json()[0]["department_names"] == ["Engineering"]
        assert response.json()[0]["business_unit_names"] == []
