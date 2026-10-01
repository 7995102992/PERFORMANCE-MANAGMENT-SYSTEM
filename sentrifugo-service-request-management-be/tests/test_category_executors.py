"""Category executor roster — resolvers, schema validation, membership checks.

Covers the primary/secondary roster added to `Category`: the two resolvers that
decide who holds the department-head powers, the schema guards, and the runtime
membership helpers that read them. All hermetic — the department-head fallback
is patched out so nothing here touches IAM.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from beanie import PydanticObjectId

from src.categories.schemas import MAX_EXECUTORS, CategoryCreate, CategoryUpdate
from src.categories.service import resolve_primaries, resolve_workforce
from src.models import Category, CategoryExecutor, ExecutorRoleEnum

ORG = PydanticObjectId()
BU = PydanticObjectId()
DEPT = PydanticObjectId()

HEAD = str(PydanticObjectId())
PRIMARY = str(PydanticObjectId())
SECONDARY = str(PydanticObjectId())
OUTSIDER = str(PydanticObjectId())


def _executor(user_id: str, role: ExecutorRoleEnum) -> CategoryExecutor:
    return CategoryExecutor(user_id=PydanticObjectId(user_id), role=role, name="X")


def _category(
    executors: list[CategoryExecutor] | None = None,
    *,
    exclusive: bool = False,
    department_ids: list | None = None,
) -> Category:
    depts = department_ids if department_ids is not None else [DEPT]
    return Category(
        organisation_id=ORG,
        name="Roster Cat",
        name_lc="roster cat",
        department_ids=depts,
        # Dual-written mirror, exactly as create_category writes it (D12).
        department_id=depts[0] if depts else None,
        business_unit_id=BU,
        executors=executors or [],
        roster_is_exclusive=exclusive,
    )


# ---------- resolve_primaries / resolve_workforce ----------


class TestResolvePrimaries:
    def test_empty_roster_is_just_the_head(self):
        """D4 — a category with no roster behaves exactly as it does today."""
        assert resolve_primaries(_category(), HEAD) == {HEAD}

    def test_primaries_only(self):
        cat = _category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        assert resolve_primaries(cat, HEAD) == {PRIMARY}

    def test_secondaries_are_not_primaries(self):
        cat = _category(
            [
                _executor(PRIMARY, ExecutorRoleEnum.PRIMARY),
                _executor(SECONDARY, ExecutorRoleEnum.SECONDARY),
            ]
        )
        assert resolve_primaries(cat, HEAD) == {PRIMARY}

    def test_head_absent_from_roster_holds_nothing(self):
        """The roster is the whole statement of who manages the category.

        A head who should hold the primary powers is picked as a primary like
        anyone else; leaving them off is now a decision, not an oversight the
        code quietly corrects. (This asserted the opposite under D3.)
        """
        cat = _category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        assert HEAD not in resolve_primaries(cat, HEAD)

    def test_all_secondary_roster_still_falls_back_to_the_head(self):
        """Pre-validation documents must not end up unmanageable.

        The schema now rejects a roster with no primary, but categories saved
        before that rule exist (8 of them on QA). Rather than leave those with
        nobody able to assign or reassign, they keep the legacy head fallback
        until the reconcile script gives them a primary.
        """
        cat = _category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        assert resolve_primaries(cat, HEAD) == {HEAD}

    def test_no_head_leaves_configured_primaries(self):
        cat = _category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        assert resolve_primaries(cat, None) == {PRIMARY}

    def test_no_head_no_roster_is_empty(self):
        assert resolve_primaries(_category(), None) == set()


class TestResolveWorkforce:
    def test_empty_roster_falls_back_to_the_department(self):
        cat = _category()
        assert resolve_workforce(cat, HEAD, [SECONDARY, OUTSIDER]) == {
            SECONDARY,
            OUTSIDER,
            HEAD,
        }

    def test_a_roster_replaces_the_department(self):
        """D8 removed — a roster is the whole pool, whatever the flag says.

        Was `test_roster_adds_to_the_department_by_default`, asserting
        `{SECONDARY, OUTSIDER}` because the departments were unioned in unless
        `roster_is_exclusive` was set. The flag no longer decides anything: the
        people an admin picked are the people who work the category, so a new
        joiner needs a roster edit rather than arriving in the pool for free.
        """
        cat = _category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        workforce = resolve_workforce(cat, HEAD, [OUTSIDER])
        assert workforce == {SECONDARY}
        assert OUTSIDER not in workforce
        assert HEAD not in workforce

    def test_the_stored_flag_no_longer_changes_the_answer(self):
        """Both values of the retired flag resolve identically.

        The field is still accepted and stored for back-compat, so this pins
        the thing that actually matters: nothing reads it. A category saved
        long ago with `False` must not keep the wide pool alive.
        """
        roster = [_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)]
        off = resolve_workforce(_category(roster), HEAD, [OUTSIDER])
        on = resolve_workforce(
            _category(roster, exclusive=True), HEAD, [OUTSIDER]
        )
        assert off == on == {SECONDARY}

    def test_the_flag_is_ignored_without_a_roster_too(self):
        cat = _category([], exclusive=True)
        assert resolve_workforce(cat, HEAD, [OUTSIDER]) == {OUTSIDER, HEAD}

    def test_heads_only_count_where_no_roster_exists(self):
        """Once a roster exists, heading a department grants nothing.

        A head who belongs to one of the category's departments still qualifies
        — as a department member, via `dept_member_ids`, exactly like everyone
        else. Heading a department they are not a member of no longer does, and
        IAM permits precisely that (7 QA heads sit outside their own dept).
        """
        head_2 = str(PydanticObjectId())
        cat = _category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        assert resolve_workforce(cat, [HEAD, head_2], []) == {SECONDARY}
        # Same heads, no roster — the legacy shape is untouched.
        assert resolve_workforce(_category(), [HEAD, head_2], []) == {HEAD, head_2}

    def test_both_roles_are_workforce(self):
        cat = _category(
            [
                _executor(PRIMARY, ExecutorRoleEnum.PRIMARY),
                _executor(SECONDARY, ExecutorRoleEnum.SECONDARY),
            ]
        )
        assert resolve_workforce(cat, HEAD, []) == {PRIMARY, SECONDARY}


# ---------- schema guards ----------


class TestExecutorSchema:
    def _payload(self, executors: list[dict]) -> dict:
        return {
            "name": "Cat",
            "business_unit_id": str(BU),
            "department_id": str(DEPT),
            "executors": executors,
        }

    def test_duplicate_user_id_rejected(self):
        payload = self._payload(
            [
                {"user_id": PRIMARY, "role": "primary"},
                {"user_id": PRIMARY, "role": "secondary"},
            ]
        )
        with pytest.raises(Exception, match="only once"):
            CategoryCreate(**payload)

    def test_over_cap_rejected(self):
        payload = self._payload(
            [
                {"user_id": str(PydanticObjectId()), "role": "secondary"}
                for _ in range(MAX_EXECUTORS + 1)
            ]
        )
        with pytest.raises(Exception, match="At most"):
            CategoryCreate(**payload)

    def test_role_defaults_to_secondary(self):
        # A primary rides along because a roster with none is now rejected; the
        # entry under test is the one that omits `role`.
        body = CategoryCreate(
            **self._payload(
                [
                    {"user_id": PRIMARY, "role": "primary"},
                    {"user_id": SECONDARY},
                ]
            )
        )
        assert body.executors[1].role == ExecutorRoleEnum.SECONDARY

    def test_roster_without_a_primary_rejected(self):
        payload = self._payload([{"user_id": SECONDARY, "role": "secondary"}])
        with pytest.raises(Exception, match="at least one primary"):
            CategoryCreate(**payload)

    def test_empty_roster_still_accepted(self):
        """Empty is not an incomplete roster — it is D4, the legacy default."""
        body = CategoryCreate(**self._payload([]))
        assert body.executors == []

    def test_update_omitting_executors_leaves_them_unset(self):
        body = CategoryUpdate(name="Renamed")
        assert "executors" not in body.model_dump(exclude_unset=True)

    def test_update_can_clear_the_roster(self):
        body = CategoryUpdate(executors=[])
        assert body.executors == []
        assert "executors" in body.model_dump(exclude_unset=True)


# ---------- runtime membership checks ----------


@pytest.fixture
def not_dept_head():
    """Every fallback path answers 'no', so only the roster can grant access."""
    with patch(
        "src.requests.service_detail._is_dept_head_of_ticket",
        new_callable=AsyncMock,
        return_value=False,
    ) as m:
        yield m


@pytest.fixture
def is_dept_head():
    with patch(
        "src.requests.service_detail._is_dept_head_of_ticket",
        new_callable=AsyncMock,
        return_value=True,
    ) as m:
        yield m


async def _saved_category(
    executors: list[CategoryExecutor],
    *,
    exclusive: bool = False,
    department_ids: list | None = None,
) -> Category:
    cat = _category(executors, exclusive=exclusive, department_ids=department_ids)
    await cat.insert()
    return cat


def _ticket(cat: Category) -> SimpleNamespace:
    return SimpleNamespace(category_id=cat.id)


def _user(
    user_id: str,
    *,
    manager: bool = False,
    department_id: str | None = None,
) -> SimpleNamespace:
    """A minimal UserBase stand-in.

    `manager=True` grants the org-wide `service_request` editor acl — the one
    the roster is supposed to override (D7), so it's the interesting case.
    """
    return SimpleNamespace(
        id=user_id,
        is_super_admin=False,
        access_token=None,
        department_id=department_id,
        permissions=(
            {"service_request": {"acl": "editor", "actions": {}}} if manager else {}
        ),
    )


@pytest.mark.asyncio
class TestIsCategoryPrimary:
    async def test_configured_primary_passes_without_iam(self, not_dept_head):
        from src.requests.service_detail import _is_category_primary

        cat = await _saved_category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        try:
            assert await _is_category_primary(_ticket(cat), _user(PRIMARY)) is True
            # A roster hit is answered from Mongo — no department lookup at all.
            not_dept_head.assert_not_awaited()
        finally:
            await cat.delete()

    async def test_secondary_is_not_primary(self, not_dept_head):
        from src.requests.service_detail import _is_category_primary

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            assert await _is_category_primary(_ticket(cat), _user(SECONDARY)) is False
        finally:
            await cat.delete()

    async def test_head_off_roster_is_not_primary(self, is_dept_head):
        """A roster naming a primary is the whole answer — heads add nothing.

        `is_dept_head` would return True for this caller; the point is that the
        helper no longer reaches the question.
        """
        from src.requests.service_detail import _is_category_primary

        cat = await _saved_category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        try:
            assert await _is_category_primary(_ticket(cat), _user(HEAD)) is False
            is_dept_head.assert_not_awaited()
        finally:
            await cat.delete()

    async def test_all_secondary_roster_still_delegates_to_the_head(
        self, is_dept_head
    ):
        """No configured primary — fall back rather than strand the category."""
        from src.requests.service_detail import _is_category_primary

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            assert await _is_category_primary(_ticket(cat), _user(HEAD)) is True
            is_dept_head.assert_awaited()
        finally:
            await cat.delete()

    async def test_empty_roster_delegates_to_dept_head(self, is_dept_head):
        from src.requests.service_detail import _is_category_primary

        cat = await _saved_category([])
        try:
            assert await _is_category_primary(_ticket(cat), _user(HEAD)) is True
            is_dept_head.assert_awaited()
        finally:
            await cat.delete()

    async def test_missing_category_is_false(self, not_dept_head):
        from src.requests.service_detail import _is_category_primary

        ghost = SimpleNamespace(category_id=PydanticObjectId())
        assert await _is_category_primary(ghost, _user(PRIMARY)) is False


@pytest.mark.asyncio
class TestAssertTargetInWorkforce:
    """Assigning someone else must match what the executor picker offers."""

    @staticmethod
    def _head_patch():
        return patch(
            "src.requests.service_assign._ticket_dept_head_ids",
            new_callable=AsyncMock,
            return_value=[HEAD],
        )

    async def test_no_roster_allows_anyone(self):
        from src.exceptions import DomainException
        from src.requests.service_assign import _assert_target_in_workforce

        cat = await _saved_category([])
        try:
            with self._head_patch():
                # Legacy categories keep today's rule — no new rejection.
                await _assert_target_in_workforce(_ticket(cat), OUTSIDER, _user(HEAD))
        except DomainException as exc:  # pragma: no cover - guards a regression
            pytest.fail(f"legacy category should not restrict assignment: {exc}")
        finally:
            await cat.delete()

    async def test_roster_member_allowed(self):
        from src.requests.service_assign import _assert_target_in_workforce

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            with self._head_patch():
                await _assert_target_in_workforce(
                    _ticket(cat), SECONDARY, _user(HEAD)
                )
        finally:
            await cat.delete()

    async def test_head_off_roster_is_rejected_as_a_target(self):
        """Assigning to a head who is neither rostered nor a department member.

        Under D3 this was allowed on the strength of the headship alone. The
        roster now decides, so this is an ineligible target like any other —
        the fix is to put them on the roster, not to special-case them.
        """
        from src.exceptions import DomainException
        from src.requests.service_assign import _assert_target_in_workforce

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            with self._head_patch():
                with pytest.raises(DomainException):
                    await _assert_target_in_workforce(
                        _ticket(cat), HEAD, _user(PRIMARY)
                    )
        finally:
            await cat.delete()

    async def test_outsider_rejected(self):
        from src.exceptions import DomainException
        from src.requests.service_assign import _assert_target_in_workforce

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            with self._head_patch():
                with pytest.raises(DomainException) as exc:
                    await _assert_target_in_workforce(
                        _ticket(cat), OUTSIDER, _user(HEAD)
                    )
            assert exc.value.code == "EXECUTOR_INVALID"
        finally:
            await cat.delete()


@pytest.mark.asyncio
class TestIsCategoryWorkforce:
    async def test_secondary_is_workforce(self, not_dept_head):
        from src.requests.service_detail import _is_category_workforce

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            assert await _is_category_workforce(_ticket(cat), _user(SECONDARY)) is True
        finally:
            await cat.delete()

    async def test_outsider_is_excluded_once_a_roster_exists(self, not_dept_head):
        from src.requests.service_detail import _is_category_workforce

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        try:
            assert await _is_category_workforce(_ticket(cat), _user(OUTSIDER)) is False
        finally:
            await cat.delete()

    async def test_outsider_is_excluded_by_an_exclusive_roster(self, not_dept_head):
        from src.requests.service_detail import _is_category_workforce

        cat = await _saved_category(
            [_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)], exclusive=True
        )
        with patch(
            "src.requests.service_detail._is_dept_member_of_ticket",
            new_callable=AsyncMock,
            return_value=True,
        ) as member:
            try:
                assert (
                    await _is_category_workforce(_ticket(cat), _user(OUTSIDER)) is False
                )
                # D8 on short-circuits before the department is even consulted.
                member.assert_not_awaited()
            finally:
                await cat.delete()

    async def test_department_member_is_refused_by_any_roster(self, not_dept_head):
        """D8 removed — a roster shuts the department out regardless of the flag.

        Was `test_department_member_passes_a_non_exclusive_roster`, which
        asserted `True`: with the flag off, plain department membership was
        enough to execute. It no longer is. The department is consulted only
        where no roster exists at all, so this must short-circuit before
        `_is_dept_member_of_ticket` — the same way the exclusive case above
        always did.
        """
        from src.requests.service_detail import _is_category_workforce

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        with patch(
            "src.requests.service_detail._is_dept_member_of_ticket",
            new_callable=AsyncMock,
            return_value=True,
        ) as member:
            try:
                assert (
                    await _is_category_workforce(_ticket(cat), _user(OUTSIDER)) is False
                )
                member.assert_not_awaited()
            finally:
                await cat.delete()

    async def test_empty_roster_falls_back_to_department_membership(
        self, not_dept_head
    ):
        from src.requests.service_detail import _is_category_workforce

        cat = await _saved_category([])
        with patch(
            "src.requests.service_detail._is_dept_member_of_ticket",
            new_callable=AsyncMock,
            return_value=True,
        ):
            try:
                assert (
                    await _is_category_workforce(_ticket(cat), _user(OUTSIDER)) is True
                )
            finally:
                await cat.delete()


@pytest.fixture
def not_dept_member():
    with patch(
        "src.requests.service_detail._is_dept_member_of_ticket",
        new_callable=AsyncMock,
        return_value=False,
    ) as m:
        yield m


@pytest.mark.asyncio
class TestRosterOverridesTheManagerAcl:
    """D7 — the load-bearing rule.

    `service_request` grants `editor` to essentially every employee in this
    platform, so `is_manager()` is universally true. If the ACL stayed in the
    `or` alongside the roster, every employee would keep self-assign and
    reassign on every category and the roster would be decorative.
    """

    async def test_manager_off_roster_cannot_act_or_manage(
        self, not_dept_head, not_dept_member
    ):
        from src.requests.service_detail import (
            _can_act_as_executor,
            _can_manage_ticket,
        )

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        mgr = _user(OUTSIDER, manager=True, department_id=str(DEPT))
        try:
            assert await _can_act_as_executor(_ticket(cat), mgr) is False
            assert await _can_manage_ticket(_ticket(cat), mgr) is False
        finally:
            await cat.delete()

    async def test_secondary_acts_but_does_not_manage(
        self, not_dept_head, not_dept_member
    ):
        from src.requests.service_detail import (
            _can_act_as_executor,
            _can_manage_ticket,
        )

        cat = await _saved_category([_executor(SECONDARY, ExecutorRoleEnum.SECONDARY)])
        who = _user(SECONDARY)
        try:
            assert await _can_act_as_executor(_ticket(cat), who) is True
            assert await _can_manage_ticket(_ticket(cat), who) is False
        finally:
            await cat.delete()

    async def test_primary_does_both(self, not_dept_head, not_dept_member):
        from src.requests.service_detail import (
            _can_act_as_executor,
            _can_manage_ticket,
        )

        cat = await _saved_category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        who = _user(PRIMARY)
        try:
            assert await _can_act_as_executor(_ticket(cat), who) is True
            assert await _can_manage_ticket(_ticket(cat), who) is True
        finally:
            await cat.delete()

    async def test_department_head_off_roster_does_neither(
        self, is_dept_head, not_dept_member
    ):
        """The head is an ordinary candidate for the roster, not a shortcut.

        This caller heads one of the category's departments but is neither
        rostered nor a member of it — the combination IAM permits and several
        QA heads are actually in. Under D3 they held both powers; the roster
        now decides, so they hold neither until someone puts them on it.
        """
        from src.requests.service_detail import (
            _can_act_as_executor,
            _can_manage_ticket,
        )

        cat = await _saved_category([_executor(PRIMARY, ExecutorRoleEnum.PRIMARY)])
        who = _user(HEAD)
        try:
            assert await _can_act_as_executor(_ticket(cat), who) is False
            assert await _can_manage_ticket(_ticket(cat), who) is False
        finally:
            await cat.delete()

    async def test_department_head_on_the_roster_does_both(
        self, is_dept_head, not_dept_member
    ):
        """The route that replaces D3 — pick the head as a primary."""
        from src.requests.service_detail import (
            _can_act_as_executor,
            _can_manage_ticket,
        )

        cat = await _saved_category([_executor(HEAD, ExecutorRoleEnum.PRIMARY)])
        who = _user(HEAD)
        try:
            assert await _can_act_as_executor(_ticket(cat), who) is True
            assert await _can_manage_ticket(_ticket(cat), who) is True
        finally:
            await cat.delete()

    async def test_no_roster_keeps_the_manager_acl(
        self, not_dept_head, not_dept_member
    ):
        """D4 — every category that exists today is untouched by the override."""
        from src.requests.service_detail import (
            _can_act_as_executor,
            _can_manage_ticket,
        )

        cat = await _saved_category([])
        mgr = _user(OUTSIDER, manager=True, department_id=str(DEPT))
        try:
            assert await _can_act_as_executor(_ticket(cat), mgr) is True
            assert await _can_manage_ticket(_ticket(cat), mgr) is True
        finally:
            await cat.delete()

    async def test_manager_of_another_department_is_still_denied(
        self, not_dept_head, not_dept_member
    ):
        """The ACL is org-wide; `_is_manager_of_ticket` pins it to the ticket."""
        from src.requests.service_detail import _can_manage_ticket

        cat = await _saved_category([])
        mgr = _user(OUTSIDER, manager=True, department_id=str(PydanticObjectId()))
        try:
            assert await _can_manage_ticket(_ticket(cat), mgr) is False
        finally:
            await cat.delete()

    async def test_manager_of_any_selected_department_qualifies(
        self, not_dept_head, not_dept_member
    ):
        """A category spans departments now — belonging to one of them is enough."""
        from src.requests.service_detail import _can_manage_ticket

        other = PydanticObjectId()
        cat = await _saved_category([], department_ids=[other, DEPT])
        mgr = _user(OUTSIDER, manager=True, department_id=str(DEPT))
        try:
            assert await _can_manage_ticket(_ticket(cat), mgr) is True
        finally:
            await cat.delete()
