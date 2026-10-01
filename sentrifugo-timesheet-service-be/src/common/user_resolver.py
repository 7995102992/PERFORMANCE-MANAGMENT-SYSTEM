from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any
from uuid import uuid4

from bson import ObjectId

from ..database import get_client

IAM_DB = "sentrifugo_iam"
USERS_COLLECTION = "users"
POLICIES_COLLECTION = "policies"
MODULE_ACL_COLLECTION = "module_acl_permissions"

logger = logging.getLogger(__name__)


def _org_filter(organisation_id) -> dict:
    """Tenant guard for IAM lookups.

    Every resolver below reads PII (names, emails, emp codes) out of the shared
    IAM database, so any caller serving an authenticated request MUST pass its own
    ``user.organisation_id``: without it a user id from another tenant would
    resolve just fine. ``None`` keeps the unfiltered behaviour for system paths
    (crons / seeds) that legitimately have no single organisation in hand.
    """
    if organisation_id is None:
        return {}
    try:
        return {"organisation_id": ObjectId(organisation_id)}
    except Exception:
        return {"organisation_id": organisation_id}


async def user_belongs_to_organisation(user_id, organisation_id) -> bool:
    """True when the IAM user exists, is not deleted and belongs to ``organisation_id``.

    Tenant guard for endpoints that accept a user id from the request body or
    query string. Fails closed: an unparsable id, a missing record or a missing
    organisation returns False.
    """
    if not user_id or not organisation_id:
        return False
    try:
        uid = ObjectId(user_id)
    except Exception:
        return False
    client = get_client()
    doc = await client[IAM_DB][USERS_COLLECTION].find_one(
        {"_id": uid, "deleted_on": None, **_org_filter(organisation_id)},
        {"_id": 1},
    )
    return doc is not None


async def resolve_user_names(user_ids: list[str], organisation_id=None) -> dict[str, str]:
    if not user_ids:
        return {}
    client = get_client()
    col = client[IAM_DB][USERS_COLLECTION]
    oids = []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
    if not oids:
        return {}
    cursor = col.find(
        {"_id": {"$in": oids}, **_org_filter(organisation_id)},
        {"first_name": 1, "last_name": 1},
    )
    result: dict[Any, str] = {}
    async for doc in cursor:
        first = doc.get("first_name", "") or ""
        last = doc.get("last_name", "") or ""
        result[doc["_id"]] = f"{first} {last}".strip() or str(doc["_id"])
    return result


async def resolve_user_details(user_ids: list[str], organisation_id=None) -> dict[str, dict[str, str]]:
    """Return {user_id: {name, email}} for the given user IDs from IAM DB."""
    if not user_ids:
        return {}
    client = get_client()
    col = client[IAM_DB][USERS_COLLECTION]
    oids = []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
    if not oids:
        return {}
    cursor = col.find(
        {"_id": {"$in": oids}, **_org_filter(organisation_id)},
        {"email": 1, "first_name": 1, "last_name": 1},
    )
    result: dict[Any, dict[str, str]] = {}
    async for doc in cursor:
        first = doc.get("first_name", "") or ""
        last = doc.get("last_name", "") or ""
        name = f"{first} {last}".strip() or str(doc["_id"])
        email = doc.get("email", "") or ""
        result[doc["_id"]] = {"name": name, "email": email}
    return result


async def resolve_user_emails(user_ids: list[str], organisation_id=None) -> dict[str, str]:
    """Return {user_id: email} for the given user IDs from the IAM database."""
    if not user_ids:
        return {}
    client = get_client()
    col = client[IAM_DB][USERS_COLLECTION]
    oids = []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
    if not oids:
        return {}
    cursor = col.find(
        {"_id": {"$in": oids}, **_org_filter(organisation_id)},
        {"email": 1, "first_name": 1, "last_name": 1},
    )
    result: dict[Any, str] = {}
    async for doc in cursor:
        email = doc.get("email")
        if email:
            result[doc["_id"]] = email
    return result


