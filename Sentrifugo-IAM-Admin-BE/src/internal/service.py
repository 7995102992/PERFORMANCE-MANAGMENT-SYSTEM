"""Query layer for the internal service-to-service reads.

Consumed by the RabbitMQ RPC servers in ``src.rpc.employees_sync`` and
``src.rpc.users_with_permission``. Returns plain dicts, serialised straight to
JSON in the RPC reply envelope.

These used to be exposed as unauthenticated ``GET /internal/*`` HTTP routes,
which meant an anonymous caller could dump the whole employee directory off the
public gateway. The routes are gone; do NOT re-add an HTTP surface here. If a
service needs this data, give it an RPC queue.
"""
from datetime import datetime

from beanie import PydanticObjectId

from src.auth.models import UserDocument
from src.master_data.models import MasterDataDocument
from src.modules.organisation.models import DesignationDocument, EmployeeDocument
from src.policies.utils import grants as grants_repo
from src.users.utils import tools as user_repo

MAX_SYNC_LIMIT = 1000
DEFAULT_SYNC_LIMIT = 500

# The Expense service names its module ``expense`` in its RPC contract (see its
# ``src/directory/README.md``), but grants are stored under the canonical module
# code ``expense_management`` (``ModuleEnum.EXPENSE_MANAGEMENT``). Grant lookups
# match ``module_id`` exactly, so the external name is normalised here — without
# it every expense approver/collapse-rule probe resolves to "nobody holds it".
_MODULE_ALIASES = {"expense": "expense_management"}


def _canonical_module(module: str) -> str:
    """Map an external module name to the code grants are stored under."""
    return _MODULE_ALIASES.get(module, module)

_EMPLOYEE_SYNC_PROJECTION = {
    "user_id": 1,
    "organisation_id": 1,
    "emp_code": 1,
    "l1_manager_id": 1,
    "l2_manager_id": 1,
    "business_unit_id": 1,
    "department_id": 1,
    "designation_id": 1,
    "employment_status": 1,
    "employment_type": 1,
    "project_status": 1,
    "date_of_joining": 1,
    "deleted_on": 1,
}


def _s(value) -> str | None:
    return str(value) if value is not None else None


async def users_with_permission(
    module: str,
    permission: str,
    organisation_id: str | None = None,
) -> list[dict]:
    """Return users who hold a given (module, permission) grant.

    Reverse of permission resolution: find policies granting the permission,
    then users whose policy_ids reference any of them. Org/super admins (full
    grid, no explicit grant) are intentionally NOT included — this lists
    explicit holders only.
    """
    # Grants store module_id as the module code (e.g. "leave_management") and
    # permission_id as the bare permission code (e.g. "approve_as_hr").
    policy_ids = await grants_repo.get_policy_ids_with_permission(
        _canonical_module(module), permission
    )
    if not policy_ids:
        return []
    users = await user_repo.list_users_with_any_policy(policy_ids, organisation_id)

    result: list[dict] = []
    for u in users:
        first = (u.get("first_name") or "").strip()
        last = (u.get("last_name") or "").strip()
        name = f"{first} {last}".strip() or u.get("full_name") or u.get("name")
        result.append({"user_id": u["id"], "email": u.get("email"), "name": name})
    return result


