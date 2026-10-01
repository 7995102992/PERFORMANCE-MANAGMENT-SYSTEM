from motor.motor_asyncio import AsyncIOMotorDatabase

from src.utils import to_oid

EMPLOYMENT_STATUSES_COLLECTION = "employment_statuses"


async def get_inactive_status_ids(db: AsyncIOMotorDatabase) -> set:
    """Return the set of ObjectIds for employment statuses flagged inactive.

    Inactivity is driven by the ``is_active`` flag (synced from IAM), the same
    flag the leave-application gate uses, so cancellation, calendar, and the
    leave-apply gate all stay consistent.
    """
    docs = await db[EMPLOYMENT_STATUSES_COLLECTION].find(
        {"is_active": False},
        {"_id": 1},
    ).to_list(length=None)
    return {d["_id"] for d in docs}


async def deactivated_user_ids(db: AsyncIOMotorDatabase, user_ids) -> set:
    """Subset of ``user_ids`` whose USER account (not employee record) is ended.

    Ended means the users replica shows ``is_deleted`` (user soft-deleted in
    IAM) or a ``status`` matching an employment-status key flagged inactive
    (exit / retired / terminated / absconded — IAM stamps that key onto the
    user on exit finalisation). ``inactive`` alone is deliberately NOT matched:
    local-auth users are created with that status before account activation
    and the replica may never see the activation flip.

    Complements the employee-record checks — a deleted user account must not
    raise leave or appear on team surfaces even if their employee record was
    never touched.
    """
    if not user_ids:
        return set()
    oids = [to_oid(u) for u in user_ids if u]
    if not oids:
        return set()

    ended_docs = await db[EMPLOYMENT_STATUSES_COLLECTION].find(
        {"is_active": False}, {"key": 1}
    ).to_list(length=None)
    ended_keys = [d["key"] for d in ended_docs if d.get("key")]

    match = list(oids) + [str(o) for o in oids]
    lifecycle_or: list[dict] = [{"is_deleted": True}]
    if ended_keys:
        lifecycle_or.append({"status": {"$in": ended_keys}})
    docs = await db["users"].find(
        {"_id": {"$in": match}, "$or": lifecycle_or},
        {"_id": 1},
    ).to_list(length=None)
    return {to_oid(d["_id"]) for d in docs}


async def all_ended_user_oids(db: AsyncIOMotorDatabase) -> set:
    """Every user_id whose USER account is ended (soft-deleted, or carrying an
    employment-status key flagged inactive — exit/terminated/etc).

    The org-wide counterpart of :func:`deactivated_user_ids`. Used to keep the
    assignable-employee pool aligned with the membership active-filter, so the
    pool never offers someone who would then fail to appear as a member.
    """
    ended_docs = await db[EMPLOYMENT_STATUSES_COLLECTION].find(
        {"is_active": False}, {"key": 1}
    ).to_list(length=None)
    ended_keys = [d["key"] for d in ended_docs if d.get("key")]
    lifecycle_or: list[dict] = [{"is_deleted": True}]
    if ended_keys:
        lifecycle_or.append({"status": {"$in": ended_keys}})
    docs = await db["users"].find({"$or": lifecycle_or}, {"_id": 1}).to_list(length=None)
    return {d["_id"] for d in docs}


async def exclude_inactive_filter(db: AsyncIOMotorDatabase) -> dict:
    """Mongo filter fragment that drops employees with an inactive employment_status.

    Matches both ObjectId and string forms since replica writers have stored
    either over time. Empty dict when no status is flagged inactive, so it can
    always be spread into an employees query.
    """
    ids = await get_inactive_status_ids(db)
    if not ids:
        return {}
    return {"employment_status": {"$nin": list(ids) + [str(i) for i in ids]}}


async def filter_active_user_ids(db: AsyncIOMotorDatabase, user_ids) -> set:
    """Return the subset of ``user_ids`` whose employee record is ACTIVE.

    "Inactive" means the employee is soft-deleted (``is_deleted``) OR carries an
    ``employment_status`` flagged inactive (exited / terminated / etc — see
    :func:`get_inactive_status_ids`). Result is a set of ObjectIds for set math.

    Used both as a server-side WRITE guard (never (re)assign a deactivated
    employee to a plan / calendar) and as the READ-side filter (never surface a
    since-deactivated member in a plan / calendar list). Mirrors the active
    predicate used when resolving employees by department, so every path agrees
    on what "active" means. Accepts ObjectId or string ids.
    """
    if not user_ids:
        return set()
    oids = [to_oid(u) for u in user_ids if u]
    if not oids:
        return set()
    match = list(oids) + [str(o) for o in oids]
    docs = await db["employees"].find(
        {
            "user_id": {"$in": match},
            "is_deleted": {"$ne": True},
            "employment_status": {"$nin": list(await get_inactive_status_ids(db))},
        },
        {"user_id": 1},
    ).to_list(length=None)
    active = {to_oid(d["user_id"]) for d in docs if d.get("user_id")}
    # The user account has its own lifecycle — drop ids whose user is ended
    # even though the employee record still looks active.
    return active - await deactivated_user_ids(db, active)