async def resolve_emp_codes(user_ids: list[str], organisation_id=None) -> dict[str, str | None]:
    """Return {user_id: emp_code} from sentrifugo_iam.employees (None if no employee record)."""
    if not user_ids:
        return {}
    client = get_client()
    col = client[IAM_DB]["employees"]
    oids = []
    str_ids = []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
        str_ids.append(str(uid))
    # user_id may be stored as a string or as ObjectId — query both to be safe
    query: dict = {"deleted_on": None, **_org_filter(organisation_id)}
    if oids:
        query["$or"] = [{"user_id": {"$in": oids}}, {"user_id": {"$in": str_ids}}]
    else:
        query["user_id"] = {"$in": str_ids}
    cursor = col.find(query, {"user_id": 1, "emp_code": 1})
    result: dict[Any, str | None] = {}
    async for doc in cursor:
        uid = doc.get("user_id")
        if uid is not None:
            # key by ObjectId so PydanticObjectId/ObjectId lookups match
            try:
                result[ObjectId(uid)] = doc.get("emp_code")
            except Exception:
                result[uid] = doc.get("emp_code")
    return result


MASTER_DATA_COLLECTION = "master_data"
EMPLOYMENT_TYPE_CATEGORY = "EMPLOYMENT_TYPES"


async def fetch_employment_types(organisation_id=None) -> list[dict[str, str]]:
    """The organisation's selectable employment types, as ``{id, key, value}``.

    Read from the IAM master data: the built-in rows are global
    (``organisation_id: null``) and an organisation may add its own. ``id`` is what
    an employee record points at, so it is what callers store and compare.
    """
    client = get_client()
    query: dict[str, Any] = {"category": EMPLOYMENT_TYPE_CATEGORY, "is_active": True}
    if organisation_id is not None:
        query["$or"] = [{"organisation_id": None}, {"organisation_id": ObjectId(str(organisation_id))}]

    cursor = client[IAM_DB][MASTER_DATA_COLLECTION].find(query, {"key": 1, "value": 1})
    return [
        {"id": str(d["_id"]), "key": d.get("key"), "value": d.get("value")}
        async for d in cursor
    ]


async def resolve_employment_type_ids(user_ids: list[str], organisation_id=None) -> dict[str, str]:
    """Return {user_id: employment_type id} for the users that have one, both as str.

    Read straight off the employee record — ``employees.employment_type`` already
    holds the master-data id, so no second lookup is needed to compare against a
    configured set of ids. Users with no employee record, or no type on it, are
    simply absent from the map and are therefore never filtered out.

    Keys and values are strings deliberately. Callers hold user ids as
    ``PydanticObjectId``, ``ObjectId`` or ``str`` depending on where they came from,
    and IAM stores ``user_id`` either way; keying on the string form means a lookup
    can never silently miss because the two sides disagree on type — which here
    would quietly mail someone who was meant to be excluded.
    """
    if not user_ids:
        return {}
    client = get_client()

    oids, str_ids = [], []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
        str_ids.append(str(uid))

    query: dict[str, Any] = {"deleted_on": None, **_org_filter(organisation_id)}
    # user_id may be stored as a string or as ObjectId — query both to be safe
    query["$or"] = [{"user_id": {"$in": oids}}, {"user_id": {"$in": str_ids}}]

    cursor = client[IAM_DB]["employees"].find(query, {"user_id": 1, "employment_type": 1})
    result: dict[str, str] = {}
    async for doc in cursor:
        type_id, uid = doc.get("employment_type"), doc.get("user_id")
        if type_id is None or uid is None:
            continue
        result[str(uid)] = str(type_id)
    return result


