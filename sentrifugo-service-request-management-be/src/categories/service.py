"""Category service layer — Chapters 1 + 2."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

from beanie.operators import And

from ..audit import emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.email_resolver import resolve_user_info
from ..common.names import normalize_name, search_regex, to_name_lc
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow
from ..exceptions import (
    BusinessUnitDepartmentMismatch,
    CategoryHasRequestTypes,
    CategoryNameExists,
    CategoryNotFound,
    DepartmentNotFound,
    ExecutorNotInDepartment,
)
from ..common.iam_helpers import try_oid
from ..integrations.iam_client import get_iam_client
from ..models import (
    Category,
    CategoryExecutor,
    ExecutorRoleEnum,
    RequestType,
    StatusEnum,
)
from .schemas import CategoryCreate, CategoryExecutorIn, CategoryUpdate


async def _ensure_dept_in_org(department_id, user: UserBase) -> dict:
    """Load the department from IAM and assert it belongs to the caller's org.

    Returns the department doc so callers can also inspect its business units.
    """
    iam = get_iam_client()
    dept = await iam.get_department(str(department_id), access_token=user.access_token)
    if not dept:
        raise DepartmentNotFound()
    if not user.is_super_admin:
        dept_org = str(dept.get("organisation_id") or dept.get("organisationId") or "")
        if dept_org != user.organisation_id:
            raise DepartmentNotFound()
    return dept


def _dept_business_units(dept: dict) -> set[str]:
    """The set of business unit ids a department belongs to (camel/snake)."""
    raw = dept.get("business_units") or dept.get("businessUnits") or []
    return {str(b) for b in raw}


async def _ensure_bu_and_depts(business_unit_id, department_ids, user: UserBase) -> None:
    """Every department must be in the caller's org AND belong to the BU.

    The business unit is the category's main link; the departments only select
    which employee pools staff it. One department outside the BU invalidates the
    whole payload rather than being dropped silently — a silently ignored
    department would leave its employees unrosterable with no explanation.
    """
    for department_id in department_ids or []:
        dept = await _ensure_dept_in_org(department_id, user)
        if str(business_unit_id) not in _dept_business_units(dept):
            raise BusinessUnitDepartmentMismatch()


def category_department_ids(cat: Category) -> list:
    """Departments for a category, tolerating un-migrated documents.

    Documents written before the multi-department change carry only the scalar
    `department_id`; the backfill that fills `department_ids` is a separate
    step. Every consumer goes through here so a category read before the
    migration runs still resolves its department instead of behaving as if it
    had none (no executor pool, no escalation target, no queue).
    """
    if cat.department_ids:
        return list(cat.department_ids)
    return [cat.department_id] if cat.department_id else []


async def _ensure_visibility_scope(
    business_unit_ids, department_ids, user: UserBase
) -> None:
    """Validate a restricted category's multi-BU / multi-department scope.

    Mirrors the cascade enforced in the UI: every selected department must
    belong to *every* selected business unit (the intersection the dropdown
    offers). Each department is also checked to be in the caller's org.
    """
    bu_ids = {str(b) for b in (business_unit_ids or [])}
    for did in {str(d) for d in (department_ids or [])}:
        dept = await _ensure_dept_in_org(did, user)
        dept_bus = _dept_business_units(dept)
        if not bu_ids.issubset(dept_bus):
            raise BusinessUnitDepartmentMismatch()


_DEPT_PAGE_SIZE = 100
_DEPT_MAX_PAGES = 20  # 2000 employees — far past any real department


def _dept_head_id(dept: dict | None) -> str | None:
    """The department's head user id, across IAM's three spellings."""
    if not dept:
        return None
    return str(
        dept.get("head_user_id")
        or dept.get("department_head")
        or dept.get("departmentHead")
        or ""
    ) or None


async def _one_department_employees(department_id, user: UserBase) -> dict[str, dict]:
    """``{user_id: employee}`` for one department, paged past IAM's 100-row cap.

    Roster validation must see the *whole* department: a single capped page
    would reject employee 101 as "not in the department" purely because they
    fell off the end of the list.
    """
    iam = get_iam_client()
    out: dict[str, dict] = {}
    skip = 0
    for _ in range(_DEPT_MAX_PAGES):
        page = await iam.list_employees(
            access_token=user.access_token,
            department_id=str(department_id),
            skip=skip,
            limit=_DEPT_PAGE_SIZE,
        )
        for emp in page or []:
            uid = str(emp.get("userId") or emp.get("user_id") or emp.get("id") or "")
            if uid:
                out.setdefault(uid, emp)
        if not page or len(page) < _DEPT_PAGE_SIZE:
            break
        skip += _DEPT_PAGE_SIZE
    return out


async def _department_employees(department_ids, user: UserBase) -> dict[str, dict]:
    """``{user_id: employee}`` across every department, fetched concurrently.

    Someone belonging to two of the category's departments appears once; the
    first department wins, which only affects the department label shown against
    them. Departments are fetched in parallel because a category spanning four
    of them would otherwise pay four sequential round-trips on every save.
    """
    ids = [str(d) for d in (department_ids or [])]
    if not ids:
        return {}
    pages = await asyncio.gather(
        *(_one_department_employees(did, user) for did in ids),
        return_exceptions=True,
    )
    out: dict[str, dict] = {}
    for did, page in zip(ids, pages):
        if isinstance(page, BaseException):
            logger.warning("department_employees.failed dept=%s", did, exc_info=page)
            raise page
        for uid, emp in page.items():
            # Stamp which department this row was found under — the employee row
            # itself may carry a different one for a head, and the UI groups by it.
            out.setdefault(uid, {**emp, "_srm_department_id": did})
    return out


async def _department_meta(department_ids, user: UserBase) -> dict[str, dict]:
    """``{department_id: {"name", "code", "head_user_id"}}``, fetched once."""
    iam = get_iam_client()
    ids = [str(d) for d in (department_ids or [])]
    if not ids:
        return {}
    docs = await asyncio.gather(
        *(iam.get_department(did, access_token=user.access_token) for did in ids),
        return_exceptions=True,
    )
    out: dict[str, dict] = {}
    for did, doc in zip(ids, docs):
        if isinstance(doc, BaseException) or not doc:
            out[did] = {"name": "", "code": "", "head_user_id": None}
            continue
        out[did] = {
            "name": doc.get("department_name")
            or doc.get("departmentName")
            or doc.get("name")
            or "",
            "code": doc.get("department_code") or doc.get("departmentCode") or "",
            "head_user_id": _dept_head_id(doc),
        }
    return out


def _employee_contact(emp: dict) -> tuple[str | None, str, str, str]:
    """(employee_id, emp_code, name, email) from an IAM employee row."""
    name = " ".join(
        part
        for part in (
            emp.get("firstName") or emp.get("first_name") or "",
            emp.get("lastName") or emp.get("last_name") or "",
        )
        if part
    ).strip()
    email = emp.get("email") or emp.get("workEmail") or emp.get("work_email") or ""
    emp_code = str(emp.get("empCode") or emp.get("emp_code") or "")
    return (
        (str(emp.get("id")) if emp.get("id") else None),
        emp_code,
        name,
        email,
    )


async def _resolve_executors(
    executors: list[CategoryExecutorIn] | None,
    department_ids,
    user: UserBase,
) -> list[CategoryExecutor]:
    """Validate a roster against the departments and snapshot display fields.

    Every entry must be a member of one of the category's departments — the
    department heads included, even though a head's employee record may point
    elsewhere (the same quirk `assign_executor` works around when checking
    self-assign).

    Unlike `_resolve_recipient_contacts`, a missing address is **not** fatal
    here. That function hard-fails because an SLA breach email is unrecoverable
    once missed; an executor with no address is still a perfectly valid
    executor, so the snapshot just degrades to "".
    """
    if not executors:
        return []

    members = await _department_employees(department_ids, user)
    meta = await _department_meta(department_ids, user)
    head_ids = {m["head_user_id"] for m in meta.values() if m["head_user_id"]}
    # A head whose employee record sits in another department still belongs to
    # the department they run, so pin them to it for the display snapshot.
    head_dept_of = {
        m["head_user_id"]: did for did, m in meta.items() if m["head_user_id"]
    }

    resolved: list[CategoryExecutor] = []
    needs_lookup: list[CategoryExecutor] = []
    for entry in executors:
        uid = str(entry.user_id)
        emp = members.get(uid)
        if emp is None and uid not in head_ids:
            raise ExecutorNotInDepartment()
        employee_id, emp_code, name, email = (
            _employee_contact(emp) if emp else (None, "", "", "")
        )
        dept_id = (emp or {}).get("_srm_department_id") or head_dept_of.get(uid)
        dept_meta = meta.get(str(dept_id) if dept_id else "", {})
        row = CategoryExecutor(
            user_id=entry.user_id,
            role=entry.role,
            employee_id=employee_id,
            emp_code=emp_code,
            name=name,
            email=email,
            department_id=try_oid(dept_id) if dept_id else None,
            department_code=dept_meta.get("code", ""),
            department_name=dept_meta.get("name", ""),
        )
        resolved.append(row)
        if not email:
            needs_lookup.append(row)

    # Only the stragglers cost an IAM round-trip, and they go out together.
    if needs_lookup:
        infos = await asyncio.gather(
            *(
                resolve_user_info(str(row.user_id), access_token=user.access_token)
                for row in needs_lookup
            ),
            return_exceptions=True,
        )
        for row, info in zip(needs_lookup, infos):
            if isinstance(info, dict):
                row.email = info.get("email") or ""
                row.name = row.name or info.get("name") or ""
    return resolved


async def _prune_executors(
    executors: list[CategoryExecutor] | None,
    department_ids,
    user: UserBase,
) -> list[CategoryExecutor]:
    """Drop the executors who belong to none of the remaining departments.

    Membership is re-checked against IAM rather than read off each row's stored
    `department_id`: that field is a display label recording where the person
    was *first* found, so somebody who belongs to two of the category's
    departments would be pruned along with whichever one happens to be stamped
    on them. Survivors are re-stamped so the label follows a department that
    still exists.
    """
    if not executors:
        return []
    members = await _department_employees(department_ids, user)
    meta = await _department_meta(department_ids, user)
    head_dept_of = {
        m["head_user_id"]: did for did, m in meta.items() if m["head_user_id"]
    }
    kept: list[CategoryExecutor] = []
    for e in executors:
        uid = str(e.user_id)
        dept_id = (members.get(uid) or {}).get("_srm_department_id") or head_dept_of.get(uid)
        if not dept_id:
            continue
        dept_meta = meta.get(str(dept_id), {})
        kept.append(
            e.model_copy(
                update={
                    "department_id": try_oid(dept_id),
                    "department_code": dept_meta.get("code", ""),
                    "department_name": dept_meta.get("name", ""),
                }
            )
        )
    return kept


def resolve_primaries(
    cat: Category, dept_head_ids: str | list[str] | set[str] | None
) -> set[str]:
    """User ids holding the department-head powers on this category.

    NO PRODUCTION CALLER as of the escalation change — `_eligible_escalation_
    targets` was the last one and now reads the roster directly, because the
    head fallback below is precisely what it needed to stop doing. Kept because
    the tests pin the resolver contract, and because a caller that genuinely
    wants the legacy shape may return.

    Do not reach for this to answer "who are the primaries?" — it answers "who
    holds the primary powers, falling back to the heads", which is a different
    question and the one that let an off-roster head keep receiving escalations.
    Read `cat.executors` directly, or use `_is_category_primary`.

    The configured primaries, and nobody else. A head who is meant to hold these
    powers is picked as a primary like anyone else — the roster is the whole
    statement of who manages the category, so a head left off it manages
    nothing. (D3 previously unioned the heads in unconditionally; the roster now
    says who, and the schema's at-least-one-primary rule is what guarantees the
    answer is never empty.)

    Falls back to the heads only when the roster names no primary at all: an
    empty roster is legacy (D4), and a roster carrying only secondaries is a
    pre-validation document that would otherwise be left with nobody able to
    assign or reassign.
    """
    ids = {
        str(e.user_id)
        for e in (cat.executors or [])
        if e.role == ExecutorRoleEnum.PRIMARY
    }
    if ids:
        return ids
    return _as_id_set(dept_head_ids)


def resolve_workforce(
    cat: Category,
    dept_head_ids: str | list[str] | set[str] | None,
    dept_member_ids: list[str] | set[str] | None = None,
) -> set[str]:
    """User ids allowed to execute this category's tickets.

    The whole roster, primary and secondary alike — and nobody else. With no
    roster at all the department members and heads are the whole answer (D4),
    which is the legacy shape kept alive for categories that predate the roster.

    `roster_is_exclusive` (D8) used to decide whether the departments counted on
    top, defaulting to off — every member of the selected departments could
    execute, so a new joiner needed no roster edit. That is gone: the roster is
    the authoritative answer to "who works this category", and a flag whose
    default silently widened the pool past the people an admin actually picked
    contradicted the model everywhere else. The field is still stored and still
    accepted on the API for back-compat; it is simply no longer read here, so a
    category saved with `false` becomes roster-only with no migration.

    A department head qualifies only by being rostered. Heading a department is
    not a grant in itself — a head is an ordinary candidate for the roster now.
    The heads still come in unconditionally where no roster exists.

    `dept_member_ids` now only affects the no-roster branch. Callers no longer
    need to fetch members when a roster exists.
    """
    roster = {str(e.user_id) for e in (cat.executors or [])}
    members = {str(m) for m in (dept_member_ids or [])}
    if not roster:
        return members | _as_id_set(dept_head_ids)
    return set(roster)


def _as_id_set(value: str | list[str] | set[str] | None) -> set[str]:
    """Accept a single id or a collection — callers have both shapes."""
    if not value:
        return set()
    if isinstance(value, str):
        return {value}
    return {str(v) for v in value if v}


def _effective_visibility_bus(cat: Category) -> set[str]:
    """BUs a restricted category is visible to.

    The home business unit always has visibility; the scope array only adds
    *other* business units on top of it.
    """
    ids = {str(b) for b in (cat.visibility_business_unit_ids or [])}
    if cat.business_unit_id:
        ids.add(str(cat.business_unit_id))
    return ids


def _effective_visibility_depts(cat: Category) -> set[str]:
    """Departments a restricted category is visible to.

    The category's own departments always have visibility; the scope array only
    adds *other* departments on top of them.
    """
    ids = {str(d) for d in (cat.visibility_department_ids or [])}
    ids |= {str(d) for d in category_department_ids(cat)}
    return ids


def _can_view_all_categories(user: UserBase) -> bool:
    """Super admins and catalog managers see every category (incl. restricted).

    is_org_admin and manage_workflows are intentionally excluded: both are broad
    flags that don't grant category visibility scope. Only is_super_admin and
    explicit manage_catalog permission bypass the BU/dept restriction filter.
    """
    return bool(
        user.is_super_admin
        or user.has_permission("service_request", "manage_catalog")
    )


def _visibility_clause(user: UserBase) -> dict:
    """Mongo $or clause limiting restricted categories to the caller's BU+dept.

    Unrestricted categories are always visible. A restricted category is only
    visible when the caller's IAM business unit AND department both match.
    """
    allow: list[dict] = [{"restricted_visibility": {"$ne": True}}]
    bu = try_oid(user.business_unit_id) if user.business_unit_id else None
    dept = try_oid(user.department_id) if user.department_id else None
    if bu and dept:
        # A restricted category matches when the caller's BU AND department are
        # each in scope. The home business_unit_id / department_id always count
        # as in scope (they always have visibility); the scope arrays add any
        # other teams on top.
        allow.append(
            {
                "restricted_visibility": True,
                "$and": [
                    {"$or": [
                        {"business_unit_id": bu},
                        {"visibility_business_unit_ids": bu},
                    ]},
                    {"$or": [
                        # department_ids is an array; a bare equality matches
                        # any element. department_id is the deprecated scalar,
                        # still matched so un-migrated documents stay visible.
                        {"department_ids": dept},
                        {"department_id": dept},
                        {"visibility_department_ids": dept},
                    ]},
                ],
            }
        )
    return {"$or": allow}


def _user_can_access_category(user: UserBase, cat: Category) -> bool:
    """Hard gate for raising requests against a (possibly restricted) category."""
    if not cat.restricted_visibility:
        return True
    if user.is_super_admin or user.is_org_admin:
        return True
    return bool(
        user.business_unit_id
        and user.department_id
        and str(user.business_unit_id) in _effective_visibility_bus(cat)
        and str(user.department_id) in _effective_visibility_depts(cat)
    )


async def _find_by_name(organisation_id: str, name_lc: str) -> Category | None:
    return await Category.find_one(
        {"organisation_id": organisation_id, "name_lc": name_lc, "deleted_on": None}
    )


def _to_out(
    cat: Category,
    dept_names: dict[str, str] | None = None,
    bu_name: str | None = None,
    head_ids: set[str] | None = None,
) -> dict[str, Any]:
    dept_ids = [str(d) for d in category_department_ids(cat)]
    names = dept_names or {}
    heads = head_ids or set()
    return {
        "id": str(cat.id),
        "organisation_id": str(cat.organisation_id),
        "name": cat.name,
        "description": cat.description,
        "department_ids": dept_ids,
        "department_names": [names.get(d, "") for d in dept_ids],
        # Deprecated scalars, emitted so consumers still reading them keep
        # working while they migrate to the lists above.
        "department_id": dept_ids[0] if dept_ids else None,
        "department_name": names.get(dept_ids[0]) if dept_ids else None,
        "business_unit_id": str(cat.business_unit_id),
        "business_unit_name": bu_name,
        "restricted_visibility": bool(cat.restricted_visibility),
        "visibility_business_unit_ids": [
            str(b) for b in (cat.visibility_business_unit_ids or [])
        ],
        "visibility_department_ids": [
            str(d) for d in (cat.visibility_department_ids or [])
        ],
        "executors": [
            {
                "user_id": str(e.user_id),
                "role": e.role,
                "employee_id": e.employee_id,
                "emp_code": e.emp_code,
                "name": e.name,
                "email": e.email,
                "department_id": str(e.department_id) if e.department_id else None,
                "department_code": e.department_code,
                "department_name": e.department_name,
                # Locked in the UI: heads hold the primary powers implicitly, so
                # they can't be removed or re-tagged.
                "is_department_head": str(e.user_id) in heads,
            }
            for e in (cat.executors or [])
        ],
        "roster_is_exclusive": bool(cat.roster_is_exclusive),
        "status": cat.status,
        "created_by": str(cat.created_by) if cat.created_by else None,
        "created_on": cat.created_on,
        "modified_by": str(cat.modified_by) if cat.modified_by else None,
        "modified_on": cat.modified_on,
    }


async def _resolve_dept_names(dept_ids: list, access_token: str | None = None) -> dict[str, str]:
    """Batch resolve department IDs to names via IAM. Keyed by *string* id."""
    names, _ = await _resolve_dept_names_and_heads(dept_ids, access_token=access_token)
    return names


async def _resolve_dept_names_and_heads(
    dept_ids: list, access_token: str | None = None
) -> tuple[dict[str, str], set[str]]:
    """``({department_id: name}, {head_user_id})`` for a set of departments.

    Names and heads come from the same IAM document, so fetching them together
    halves the round-trips on a list page. Keys are strings — callers hold a mix
    of ObjectId and str, and a dict keyed by ObjectId silently misses every
    string lookup.
    """
    iam = get_iam_client()
    names: dict[str, str] = {}
    heads: set[str] = set()
    for did in {str(d) for d in dept_ids if d}:
        try:
            dept = await iam.get_department(did, access_token=access_token)
        except Exception:  # noqa: BLE001
            continue
        if not dept:
            continue
        names[did] = (
            dept.get("department_name")
            or dept.get("departmentName")
            or dept.get("name")
            or ""
        )
        head = _dept_head_id(dept)
        if head:
            heads.add(head)
    return names, heads


def _all_department_ids(cats: list[Category]) -> list:
    """Every department referenced by any of these categories."""
    out: list = []
    for c in cats:
        out.extend(category_department_ids(c))
    return out


async def _resolve_bu_names(bu_ids: list, access_token: str | None = None) -> dict[Any, str]:
    """Batch resolve business unit IDs to names via IAM (best-effort)."""
    iam = get_iam_client()
    names: dict[Any, str] = {}
    for bid in set(b for b in bu_ids if b):
        try:
            bu = await iam.get_business_unit(str(bid), access_token=access_token)
            if bu:
                names[bid] = (
                    bu.get("business_unit_name")
                    or bu.get("businessUnitName")
                    or bu.get("name")
                    or ""
                )
        except Exception:
            pass
    return names


async def _to_out_one(cat: Category, user: UserBase) -> dict[str, Any]:
    """`_to_out` for a single category, resolving its IAM labels first.

    The detail responses all need the same three lookups (department names,
    department heads, business unit name); doing them in one place keeps the
    head-derived `is_department_head` flag consistent across create / get /
    update instead of only on the pages that remembered to pass it.
    """
    dept_names, head_ids = await _resolve_dept_names_and_heads(
        category_department_ids(cat), access_token=user.access_token
    )
    bu_names = await _resolve_bu_names(
        [cat.business_unit_id] if cat.business_unit_id else [],
        access_token=user.access_token,
    )
    return _to_out(cat, dept_names, bu_names.get(cat.business_unit_id), head_ids)


async def create_category(body: CategoryCreate, user: UserBase) -> dict[str, Any]:
    name = normalize_name(body.name)
    name_lc = to_name_lc(name)

    existing = await _find_by_name(user.org_oid, name_lc)
    if existing is not None:
        raise CategoryNameExists()

    await _ensure_bu_and_depts(body.business_unit_id, body.department_ids, user)

    # Only persist a visibility scope for restricted categories; org-wide ones
    # ignore any scope the client may have sent.
    visibility_bus = body.visibility_business_unit_ids if body.restricted_visibility else []
    visibility_depts = body.visibility_department_ids if body.restricted_visibility else []
    if body.restricted_visibility:
        await _ensure_visibility_scope(visibility_bus, visibility_depts, user)

    executors = await _resolve_executors(body.executors, body.department_ids, user)

    now = utcnow()
    cat = Category(
        organisation_id=user.organisation_id,
        name=name,
        name_lc=name_lc,
        description=body.description,
        department_ids=body.department_ids,
        # Deprecated mirror, dual-written so un-migrated readers keep working.
        department_id=body.department_ids[0],
        business_unit_id=body.business_unit_id,
        restricted_visibility=body.restricted_visibility,
        visibility_business_unit_ids=visibility_bus,
        visibility_department_ids=visibility_depts,
        executors=executors,
        roster_is_exclusive=body.roster_is_exclusive,
        status=StatusEnum.ACTIVE,
        created_by=user.id,
        created_on=now,
    )
    await cat.insert()
    # Fire-and-forget audit.
    try:
        await emit_audit(
            event="category.created",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(cat.id), "name": cat.name},
        )
    except Exception:  # noqa: BLE001
        pass
    return await _to_out_one(cat, user)


async def list_categories(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    status: str = "active",
    department_id: str | None = None,
    business_unit_id: str | None = None,
    has_active_workflow: bool = False,
) -> dict[str, Any]:
    filt: dict[str, Any] = {"organisation_id": user.org_oid, "deleted_on": None}
    if status and status != "all":
        filt["status"] = status
    # Accumulate $or-bearing clauses under $and so the free-text search and the
    # visibility scope don't clobber each other at the top level.
    and_clauses: list[dict] = []
    if department_id:
        # Match the array (bare equality hits any element) or the deprecated
        # scalar, so the filter still finds un-migrated categories.
        _d = try_oid(department_id)
        and_clauses.append({"$or": [{"department_ids": _d}, {"department_id": _d}]})
    if business_unit_id:
        filt["business_unit_id"] = try_oid(business_unit_id)
    # Escaped + length-capped: a raw needle in $regex both widens the match and
    # lets a pathological pattern burn CPU (see common.names.search_regex).
    q_lc = search_regex((q or "").lower())
    if q_lc:
        and_clauses.append({"$or": [
            {"name_lc": {"$regex": q_lc, "$options": "i"}},
            {"description": {"$regex": q_lc, "$options": "i"}},
        ]})
    # Non-managers only see unrestricted categories plus restricted ones that
    # match their own business unit + department.
    if not _can_view_all_categories(user):
        and_clauses.append(_visibility_clause(user))
    if and_clauses:
        filt["$and"] = and_clauses
    # Lets the Raise-Request slider only offer categories that actually have
    # an active workflow to handle them (avoids NoActiveWorkflow on submit).
    # Doesn't require manage_workflows perm — any reader of /categories can
    # use this filter.
    if has_active_workflow:
        from ..models import Workflow
        wfs = await Workflow.find({
            "organisation_id": user.org_oid,
            "status": "active",
            "deleted_on": None,
        }).to_list()
        active_cat_ids = list({w.category_id for w in wfs})
        if not active_cat_ids:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        # Filter by string category_ids; intersect with any existing filter.
        existing = filt.get("_id")
        from bson import ObjectId as _OID
        active_oids: list[Any] = []
        for cid in active_cat_ids:
            try:
                active_oids.append(_OID(cid))
            except Exception:
                active_oids.append(cid)
        if existing is None:
            filt["_id"] = {"$in": active_oids}
        elif isinstance(existing, dict) and "$in" in existing:
            inter = [o for o in existing["$in"] if o in active_oids]
            filt["_id"] = {"$in": inter or ["__none__"]}

    skip = compute_skip(p)
    total = await Category.find(filt).count()
    # Active categories first, then inactive ones; newest first within each
    # group. StatusEnum only holds "active"/"inactive", so an ascending sort on
    # status already puts active ahead of inactive.
    items = (
        await Category.find(filt)
        .sort("+status", "-created_on")
        .skip(skip)
        .limit(p.page_size)
        .to_list()
    )
    dept_names, head_ids = await _resolve_dept_names_and_heads(
        _all_department_ids(items), access_token=user.access_token
    )
    bu_names = await _resolve_bu_names(
        [c.business_unit_id for c in items if c.business_unit_id],
        access_token=user.access_token,
    )
    return {
        "items": [
            _to_out(c, dept_names, bu_names.get(c.business_unit_id), head_ids)
            for c in items
        ],
        "total": total,
        "page": p.page,
        "page_size": p.page_size,
    }


async def export_categories(
    user: UserBase,
    *,
    q: str | None = None,
    status: str = "active",
    department_id: str | None = None,
    business_unit_id: str | None = None,
) -> bytes:
    """Build an xlsx workbook of the current category list and return its bytes.

    Honors the same q / status / department_id / business_unit_id filters and
    visibility scoping as list_categories but ignores pagination — exports
    every matching row.
    """
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    filt: dict[str, Any] = {"organisation_id": user.org_oid, "deleted_on": None}
    if status and status != "all":
        filt["status"] = status
    if business_unit_id:
        filt["business_unit_id"] = try_oid(business_unit_id)
    and_clauses: list[dict] = []
    if department_id:
        # Match either shape: department_ids is an array (a bare equality hits
        # any element) and department_id is the deprecated scalar still present
        # on un-migrated documents.
        _d = try_oid(department_id)
        and_clauses.append({"$or": [{"department_ids": _d}, {"department_id": _d}]})
    # Escaped + length-capped: a raw needle in $regex both widens the match and
    # lets a pathological pattern burn CPU (see common.names.search_regex).
    q_lc = search_regex((q or "").lower())
    if q_lc:
        and_clauses.append({"$or": [
            {"name_lc": {"$regex": q_lc, "$options": "i"}},
            {"description": {"$regex": q_lc, "$options": "i"}},
        ]})
    if not _can_view_all_categories(user):
        and_clauses.append(_visibility_clause(user))
    if and_clauses:
        filt["$and"] = and_clauses

    # Same ordering as the list endpoint: active rows first, then inactive,
    # newest first within each group.
    items = await Category.find(filt).sort("+status", "-created_on").to_list()
    dept_names = await _resolve_dept_names(
        _all_department_ids(items), access_token=user.access_token
    )
    bu_names = await _resolve_bu_names(
        [c.business_unit_id for c in items if c.business_unit_id],
        access_token=user.access_token,
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Categories"
    headers = [
        "Name", "Description", "Business Unit", "Departments",
        "Primary Executors", "Secondary Executors",
        "Visibility", "Status", "Created",
    ]
    ws.append(headers)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="334155")
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    def _roster_names(cat: Category, role: ExecutorRoleEnum) -> str:
        return ", ".join(
            e.name or str(e.user_id)
            for e in (cat.executors or [])
            if e.role == role
        )

    def _dept_labels(cat: Category) -> str:
        # dept_names is keyed by *string* id — category_department_ids returns
        # ObjectIds, and an ObjectId lookup silently misses every entry.
        return ", ".join(
            dept_names.get(str(d)) or str(d) for d in category_department_ids(cat)
        )

    for c in items:
        ws.append([
            c.name,
            c.description or "",
            bu_names.get(c.business_unit_id) or "",
            _dept_labels(c),
            _roster_names(c, ExecutorRoleEnum.PRIMARY),
            _roster_names(c, ExecutorRoleEnum.SECONDARY),
            "Restricted" if c.restricted_visibility else "Organisation-wide",
            c.status,
            c.created_on.strftime("%d %b %Y") if c.created_on else "",
        ])

    widths = [32, 60, 24, 28, 36, 36, 18, 12, 14]
    for col_idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = w
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def get_category(category_id: str, user: UserBase) -> dict[str, Any]:
    cat = await Category.get(category_id)
    if cat is None or cat.deleted_on is not None or str(cat.organisation_id) != user.organisation_id:
        raise CategoryNotFound()
    # Restricted categories are only retrievable by managers or members of the
    # category's business unit + department.
    if not _can_view_all_categories(user) and not _user_can_access_category(user, cat):
        raise CategoryNotFound()
    return await _to_out_one(cat, user)


async def _load_or_404(category_id: str, organisation_id: str) -> Category:
    cat = await Category.get(category_id)
    if cat is None or cat.deleted_on is not None or str(cat.organisation_id) != organisation_id:
        raise CategoryNotFound()
    return cat


async def update_category(
    category_id: str, body: CategoryUpdate, user: UserBase
) -> dict[str, Any]:
    cat = await _load_or_404(category_id, user.organisation_id)
    update_data = body.model_dump(exclude_unset=True)

    if "name" in update_data:
        new_name = normalize_name(update_data["name"])
        new_name_lc = to_name_lc(new_name)
        if new_name_lc != cat.name_lc:
            collision = await _find_by_name(user.org_oid, new_name_lc)
            if collision is not None and str(collision.id) != str(cat.id):
                raise CategoryNameExists()
            cat.name = new_name
            cat.name_lc = new_name_lc
        else:
            # Only casing changed — keep the collision-free path.
            cat.name = new_name

    if "description" in update_data:
        cat.description = update_data["description"]

    # Business unit + departments: validate together when either changes, so
    # every department still belongs to the chosen business unit.
    # A legacy scalar `department_id` has already been promoted into
    # `department_ids` by CategoryUpdate._normalise_departments, so the list is
    # the only shape that reaches here.
    new_depts = update_data.get("department_ids") if "department_ids" in update_data else None
    new_bu = update_data.get("business_unit_id") if "business_unit_id" in update_data else None
    old_depts = category_department_ids(cat)
    eff_depts = list(new_depts) if new_depts else old_depts
    if new_depts or new_bu:
        eff_bu = new_bu if new_bu else cat.business_unit_id
        if eff_bu:
            await _ensure_bu_and_depts(eff_bu, eff_depts, user)
        else:
            for _d in eff_depts:
                await _ensure_dept_in_org(_d, user)
        if new_depts:
            cat.department_ids = list(new_depts)
            # Deprecated mirror, dual-written so un-migrated readers keep working.
            cat.department_id = new_depts[0]
        if new_bu:
            cat.business_unit_id = new_bu

    if "restricted_visibility" in update_data and update_data["restricted_visibility"] is not None:
        cat.restricted_visibility = bool(update_data["restricted_visibility"])

    # Visibility scope: recompute whenever the toggle or either list is touched.
    scope_touched = (
        "restricted_visibility" in update_data
        or "visibility_business_unit_ids" in update_data
        or "visibility_department_ids" in update_data
    )
    if scope_touched:
        if cat.restricted_visibility:
            # The scope arrays hold only the *extra* teams beyond the home
            # BU + department, which always have visibility. Empty arrays are
            # valid (restricted to just the home team).
            eff_vis_bus = (
                update_data["visibility_business_unit_ids"]
                if "visibility_business_unit_ids" in update_data
                and update_data["visibility_business_unit_ids"] is not None
                else list(cat.visibility_business_unit_ids or [])
            )
            # Deliberately NOT named eff_depts: that holds the category's
            # STAFFING departments and the roster below is resolved against it.
            # Reusing the name here silently pointed roster validation at the
            # visibility scope — usually empty — which wiped every roster on any
            # edit of a restricted category.
            eff_vis_depts = (
                update_data["visibility_department_ids"]
                if "visibility_department_ids" in update_data
                and update_data["visibility_department_ids"] is not None
                else list(cat.visibility_department_ids or [])
            )
            await _ensure_visibility_scope(eff_vis_bus, eff_vis_depts, user)
            cat.visibility_business_unit_ids = eff_vis_bus
            cat.visibility_department_ids = eff_vis_depts
        else:
            # Org-wide again — drop any previously stored scope.
            cat.visibility_business_unit_ids = []
            cat.visibility_department_ids = []

    # Executor roster — sent means "replace", omitted means "leave alone".
    # The one exception: the roster is department-scoped, so changing the
    # department list without supplying a new roster *prunes* it. Only the
    # executors who belong to no remaining department lose their place —
    # dropping the whole roster (revision 1's behaviour) is far too blunt now
    # that a category can hold several departments and adding one shouldn't
    # cost the admin the roster they already built.
    if "executors" in update_data:
        cat.executors = await _resolve_executors(body.executors, eff_depts, user)
    elif new_depts:
        cat.executors = await _prune_executors(cat.executors, eff_depts, user)

    if "roster_is_exclusive" in update_data and update_data["roster_is_exclusive"] is not None:
        cat.roster_is_exclusive = bool(update_data["roster_is_exclusive"])
    # A cleared roster makes exclusivity meaningless — drop the flag with it so
    # a later re-roster doesn't silently inherit a lockdown nobody asked for.
    if not cat.executors:
        cat.roster_is_exclusive = False

    if "status" in update_data and update_data["status"] is not None:
        cat.status = StatusEnum(update_data["status"])

    cat.modified_by = user.id
    cat.modified_on = utcnow()
    await cat.save()

    try:
        await emit_audit(
            event="category.updated",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(cat.id), "fields": list(update_data.keys())},
        )
    except Exception:  # noqa: BLE001
        pass
    return await _to_out_one(cat, user)


async def delete_category(category_id: str, user: UserBase) -> None:
    cat = await _load_or_404(category_id, user.organisation_id)
    # Block if any non-deleted request_type references this category.
    in_use = await RequestType.find(
        {
            "organisation_id": user.org_oid,
            "category_id": cat.id,
            "deleted_on": None,
        }
    ).count()
    if in_use > 0:
        raise CategoryHasRequestTypes()

    now = utcnow()
    cat.deleted_on = now
    cat.deleted_by = user.id
    cat.status = StatusEnum.INACTIVE
    cat.modified_by = user.id
    cat.modified_on = now
    await cat.save()

    try:
        await emit_audit(
            event="category.deleted",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(cat.id)},
        )
    except Exception:  # noqa: BLE001
        pass
