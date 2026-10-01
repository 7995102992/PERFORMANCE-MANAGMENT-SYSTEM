import re

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.clients.iam_master_data import fetch_employment_types
from src.employment_status import all_ended_user_oids, get_inactive_status_ids
from src.utils import to_oid

EMPLOYEE_COLLECTION = "employees"


def _name_of(emp: dict) -> str | None:
    name = emp.get("name")
    if name:
        return name
    combined = f"{emp.get('first_name', '') or ''} {emp.get('last_name', '') or ''}".strip()
    return combined or None


async def _name_map(db: AsyncIOMotorDatabase, collection: str, ids: list, field: str = "name") -> dict:
    ids = [i for i in ids if i is not None]
    if not ids:
        return {}
    docs = await db[collection].find({"_id": {"$in": ids}}, {field: 1}).to_list(length=None)
    return {str(d["_id"]): d.get(field) for d in docs}


async def list_scoped_employees(
    db: AsyncIOMotorDatabase,
    org_id: str | None,
    *,
    business_unit_ids: list[str] | None = None,
    department_ids: list[str] | None = None,
    designation_ids: list[str] | None = None,
    employment_type_id: str | None = None,
    search: str = "",
    skip: int = 0,
    limit: int = 50,
) -> dict:
    """Paged pool of assignable employees, resolved from the LMS mirror.

    Active only (inactive/exited employment statuses excluded), org-scoped, with
    optional BU / department / designation / employment-type filters and a
    name/emp_code/email search. Returns ``{items, total, skip, limit}`` where
    each item is enriched with dept / BU / designation / employment-status names.

    Admins are not a concern here: creating an admin in IAM never creates an
    employee record, so no ``employee.created`` event is emitted and admins are
    never in this mirror to begin with.
    """
    match: dict = {"is_deleted": {"$ne": True}}
    if org_id:
        match["organisation_id"] = to_oid(org_id)

    # Active only — same "active" definition as the membership filter
    # (filter_active_user_ids), so the pool never offers someone who would then
    # fail to appear as a member: exclude inactive/exited employment statuses
    # AND users whose account is ended.
    inactive = await get_inactive_status_ids(db)
    if inactive:
        match["employment_status"] = {"$nin": list(inactive) + [str(i) for i in inactive]}
    ended = await all_ended_user_oids(db)
    if ended:
        match["user_id"] = {"$nin": list(ended) + [str(u) for u in ended]}

    if business_unit_ids:
        match["business_unit_id"] = {"$in": [to_oid(b) for b in business_unit_ids if b]}
    if department_ids:
        match["department_id"] = {"$in": [to_oid(d) for d in department_ids if d]}
    if designation_ids:
        match["designation_id"] = {"$in": [to_oid(d) for d in designation_ids if d]}
    if employment_type_id:
        match["employment_type"] = to_oid(employment_type_id)

    if search:
        rx = {"$regex": re.escape(search), "$options": "i"}
        match["$or"] = [{"name": rx}, {"emp_code": rx}, {"work_email": rx}]

    total = await db[EMPLOYEE_COLLECTION].count_documents(match)
    docs = await (
        db[EMPLOYEE_COLLECTION]
        .find(match)
        .sort("emp_code", 1)
        .skip(max(skip, 0))
        .limit(max(limit, 1))
        .to_list(length=max(limit, 1))
    )

    def _collect(field: str) -> list:
        seen = {}
        for e in docs:
            v = e.get(field)
            if v is not None:
                seen[str(v)] = v
        return list(seen.values())

    dept_map = await _name_map(db, "departments", _collect("department_id"))
    bu_map = await _name_map(db, "business_units", _collect("business_unit_id"))
    desg_map = await _name_map(db, "designations", _collect("designation_id"))
    status_map = await _name_map(db, "employment_statuses", _collect("employment_status"), field="value")
    # Employment-type names via the master-data client (Valkey → IAM → local
    # mirror) — the local employment_types mirror only fills from domain events,
    # so types created before the consumer existed would resolve to nothing.
    type_docs = await fetch_employment_types(organisation_id=org_id)
    type_map = {tid: (doc or {}).get("value") for tid, doc in type_docs.items()}

    items = []
    for e in docs:
        items.append({
            "user_id": str(e.get("user_id")),
            "name": _name_of(e),
            "first_name": e.get("first_name"),
            "last_name": e.get("last_name"),
            "emp_code": e.get("emp_code"),
            "work_email": e.get("work_email"),
            "department_id": str(e["department_id"]) if e.get("department_id") else None,
            "department_name": dept_map.get(str(e.get("department_id"))),
            "business_unit_id": str(e["business_unit_id"]) if e.get("business_unit_id") else None,
            "business_unit_name": bu_map.get(str(e.get("business_unit_id"))),
            "designation_id": str(e["designation_id"]) if e.get("designation_id") else None,
            "designation_name": desg_map.get(str(e.get("designation_id"))),
            "employment_type_id": str(e["employment_type"]) if e.get("employment_type") else None,
            "employment_type": type_map.get(str(e.get("employment_type"))),
            "employment_status_id": str(e["employment_status"]) if e.get("employment_status") else None,
            "employment_status": status_map.get(str(e.get("employment_status"))),
        })

    return {"items": items, "total": total, "skip": skip, "limit": limit}