async def fetch_reportee_user_ids(manager_user_id, organisation_id=None) -> list[ObjectId]:
    """User ids of everyone who reports to ``manager_user_id``, at either level.

    ``employees.l1_manager_id`` and ``l2_manager_id`` both hold *user* ids — not
    employee-record ids — so the value compares directly against the ids carried on
    a project's ``project_head_ids``.

    Returns the reporting line one hop deep, L1 and L2 together: someone naming this
    user at either level is a reportee. It does not recurse, so a reportee's own
    reportees are not included.
    """
    if not manager_user_id:
        return []
    try:
        mgr = ObjectId(str(manager_user_id))
    except Exception:
        return []

    client = get_client()
    cursor = client[IAM_DB]["employees"].find(
        {
            "deleted_on": None,
            "$or": [{"l1_manager_id": mgr}, {"l2_manager_id": mgr}],
            **_org_filter(organisation_id),
        },
        {"user_id": 1},
    )
    out: list[ObjectId] = []
    async for doc in cursor:
        uid = doc.get("user_id")
        if uid is None:
            continue
        try:
            out.append(ObjectId(uid))
        except Exception:
            continue
    return out


async def resolve_user_scope(user_id: str) -> tuple[ObjectId | None, ObjectId | None]:
    """Return (business_unit_id, department_id) for a user from their IAM
    `employees` record, or (None, None) when no employee record exists.

    Used to restrict access to clients/projects by the viewer's department. IDs
    are coerced to ObjectId so they compare against the ObjectId-typed entries in
    ``Client.department_ids``.
    """
    if not user_id:
        return None, None
    client = get_client()
    col = client[IAM_DB]["employees"]
    oids = []
    try:
        oids.append(ObjectId(user_id))
    except Exception:
        pass
    # user_id may be stored as ObjectId or string — match both, like emp codes
    query: dict = {"deleted_on": None}
    if oids:
        query["$or"] = [{"user_id": {"$in": oids}}, {"user_id": {"$in": [str(user_id)]}}]
    else:
        query["user_id"] = {"$in": [str(user_id)]}
    doc = await col.find_one(query, {"business_unit_id": 1, "department_id": 1})
    if not doc:
        return None, None

    def _to_oid(v):
        if v is None:
            return None
        try:
            return ObjectId(v)
        except Exception:
            return v

    return _to_oid(doc.get("business_unit_id")), _to_oid(doc.get("department_id"))


async def resolve_users_org_units(user_ids: list) -> dict[str, tuple]:
    """Return {user_id_str: (business_unit_id, department_id)} from IAM employee
    records.

    Used to restrict manager/approval views to employees in the login user's own
    department AND business unit. Missing employee record → user absent from map.
    """
    if not user_ids:
        return {}
    client = get_client()
    col = client[IAM_DB]["employees"]
    oids, str_ids = [], []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
        str_ids.append(str(uid))
    query: dict = {"deleted_on": None}
    if oids:
        query["$or"] = [{"user_id": {"$in": oids}}, {"user_id": {"$in": str_ids}}]
    else:
        query["user_id"] = {"$in": str_ids}

    def _oid(v):
        if v is None:
            return None
        try:
            return ObjectId(v)
        except Exception:
            return v

    result: dict[str, tuple] = {}
    async for doc in col.find(query, {"user_id": 1, "business_unit_id": 1, "department_id": 1}):
        result[str(doc.get("user_id"))] = (_oid(doc.get("business_unit_id")), _oid(doc.get("department_id")))
    return result


async def find_iam_user_by_email(email: str) -> str | None:
    """Return the IAM user id for an email, or None. Used to tell an existing login
    (employee / already-registered head) from someone who needs an activation mail."""
    if not email:
        return None
    client = get_client()
    doc = await client[IAM_DB][USERS_COLLECTION].find_one(
        {"email": email.lower().strip()}, {"_id": 1}
    )
    return str(doc["_id"]) if doc else None