async def employees_sync(
    after_id: str | None = None,
    limit: int = DEFAULT_SYNC_LIMIT,
    organisation_id: str | None = None,
) -> list[dict]:
    """Cursor-paginated employee hierarchy/status snapshot for replica reconciliation.

    Consumed by downstream services (Leave Management) to repair their employee
    replicas when domain events were missed. Soft-deleted employees are included
    so deletions propagate too. Reads the raw collection (no Beanie parsing) so
    a single legacy document can't fail the whole page.
    """
    limit = max(1, min(int(limit), MAX_SYNC_LIMIT))

    query: dict = {}
    if organisation_id:
        query["organisation_id"] = PydanticObjectId(organisation_id)
    if after_id:
        query["_id"] = {"$gt": PydanticObjectId(after_id)}

    coll = EmployeeDocument.get_motor_collection()
    docs = (
        await coll.find(query, _EMPLOYEE_SYNC_PROJECTION)
        .sort("_id", 1)
        .limit(limit)
        .to_list(length=limit)
    )

    # The user account carries its own lifecycle (status flips to the ended
    # employment-status key on exit finalisation; deleted_on on soft-delete) —
    # include it so consumers can gate on user status too.
    # Identity (name / work email) lives on the user, not the employee, so it is
    # projected here as well: a replica rebuilt purely from this snapshot would
    # otherwise have no name to display and would surface raw ObjectIds.
    user_ids = [d["user_id"] for d in docs if d.get("user_id")]
    users_coll = UserDocument.get_motor_collection()
    user_docs = await users_coll.find(
        {"_id": {"$in": user_ids}},
        {
            "status": 1, "deleted_on": 1, "gender": 1, "marital_status": 1,
            "first_name": 1, "last_name": 1, "email": 1,
        },
    ).to_list(length=len(user_ids)) if user_ids else []
    user_map = {u["_id"]: u for u in user_docs}

    # Resolve gender / marital-status master-data ids to their key, in one batch.
    md_ids = {
        u[f]
        for u in user_docs
        for f in ("gender", "marital_status")
        if u.get(f) is not None
    }
    md_key: dict = {}
    if md_ids:
        md_coll = MasterDataDocument.get_motor_collection()
        md_docs = await md_coll.find(
            {"_id": {"$in": list(md_ids)}}, {"key": 1}
        ).to_list(length=len(md_ids))
        md_key = {m["_id"]: m.get("key") for m in md_docs}

    rows: list[dict] = []
    for d in docs:
        # Mongo stores date_of_joining as a datetime — normalise to the same
        # YYYY-MM-DD string the employee domain events publish.
        doj = d.get("date_of_joining")
        if isinstance(doj, datetime):
            doj = doj.date().isoformat()
        elif doj is not None:
            doj = str(doj)
        user_doc = user_map.get(d.get("user_id")) or {}
        _first, _last = user_doc.get("first_name"), user_doc.get("last_name")
        rows.append(
            {
                "employee_id": str(d["_id"]),
                "user_id": _s(d.get("user_id")),
                "first_name": _first,
                "last_name": _last,
                # Pre-composed so every consumer displays the same string rather
                # than each inventing its own join of the two parts.
                "name": " ".join(p for p in (_first, _last) if p) or None,
                "work_email": user_doc.get("email"),
                "organisation_id": _s(d.get("organisation_id")),
                "emp_code": d.get("emp_code"),
                "l1_manager_id": _s(d.get("l1_manager_id")),
                "l2_manager_id": _s(d.get("l2_manager_id")),
                "business_unit_id": _s(d.get("business_unit_id")),
                "department_id": _s(d.get("department_id")),
                "designation_id": _s(d.get("designation_id")),
                "employment_status": _s(d.get("employment_status")),
                "employment_type": _s(d.get("employment_type")),
                "project_status": _s(d.get("project_status")),
                "date_of_joining": doj,
                "is_deleted": d.get("deleted_on") is not None,
                "user_status": _s(user_doc.get("status")),
                "user_is_deleted": user_doc.get("deleted_on") is not None,
                "gender": md_key.get(user_doc.get("gender")),
                "marital_status": md_key.get(user_doc.get("marital_status")),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Expense-service directory reads (Expense HLD §5.2, §5.3, §6, §9.4)
#
# The expense service keeps no employee, manager or approver data of its own —
# "L2 is a role, not a roster". Every lookup below is resolved live, so a
# promotion or a reporting change takes effect the same day instead of drifting
# against a cached copy.
#
# One trap worth stating once: **EmployeeDocument.l1_manager_id stores the
# manager's USER id, not their employee _id.** Resolving it against the
# employees collection silently yields nothing.
# ---------------------------------------------------------------------------

_PROFILE_PROJECTION = {"first_name": 1, "last_name": 1, "email": 1}


async def _designation_names(designation_ids: list) -> dict:
    """Map designation ids to display names, used for the ``role`` field."""
    ids = [d for d in designation_ids if d]
    if not ids:
        return {}
    coll = DesignationDocument.get_motor_collection()
    docs = await coll.find({"_id": {"$in": ids}}, {"designation_name": 1}).to_list(length=len(ids))
    return {d["_id"]: d.get("designation_name") for d in docs}


async def _profiles_for_user_ids(user_ids: list, organisation_id: str | None) -> dict:
    """Build ``{user_id: {user_id, name, role, email}}`` for the given users.

    ``role`` is the employee's designation name — what the expense approver
    pickers show to tell two people with the same name apart.
    """
    if not user_ids:
        return {}

    query: dict = {"_id": {"$in": user_ids}}
    if organisation_id:
        try:
            query["organisation_id"] = PydanticObjectId(str(organisation_id))
        except Exception:
            return {}

    users = await UserDocument.get_motor_collection().find(
        query, _PROFILE_PROJECTION
    ).to_list(length=len(user_ids))
    if not users:
        return {}

    in_scope = [u["_id"] for u in users]
    emps = await EmployeeDocument.get_motor_collection().find(
        {"user_id": {"$in": in_scope}}, {"user_id": 1, "designation_id": 1}
    ).to_list(length=len(in_scope))
    desg_by_user = {e["user_id"]: e.get("designation_id") for e in emps}
    desg_names = await _designation_names(list(desg_by_user.values()))

    out: dict = {}
    for u in users:
        name = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
        out[str(u["_id"])] = {
            "user_id": str(u["_id"]),
            "name": name or None,
            "role": desg_names.get(desg_by_user.get(u["_id"])),
            "email": u.get("email"),
        }
    return out


async def employee_profiles(employee_ids: list[str], organisation_id: str) -> dict:
    """Resolve IAM user ids to display profiles, scoped to one organisation.

    Ids outside the organisation are omitted rather than returned unscoped: the
    caller renders these onto records it has already authorised, so a
    cross-tenant reply here would slip past that check.
    """
    oids = []
    for raw in employee_ids or []:
        try:
            oids.append(PydanticObjectId(str(raw)))
        except Exception:
            continue
    return await _profiles_for_user_ids(oids, organisation_id)


async def reporting_manager(employee_id: str, organisation_id: str) -> dict | None:
    """Resolve one employee's L1 reporting manager.

    ``None`` means the employee is at the top of the line, or is unknown. The
    expense service turns that into a hard refusal to submit, because L1 is
    unconditional — so this must never guess a manager.
    """
    try:
        uid = PydanticObjectId(str(employee_id))
        org = PydanticObjectId(str(organisation_id))
    except Exception:
        return None

    emp = await EmployeeDocument.get_motor_collection().find_one(
        {"user_id": uid, "organisation_id": org, "deleted_on": None},
        {"l1_manager_id": 1},
    )
    manager_user_id = (emp or {}).get("l1_manager_id")
    if not manager_user_id:
        return None

    profiles = await _profiles_for_user_ids([manager_user_id], organisation_id)
    return profiles.get(str(manager_user_id))


async def reporting_line(manager_id: str, organisation_id: str) -> list[str]:
    """List a manager's **direct** reports, as IAM user ids.

    Direct only. Advance allocation and Gate 1 are one edge deep; flattening the
    sub-tree here would let a manager allocate to someone two levels down.
    """
    try:
        uid = PydanticObjectId(str(manager_id))
        org = PydanticObjectId(str(organisation_id))
    except Exception:
        return []

    docs = await EmployeeDocument.get_motor_collection().find(
        {"l1_manager_id": uid, "organisation_id": org, "deleted_on": None},
        {"user_id": 1},
    ).to_list(length=None)
    return [str(d["user_id"]) for d in docs if d.get("user_id")]


async def permission_check(
    employee_id: str,
    organisation_id: str,
    module: str,
    permission: str,
) -> bool:
    """Test whether one user holds ``(module, permission)``.

    Deny by default: an unknown user, no policies, or a malformed id is
    ``False``. Org and super admins bypass permission checks everywhere else in
    the platform, so they are reported as holding the grant here too — the
    collapse rule must see the same answer the enforcing service would.
    """
    if not module or not permission:
        return False
    try:
        uid = PydanticObjectId(str(employee_id))
    except Exception:
        return False

    user = await UserDocument.get_motor_collection().find_one(
        {"_id": uid}, {"policy_ids": 1, "is_org_admin": 1, "is_super_admin": 1}
    )
    if not user:
        return False
    if user.get("is_super_admin") or user.get("is_org_admin"):
        return True

    policy_ids = await grants_repo.get_policy_ids_with_permission(
        _canonical_module(module), permission
    )
    if not policy_ids:
        return False
    held = {str(p) for p in (user.get("policy_ids") or [])}
    return any(str(p) in held for p in policy_ids)
