"""Shared employee-detail enrichment for membership listings.

Work-calendar and holiday-plan membership rows store only ``user_id``. The FE
previously fetched the whole org from IAM and joined client-side to show names —
that join dropped members past the fetch page and forced loading every employee.

Instead, resolve display fields here from the LMS's own mirror collections
(``employees`` + ``departments`` / ``business_units`` / ``designations``), which
are kept in sync from IAM via the domain-events consumer. One batch call per
listing, keyed by ``user_id`` string.
"""
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.utils import to_oid


def _name_of(emp: dict) -> str | None:
    name = emp.get("name")
    if name:
        return name
    combined = f"{emp.get('first_name', '') or ''} {emp.get('last_name', '') or ''}".strip()
    return combined or None


async def enrich_user_details(
    db: AsyncIOMotorDatabase, user_ids
) -> dict[str, dict]:
    """Map ``user_id`` (as str) → display detail dict for the given ids.

    Detail keys: ``name``, ``emp_code``, ``work_email``, ``department_name``,
    ``business_unit_name``, ``designation_name`` (any may be ``None``). Ids with
    no employee mirror row are simply absent from the result.
    """
    if not user_ids:
        return {}
    oids = [to_oid(u) for u in user_ids if u]
    if not oids:
        return {}
    # user_id has been stored as ObjectId (canonical) and as string (legacy) —
    # match both so no member is missed.
    match = list(oids) + [str(o) for o in oids]
    emps = await db["employees"].find(
        {"user_id": {"$in": match}},
        {
            "user_id": 1,
            "name": 1,
            "first_name": 1,
            "last_name": 1,
            "emp_code": 1,
            "work_email": 1,
            "department_id": 1,
            "business_unit_id": 1,
            "designation_id": 1,
        },
    ).to_list(length=None)
    if not emps:
        return {}

    def _collect(field: str) -> list:
        seen = {}
        for e in emps:
            v = e.get(field)
            if v is not None:
                seen[str(v)] = v
        return list(seen.values())

    async def _name_map(collection: str, ids: list) -> dict:
        if not ids:
            return {}
        docs = await db[collection].find(
            {"_id": {"$in": ids}}, {"name": 1}
        ).to_list(length=None)
        return {str(d["_id"]): d.get("name") for d in docs}

    dept_map = await _name_map("departments", _collect("department_id"))
    bu_map = await _name_map("business_units", _collect("business_unit_id"))
    desg_map = await _name_map("designations", _collect("designation_id"))

    result: dict[str, dict] = {}
    for e in emps:
        result[str(e["user_id"])] = {
            "name": _name_of(e),
            "emp_code": e.get("emp_code"),
            "work_email": e.get("work_email"),
            "department_name": dept_map.get(str(e.get("department_id"))),
            "business_unit_name": bu_map.get(str(e.get("business_unit_id"))),
            "designation_name": desg_map.get(str(e.get("designation_id"))),
        }
    return result


def apply_details(row: dict, details: dict[str, dict], user_id_field: str = "user_id") -> dict:
    """Merge the enrichment for ``row``'s user into ``row`` (mutates & returns)."""
    d = details.get(str(row.get(user_id_field)))
    if d:
        row.update(d)
    return row