async def fetch_employees_in_scope(
    organisation_id,
    business_unit_ids: list | None = None,
    department_ids: list | None = None,
) -> list[dict]:
    """Active employees inside a client's scope: the employee's business unit must be
    one of the client's business units AND their department one of the client's
    departments. A client with no scope on a given axis is unrestricted on that axis.

    Returns [{user_id, emp_code, first_name, last_name, email,
              business_unit_id, department_id, business_unit_name, department_name}].
    """
    client = get_client()
    emp_col = client[IAM_DB]["employees"]
    try:
        org_oid = ObjectId(organisation_id)
    except Exception:
        org_oid = organisation_id

    query: dict[str, Any] = {"organisation_id": org_oid, "deleted_on": None}
    bu_oids = [ObjectId(str(b)) for b in (business_unit_ids or []) if ObjectId.is_valid(str(b))]
    dept_oids = [ObjectId(str(d)) for d in (department_ids or []) if ObjectId.is_valid(str(d))]
    # Both constraints apply together (AND) — BU, and a department within it.
    if bu_oids:
        query["business_unit_id"] = {"$in": bu_oids}
    if dept_oids:
        query["department_id"] = {"$in": dept_oids}

    emps = await emp_col.find(
        query,
        {"user_id": 1, "emp_code": 1, "business_unit_id": 1, "department_id": 1},
    ).to_list(length=None)
    emps = [e for e in emps if e.get("user_id")]
    if not emps:
        return []

    # Only active people — the IAM `status` lives on the user, not the employee record
    # (values: active / inactive / notice_period).
    user_oids = [e["user_id"] for e in emps]
    users: dict[Any, dict] = {}
    async for u in client[IAM_DB][USERS_COLLECTION].find(
        {"_id": {"$in": user_oids}, "status": "active", "deleted_on": None},
        {"first_name": 1, "last_name": 1, "email": 1},
    ):
        users[u["_id"]] = u

    bu_names = await resolve_scope_names(
        "business_unit", [e.get("business_unit_id") for e in emps if e.get("business_unit_id")]
    )
    dept_names = await resolve_scope_names(
        "department", [e.get("department_id") for e in emps if e.get("department_id")]
    )

    out: list[dict] = []
    for e in emps:
        u = users.get(e["user_id"])
        if not u:
            continue  # no IAM login → cannot be a project head
        bu_id = e.get("business_unit_id")
        dept_id = e.get("department_id")
        out.append({
            "user_id": str(e["user_id"]),
            "emp_code": e.get("emp_code"),
            "first_name": u.get("first_name") or "",
            "last_name": u.get("last_name") or "",
            "email": (u.get("email") or "").lower(),
            "business_unit_id": str(bu_id) if bu_id else None,
            "department_id": str(dept_id) if dept_id else None,
            "business_unit_name": bu_names.get(str(bu_id)) if bu_id else None,
            "department_name": dept_names.get(str(dept_id)) if dept_id else None,
        })
    out.sort(key=lambda x: (x["first_name"].lower(), x["last_name"].lower()))
    return out


async def resolve_scope_names(scope_type: str | None, ids: list) -> dict[str, str]:
    """Return {id_str: name} for business-unit / department ids from IAM."""
    if not scope_type or not ids:
        return {}
    client = get_client()
    if scope_type == "business_unit":
        col, name_field = client[IAM_DB]["business_units"], "business_unit_name"
    elif scope_type == "department":
        col, name_field = client[IAM_DB]["departments"], "department_name"
    else:
        return {}
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(str(i))]
    if not oids:
        return {}
    result: dict[str, str] = {}
    async for doc in col.find({"_id": {"$in": oids}}, {name_field: 1}):
        result[str(doc["_id"])] = doc.get(name_field) or ""
    return result


async def fetch_scope_options(scope_type: str | None, organisation_id) -> list[tuple]:
    """Return [(name, ObjectId)] for the org's business_units / departments,
    sorted by name. Used to populate import-template reference lists and to
    resolve names → ids on client import."""
    if not scope_type:
        return []
    client = get_client()
    if scope_type == "business_unit":
        col, name_field = client[IAM_DB]["business_units"], "business_unit_name"
    elif scope_type == "department":
        col, name_field = client[IAM_DB]["departments"], "department_name"
    else:
        return []
    try:
        org_oid = ObjectId(organisation_id)
    except Exception:
        org_oid = organisation_id
    items: list[tuple] = []
    async for doc in col.find({"organisation_id": org_oid, "deleted_on": None}, {name_field: 1}):
        nm = (doc.get(name_field) or "").strip()
        if nm:
            items.append((nm, doc["_id"]))
    items.sort(key=lambda x: x[0].lower())
    return items


