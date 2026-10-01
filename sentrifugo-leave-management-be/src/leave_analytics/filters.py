"""Shared leave-analytics helpers.

The analytics dashboards only surface leave types that have been explicitly
opted in to reporting (``show_in_analytics == True`` on the leave type). Leave
types default to hidden, so nothing appears in analytics until an admin turns it
on. ``get_analytics_leave_type_ids`` resolves that opted-in set once per request
so every aggregation / per-type breakdown can filter on ``leave_type_id``.
"""

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.utils import to_oid

LEAVE_TYPES_COL = "leave_types"


async def get_analytics_leave_type_ids(
    db: AsyncIOMotorDatabase, org_id: str | None = None
) -> list:
    """Return the ``_id``s of leave types opted in to analytics.

    Only leave types with ``show_in_analytics: True`` are returned (the field
    defaults to False / absent, which reads as hidden). When ``org_id`` is
    given the result is scoped to that org plus system-wide types
    (``org_id=None``); user-scoped dashboards can omit it since they already
    filter by user and leave-type ids are globally unique.

    The returned list is safe to drop straight into a ``{"$in": [...]}`` match —
    an empty list simply matches nothing, which is the correct behaviour when no
    type has been opted in yet.
    """
    query: dict = {"show_in_analytics": True, "deleted_on": None}
    if org_id is not None:
        query["$or"] = [{"org_id": to_oid(org_id)}, {"org_id": None}]
    docs = await db[LEAVE_TYPES_COL].find(query, {"_id": 1}).to_list(length=None)
    return [d["_id"] for d in docs]
