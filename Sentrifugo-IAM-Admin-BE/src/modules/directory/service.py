"""Employee directory read service — a lean, PUBLIC-only projection over
EmployeeDocument (no sensitive fields ever touched)."""
import re
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.modules.organisation.models import EmployeeDocument


def _to_oid(val) -> Optional[PydanticObjectId]:
    try:
        return PydanticObjectId(val) if val else None
    except Exception:
        return None


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    oid = _to_oid(caller.organisation_id)
    if not oid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return oid


# Enrichment joins + PUBLIC projection. Sensitive fields (ctc, bank_details,
# identity_fields, personal_email/phone, addresses, dob, …) are simply never
# projected — they can't leak through this endpoint.
def _enrich_stages() -> list[dict]:
    def _join(coll, local, alias):
        return [
            {"$lookup": {"from": coll, "localField": local, "foreignField": "_id", "as": alias}},
            {"$unwind": {"path": f"${alias}", "preserveNullAndEmptyArrays": True}},
        ]

    def _name(u):
        return {"$trim": {"input": {"$concat": [
            {"$ifNull": [f"${u}.first_name", ""]}, " ", {"$ifNull": [f"${u}.last_name", ""]},
        ]}}}

    return [
        *_join("business_units", "business_unit_id", "_bu"),
        *_join("departments", "department_id", "_dept"),
        *_join("designations", "designation_id", "_desg"),
        *_join("users", "l1_manager_id", "_l1"),
        *_join("users", "l2_manager_id", "_l2"),
        *_join("master_data", "employment_type", "_etype"),
        *_join("master_data", "employment_status", "_estatus"),
        {"$project": {
            "_id": 0,
            # Stable per-row identity. user_id is NOT unique — a rehired employee
            # has several employee records under one user account — so clients
            # keying lists on it collide. This is the employee record's own id.
            "id": {"$toString": "$_id"},
            "user_id": 1,
            "emp_code": 1,
            "date_of_joining": 1,
            "seat_location": 1,
            "first_name": "$_user.first_name",
            "middle_name": "$_user.middle_name",
            "last_name": "$_user.last_name",
            "email": "$_user.email",
            "work_phone": "$_user.work_phone",
            "work_phone_extension": "$_user.work_phone_extension",
            "avatar_url": "$_user.avatar_url",
            "avatar_asset_id": "$_user.avatar_asset_id",
            "business_unit_name": "$_bu.business_unit_name",
            "department_name": "$_dept.department_name",
            "designation_name": "$_desg.designation_name",
            "l1_manager_name": _name("_l1"),
            "l2_manager_name": _name("_l2"),
            "employment_type": "$_etype.value",
            "employment_status": "$_estatus.value",
        }},
    ]


async def _caller_business_unit_ids(
    caller: UserBase, org_oid: PydanticObjectId
) -> list[PydanticObjectId]:
    """The business unit(s) the caller belongs to.

    A rehired employee has more than one employee record, so every non-deleted
    record is collected — picking just one would hide colleagues the caller
    legitimately sits alongside under their other record.
    """
    uid = _to_oid(caller.id)
    if not uid:
        return []
    rows = await EmployeeDocument.get_motor_collection().find(
        {"user_id": uid, "organisation_id": org_oid, "deleted_on": None},
        {"business_unit_id": 1},
    ).to_list(length=None)
    return [r["business_unit_id"] for r in rows if r.get("business_unit_id")]


async def _active_employment_status_ids() -> list[PydanticObjectId]:
    """Ids of EMPLOYMENT_STATUSES master-data rows flagged active — the same
    'active employee' definition the employees module uses."""
    from src.master_data.models import MasterDataDocument
    docs = await MasterDataDocument.find(
        {"category": "EMPLOYMENT_STATUSES", "is_active": True}
    ).to_list()
    return [d.id for d in docs]


async def list_directory(
    caller: UserBase,
    *,
    business_unit_ids: Optional[list[PydanticObjectId]] = None,
    department_ids: Optional[list[PydanticObjectId]] = None,
    include_inactive: bool = False,
    search: str = "",
    skip: int = 0,
    limit: int = 20,
) -> dict:
    """Paginated public directory of employees in the caller's organisation,
    scoped to the caller's own business unit(s). Super and org admins see the
    whole organisation. Active employees only by default; pass
    include_inactive=True to include all."""
    org_oid = _resolve_org(caller)
    match: dict = {"organisation_id": org_oid, "deleted_on": None}

    # Business-unit scoping. Admins administer across BUs, so they are exempt;
    # everyone else sees only their own BU. The businessUnitIds query param may
    # narrow that set but never widen it — otherwise the restriction would be
    # bypassable by simply passing another BU's id.
    empty = {"items": [], "total": 0, "skip": skip, "limit": limit}
    if caller.is_super_admin or caller.is_org_admin:
        if business_unit_ids:
            match["business_unit_id"] = {"$in": business_unit_ids}
    else:
        allowed = set(await _caller_business_unit_ids(caller, org_oid))
        if not allowed:
            # Caller has no BU on record — fail closed rather than fall back
            # to org-wide visibility.
            return empty
        if business_unit_ids:
            allowed &= set(business_unit_ids)
            if not allowed:
                return empty
        match["business_unit_id"] = {"$in": list(allowed)}

    if department_ids:
        match["department_id"] = {"$in": department_ids}
    if not include_inactive:
        # Only employees on an ACTIVE employment status (Permanent, Probation, …).
        match["employment_status"] = {"$in": await _active_employment_status_ids()}

    pipeline: list[dict] = [
        {"$match": match},
        {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "_id", "as": "_user"}},
        {"$unwind": {"path": "$_user", "preserveNullAndEmptyArrays": True}},
    ]
    if search.strip():
        rx = {"$regex": re.escape(search.strip()), "$options": "i"}
        pipeline.append({"$match": {"$or": [
            {"emp_code": rx},
            {"_user.first_name": rx},
            {"_user.last_name": rx},
            {"_user.email": rx},
        ]}})
    pipeline.append({"$sort": {"_user.first_name": 1, "_user.last_name": 1, "emp_code": 1}})
    # Enrich only the current page (after skip/limit) — cheaper than joining everyone.
    pipeline.append({"$facet": {
        "data": [{"$skip": skip}, {"$limit": limit}, *_enrich_stages()],
        "total": [{"$count": "count"}],
    }})

    agg = await EmployeeDocument.get_motor_collection().aggregate(pipeline).to_list(length=1)
    faceted = agg[0] if agg else {"data": [], "total": []}
    rows = faceted.get("data") or []
    total = (faceted.get("total") or [{}])[0].get("count", 0) if faceted.get("total") else 0

    for r in rows:
        parts = [r.get("first_name"), r.get("middle_name"), r.get("last_name")]
        r["full_name"] = " ".join(p for p in parts if p) or None
        r["l1_manager_name"] = (r.get("l1_manager_name") or "").strip() or None
        r["l2_manager_name"] = (r.get("l2_manager_name") or "").strip() or None

    return {"items": rows, "total": total, "skip": skip, "limit": limit}