async def fetch_bu_department_map(organisation_id) -> dict[str, list[str]]:
    """Return {business_unit_name: [department_name, ...]} for the org — a
    department belongs to a BU if that BU is in its ``business_units`` (or is its
    ``primary_business_unit``). Used for cascading BU → Department dropdowns."""
    bu_opts = await fetch_scope_options("business_unit", organisation_id)
    name_by_id = {str(i): n for n, i in bu_opts}
    mapping: dict[str, list[str]] = {n: [] for n, _ in bu_opts}
    if not bu_opts:
        return mapping
    client = get_client()
    col = client[IAM_DB]["departments"]
    try:
        org_oid = ObjectId(organisation_id)
    except Exception:
        org_oid = organisation_id
    async for d in col.find(
        {"organisation_id": org_oid, "deleted_on": None},
        {"department_name": 1, "business_units": 1, "primary_business_unit": 1},
    ):
        dn = (d.get("department_name") or "").strip()
        if not dn:
            continue
        bu_ids = {str(b) for b in (d.get("business_units") or [])}
        if d.get("primary_business_unit"):
            bu_ids.add(str(d["primary_business_unit"]))
        for bid in bu_ids:
            bn = name_by_id.get(bid)
            if bn is not None:
                mapping[bn].append(dn)
    for bn in mapping:
        mapping[bn] = sorted(set(mapping[bn]), key=str.lower)
    return mapping


async def fetch_country_names(limit: int = 300) -> list[str]:
    """Return sorted distinct country names from the IAM `countries` collection."""
    client = get_client()
    col = client[IAM_DB]["countries"]
    cursor = col.find({}, {"_id": 0, "name": 1}).limit(limit)
    names: set[str] = set()
    async for doc in cursor:
        n = (doc.get("name") or "").strip()
        if n:
            names.add(n)
    return sorted(names)


async def fetch_state_names(limit: int = 5000) -> list[str]:
    """Return sorted distinct state names from the IAM `states` collection."""
    client = get_client()
    col = client[IAM_DB]["states"]
    cursor = col.find({}, {"_id": 0, "name": 1}).limit(limit)
    names: set[str] = set()
    async for doc in cursor:
        n = (doc.get("name") or "").strip()
        if n:
            names.add(n)
    return sorted(names)


async def fetch_country_state_map(limit: int = 6000) -> dict[str, list[str]]:
    """Return {country_name: [sorted state names]} from the IAM `states` collection.

    Used to build cascading Country -> State dropdowns in import templates.
    """
    client = get_client()
    col = client[IAM_DB]["states"]
    cursor = col.find({}, {"_id": 0, "name": 1, "country_name": 1}).limit(limit)
    mapping: dict[str, set[str]] = {}
    async for doc in cursor:
        country = (doc.get("country_name") or "").strip()
        state = (doc.get("name") or "").strip()
        if country and state:
            mapping.setdefault(country, set()).add(state)
    return {c: sorted(s) for c, s in mapping.items()}


async def _country_tz_for_bu(bu: dict, db) -> tuple[str, int | None]:
    """Resolve (zoneName, gmtOffset_seconds) from a BU's address country via the
    IAM countries collection. Returns ("", None) when unresolvable.
    """
    if not bu.get("address_id"):
        return "", None
    addr = await db["addresses"].find_one({"_id": bu["address_id"]})
    country_name = (addr or {}).get("country", "").strip() if addr else ""
    if not country_name:
        return "", None
    country = await db["countries"].find_one(
        {"name": {"$regex": f"^{re.escape(country_name)}$", "$options": "i"}}
    )
    tzs = (country or {}).get("timezones") or []
    if tzs:
        return (tzs[0].get("zoneName") or "").strip(), tzs[0].get("gmtOffset")
    return "", None


async def _bu_doc_to_tzinfo(bu: dict | None, db) -> tzinfo:
    """Resolve a datetime.tzinfo from a Business Unit document.

    Order of precedence:
      1. business_units.time_zone (IANA name, e.g. "Asia/Kolkata") via zoneinfo
      2. BU.address_id -> addresses.country -> countries.timezones[0] gmtOffset
         (used both when no BU time_zone is set AND as a fallback when zoneinfo
         cannot load the IANA name, e.g. missing tzdata)
    Defaults to UTC when nothing resolvable.
    """
    if not bu:
        return timezone.utc
    try:
        zone_name = (bu.get("time_zone") or "").strip()
        offset_seconds: int | None = None

        # No direct BU timezone -> derive from country
        if not zone_name:
            zone_name, offset_seconds = await _country_tz_for_bu(bu, db)

        if zone_name:
            try:
                from zoneinfo import ZoneInfo
                return ZoneInfo(zone_name)
            except Exception:
                # IANA db unavailable (e.g. tzdata not installed) — fall back to
                # the country's fixed gmtOffset so local time is still correct.
                if offset_seconds is None:
                    _, offset_seconds = await _country_tz_for_bu(bu, db)
                logger.warning(
                    "_bu_doc_to_tzinfo: zoneinfo failed for %s; using offset=%s",
                    zone_name, offset_seconds,
                )

        if offset_seconds is not None:
            return timezone(timedelta(seconds=offset_seconds))
    except Exception:
        logger.exception("_bu_doc_to_tzinfo failed bu=%s", (bu or {}).get("_id"))
    return timezone.utc


async def fetch_org_employee_user_ids(organisation_id) -> list:
    """Return the list of active (non-deleted) employee user_ids for an org,
    from the IAM `employees` collection. Used for org-wide reminders.
    """
    client = get_client()
    db = client[IAM_DB]
    result: list = []
    try:
        cursor = db["employees"].find(
            {"organisation_id": organisation_id, "deleted_on": None},
            {"user_id": 1},
        )
        async for e in cursor:
            uid = e.get("user_id")
            if uid is None:
                continue
            try:
                uid = ObjectId(uid)
            except Exception:
                pass
            result.append(uid)
    except Exception:
        logger.exception("fetch_org_employee_user_ids failed org=%s", organisation_id)
    return result


async def fetch_user_bu_timezones(user_ids: list) -> dict:
    """Return {user_id (bson ObjectId): tzinfo} resolved from each employee's
    Business Unit. Employees without a BU (or unresolvable tz) are omitted.

    Keyed by the raw bson ObjectId so PydanticObjectId lookups match.
    """
    if not user_ids:
        return {}
    client = get_client()
    db = client[IAM_DB]

    oids, str_ids = [], []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
        str_ids.append(str(uid))

    query: dict = {"deleted_on": None}
    if oids:
        query["$or"] = [{"user_id": {"$in": oids}}, {"user_id": {"$in": str_ids}}]
    else:
        query["user_id"] = {"$in": str_ids}

    # user_id -> business_unit_id
    user_to_bu: dict = {}
    async for e in db["employees"].find(query, {"user_id": 1, "business_unit_id": 1}):
        bu_id = e.get("business_unit_id")
        if bu_id is None:
            continue
        try:
            bu_id = ObjectId(bu_id)
        except Exception:
            pass
        uid = e.get("user_id")
        try:
            uid = ObjectId(uid)
        except Exception:
            pass
        user_to_bu[uid] = bu_id

    if not user_to_bu:
        return {}

    # Load each distinct BU once, resolve its tzinfo
    bu_ids = list({b for b in user_to_bu.values()})
    bu_docs: dict = {}
    async for bu in db["business_units"].find({"_id": {"$in": bu_ids}}):
        bu_docs[bu["_id"]] = bu

    bu_tz_cache: dict = {}
    for bu_id, bu in bu_docs.items():
        bu_tz_cache[bu_id] = await _bu_doc_to_tzinfo(bu, db)

    return {uid: bu_tz_cache.get(bu_id, timezone.utc) for uid, bu_id in user_to_bu.items()}


async def fetch_org_tzinfo(organisation_id) -> tzinfo:
    """Resolve a timezone for an organisation from its first active Business Unit.
    (Kept for callers that need a single org-level timezone.)
    """
    client = get_client()
    db = client[IAM_DB]
    try:
        bu = await db["business_units"].find_one({
            "organisation_id": organisation_id,
            "is_active": True,
            "deleted_on": None,
        })
        return await _bu_doc_to_tzinfo(bu, db)
    except Exception:
        logger.exception("fetch_org_tzinfo failed org=%s", organisation_id)
        return timezone.utc


async def copy_policy_ids_from_iam_user(source_user_id: str, target_user_id: str) -> None:
    """Copy policy_ids from an existing IAM user to a newly created one."""
    client = get_client()
    col = client[IAM_DB][USERS_COLLECTION]
    source = await col.find_one({"_id": ObjectId(source_user_id)}, {"policy_ids": 1})
    if not source:
        logger.warning("copy_policy_ids: source user %s not found", source_user_id)
        return
    policy_ids = source.get("policy_ids") or []
    if not policy_ids:
        logger.warning("copy_policy_ids: source user %s has no policy_ids", source_user_id)
        return
    await col.update_one(
        {"_id": ObjectId(target_user_id)},
        {"$addToSet": {"policy_ids": {"$each": policy_ids}}},
    )
    logger.info("Copied %d policy_ids from %s to %s", len(policy_ids), source_user_id, target_user_id)


async def update_iam_user(
    user_id: str,
    *,
    modified_by: str,
    email: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
) -> None:
    client = get_client()
    col = client[IAM_DB][USERS_COLLECTION]
    updates: dict[str, Any] = {
        "modified_by": modified_by,
        "modified_on": datetime.now(timezone.utc),
    }
    if email is not None:
        updates["email"] = email
    if first_name is not None:
        updates["first_name"] = first_name
    if last_name is not None:
        updates["last_name"] = last_name
    await col.update_one({"_id": ObjectId(user_id)}, {"$set": updates})
    logger.info("Updated IAM user id=%s", user_id)


async def create_iam_user(
    *,
    email: str,
    first_name: str,
    last_name: str,
    organisation_id: str,
    created_by: str = "system",
) -> str:
    client = get_client()
    col = client[IAM_DB][USERS_COLLECTION]

    existing = await col.find_one({"email": email})
    if existing:
        # Never log the address itself — these logs ship to central logging.
        logger.info("IAM user already exists for the given email, reusing id=%s", existing["_id"])
        return str(existing["_id"])

    now = datetime.now(timezone.utc)
    doc: dict[str, Any] = {
        "created_by": created_by,
        "created_on": now,
        "modified_by": created_by,
        "modified_on": now,
        "deleted_by": None,
        "deleted_on": None,
        "correlation_id": str(uuid4()),
        "email": email,
        "password_hash": None,
        "auth_method": "local",
        "azure_oid": None,
        "first_name": first_name,
        "last_name": last_name,
        "middle_name": None,
        "phone": None,
        "work_phone": None,
        "work_phone_extension": None,
        "avatar_url": None,
        "dob": None,
        "gender": None,
        "marital_status": None,
        "status": "inactive",
        "pending_email": None,
        "last_login_at": None,
        "password_changed_at": None,
        "is_super_admin": False,
        "is_org_admin": False,
        "organisation_id": ObjectId(organisation_id),
        "policy_ids": [],
    }
    result = await col.insert_one(doc)
    logger.info("Created IAM user id=%s", result.inserted_id)
    return str(result.inserted_id)
