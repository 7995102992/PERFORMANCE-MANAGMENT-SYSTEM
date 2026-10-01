import uuid

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.leave_types.eligibility import filter_eligible
from src.leave_types.schemas import (
    LeaveTypeAccrual,
    LeaveTypeCreate,
    LeaveTypeUpdate,
    accrual_rules_error,
)
from src.logger import logger
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update
from src.utils import to_oid
COLLECTION = "leave_types"
PLANS_COLLECTION = "leave_plans"
PLAN_TYPE_MAPPING_COLLECTION = "leave_plan_type_mapping"
REQUESTS_COLLECTION = "leave_requests"
PLAN_STATUS_ACTIVE = "active"

# Fields that can be changed on system (non-custom) leave types
_SYSTEM_TYPE_UPDATABLE_FIELDS = {
    "is_paid",
    "is_paid_leave",
    "deduct_from_balance",
    "deduct_from_leave_balance",
    "is_sick_leave",
    "is_statutory_leave",
    "max_statutory_days",
    "count_calendar_days",
    "show_description",
    "show_in_analytics",
    "show_in_leave_balance",
    "restrictions",
    # Ordering is presentation, not policy — a system type can be repositioned
    # in the list without becoming editable in any other way.
    "rank",
}

# Unranked types sort after every ranked one rather than jumping to the front,
# which is what a plain `rank or 0` would do.
_UNRANKED = float("inf")


def leave_type_sort_key(lt: dict) -> tuple:
    """Display order for a leave type: rank ascending, unranked last, then name.

    Every surface that lists leave types sorts with this, so the admin table,
    the employee's apply dropdown and the balance card agree on one order.
    """
    rank = lt.get("rank")
    return (
        rank if isinstance(rank, (int, float)) and rank is not None else _UNRANKED,
        str(lt.get("name") or "").lower(),
    )


def sort_leave_types(leave_types: list[dict]) -> list[dict]:
    return sorted(leave_types, key=leave_type_sort_key)


async def _next_rank(db: AsyncIOMotorDatabase, org_id) -> int:
    """One past the highest rank in the org, so a new type lands at the end.

    The first type in an org gets 1, the next 2, and so on. Ranks are per-org
    and need not stay dense — deleting a type leaves a gap, which is harmless
    because only the relative order is ever read.

    ``org_id`` is matched in both its ObjectId and string forms, the same
    defensive pairing ``_org_filter`` uses: a doc stored with the other form
    would otherwise be invisible here and the new type would be handed a rank
    that is already taken.
    """
    org_variants = [org_id, str(org_id)] if org_id is not None else [None]
    top = await db[COLLECTION].find_one(
        {
            "org_id": {"$in": org_variants},
            "deleted_on": None,
            # Only numeric ranks — a legacy doc with rank absent or null must
            # not be picked as the maximum.
            "rank": {"$type": "number"},
        },
        {"rank": 1},
        sort=[("rank", -1)],
    )
    return int((top or {}).get("rank") or 0) + 1


def _org_filter(org_id: str | None) -> dict:
    # org_id is stored as an ObjectId, system-wide types have org_id=None.
    # Match both ObjectId/string forms defensively.
    if not org_id:
        return {}
    return {"org_id": {"$in": [to_oid(org_id), str(org_id)]}}


async def _get_leave_type_by_id(
    db: AsyncIOMotorDatabase, leave_type_id: str, org_id: str | None = None
) -> dict:
    doc = await db[COLLECTION].find_one(
        {"_id": to_oid(leave_type_id), "deleted_on": None, **_org_filter(org_id)}
    )
    if not doc:
        raise DomainException(
            message="Leave type not found",
            code="LEAVE_TYPE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def create_leave_type(
    db: AsyncIOMotorDatabase, payload: LeaveTypeCreate, created_by: str,
    org_id: str | None = None,
) -> dict:
    # The owning org comes from the caller's session, not the payload, so a
    # request cannot plant a leave type in another tenant (or, by omitting
    # org_id, create a system-wide type visible to every tenant).
    owner_org_id = to_oid(org_id) if org_id else to_oid(payload.org_id)
    existing = await db[COLLECTION].find_one(
        {"org_id": owner_org_id, "code": payload.code, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"Leave type with code '{payload.code}' already exists",
            code="DUPLICATE_LEAVE_TYPE",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        **payload.model_dump(mode="json"),
        "is_active": True,
        "org_id": owner_org_id,
        **audit_fields_create(created_by)
    }
    # A client that does not care about ordering omits rank; the type then goes
    # to the end of the list instead of becoming an unranked straggler.
    if doc.get("rank") is None:
        doc["rank"] = await _next_rank(db, owner_org_id)
    await db[COLLECTION].insert_one(doc)
    logger.info("Leave type created", leave_type_id=doc["_id"], code=payload.code)
    await emit_audit(
        action="leave_type.created",
        resource=f"leave_type:{doc['_id']}",
        actor_id=created_by,
        organisation_id=str(owner_org_id) if owner_org_id else None,
        details={"code": payload.code},
    )
    return doc


async def list_leave_types(
    db: AsyncIOMotorDatabase, org_id: str, *, eligible_for: dict | None = None
) -> list[dict]:
    """Leave types for an org, in display (rank) order.

    ``eligible_for`` is an employee document. Pass it to drop the types that
    employee is restricted out of — Maternity for a man, and so on — which is
    what the apply dropdown wants. Omit it for the admin listing, which must
    show every type regardless of who is looking.
    """
    # Return org-specific types plus system-wide types (org_id=None)
    cursor = db[COLLECTION].find(
        {"$or": [{"org_id": to_oid(org_id)}, {"org_id": None}], "deleted_on": None}
    )
    docs = await cursor.to_list(length=None)
    if eligible_for is not None:
        docs = filter_eligible(docs, eligible_for)
    # Sorted in Python, not Mongo: an unranked legacy type must land LAST, and
    # Mongo's ascending sort puts missing/null first.
    return sort_leave_types(docs)


async def get_employee_for_eligibility(
    db: AsyncIOMotorDatabase, user_id: str
) -> dict | None:
    """The caller's employee replica, or None when they have no record.

    Admins have no row in the employees mirror, and an employee whose gender /
    marital status never synced from IAM has the fields absent — both read as
    "unknown", which the eligibility predicate treats as fail-open.
    """
    return await db["employees"].find_one(
        {"user_id": to_oid(user_id)}, {"gender": 1, "marital_status": 1}
    )


async def get_leave_type(
    db: AsyncIOMotorDatabase, leave_type_id: str, org_id: str | None = None
) -> dict:
    doc = await db[COLLECTION].find_one(
        {"_id": to_oid(leave_type_id), "deleted_on": None, "is_custom": True, **_org_filter(org_id)}
    )
    if not doc:
        raise DomainException(
            message="Leave type not found or you cannot update System Leave Types",
            code="LEAVE_TYPE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def update_leave_type(
    db: AsyncIOMotorDatabase, leave_type_id: str, payload: LeaveTypeUpdate, updated_by: str,
    org_id: str | None = None,
) -> dict:
    existing = await _get_leave_type_by_id(db, leave_type_id, org_id)

    # exclude_unset (not exclude_none): the client sends the full body on every
    # update, so every field it means to change is "set". Using exclude_none
    # would silently drop legitimate clears (e.g. removing max_statutory_days or
    # a restriction by sending null), leaving the old value in place.
    update_data = payload.model_dump(exclude_unset=True, mode="json")
    if not update_data:
        return existing

    if not existing.get("is_custom", True):
        update_data = {k: v for k, v in update_data.items() if k in _SYSTEM_TYPE_UPDATABLE_FIELDS}
        if not update_data:
            return existing

    # Code is now editable — guard the same uniqueness rule the create path
    # enforces, so a rename can't collide with another type in the same org.
    new_code = update_data.get("code")
    if new_code and new_code != existing.get("code"):
        clash = await db[COLLECTION].find_one(
            {
                "_id": {"$ne": to_oid(leave_type_id)},
                "org_id": existing.get("org_id"),
                "code": new_code,
                "deleted_on": None,
            }
        )
        if clash:
            raise DomainException(
                message=f"Leave type with code '{new_code}' already exists",
                code="DUPLICATE_LEAVE_TYPE",
                status_code=status.HTTP_409_CONFLICT,
            )

    # Enforce accrual / carry-forward rules against the merged (persisted +
    # payload) state, so a partial update can't leave the type in a state the
    # create path would reject (e.g. enabling carry-forward without a count, or
    # marking a type unpaid while it still carries forward).
    # Comp-off / expiring and unrestricted types carry no accrual — neither
    # tracks a balance, so skip the accrual rules for them.
    effective_is_comp_off = update_data.get("is_comp_off", existing.get("is_comp_off", False))
    effective_is_unrestricted = update_data.get(
        "is_unrestricted", existing.get("is_unrestricted", False)
    )
    if not effective_is_comp_off and not effective_is_unrestricted:
        effective_is_paid = update_data.get("is_paid_leave", existing.get("is_paid_leave", True))
        effective_is_statutory = update_data.get(
            "is_statutory_leave", existing.get("is_statutory_leave", False)
        )
        effective_accrual_raw = update_data.get("accrual", existing.get("accrual"))
        effective_accrual = (
            LeaveTypeAccrual(**effective_accrual_raw) if effective_accrual_raw else None
        )
        err = accrual_rules_error(effective_is_paid, effective_is_statutory, effective_accrual)
        if err:
            raise DomainException(
                message=err,
                code="INVALID_LEAVE_TYPE_CONFIG",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(updated_by))
    await db[COLLECTION].update_one({"_id": to_oid(leave_type_id)}, {"$set": update_data})
    logger.info("Leave type updated", leave_type_id=leave_type_id)
    await emit_audit(
        action="leave_type.updated",
        resource=f"leave_type:{leave_type_id}",
        actor_id=updated_by,
        organisation_id=str(existing["org_id"]) if existing.get("org_id") else None,
        details=None,
        changed_fields=changed_fields,
    )
    return await _get_leave_type_by_id(db, leave_type_id)


# ---------------------------------------------------------------------------
# Deletion safety: a leave type that a leave plan is built on cannot simply
# vanish. Plans reference leave types two ways — embedded ``leave_type_ids`` on
# the plan doc and rows in ``leave_plan_type_mapping`` — so both are consulted.
# ---------------------------------------------------------------------------


def _plan_is_active(plan: dict) -> bool:
    return plan.get("status") == PLAN_STATUS_ACTIVE or plan.get("is_active") is True


def _plan_summary(plan: dict) -> dict:
    return {
        "id": str(plan["_id"]),
        "name": plan.get("name") or str(plan["_id"]),
        "status": plan.get("status"),
        "is_active": _plan_is_active(plan),
    }


async def _plans_using_leave_type(
    db: AsyncIOMotorDatabase, leave_type_id: str, org_id: str | None = None
) -> list[dict]:
    """Every non-deleted leave plan that references this leave type."""
    lt_oid = to_oid(leave_type_id)

    mapping_docs = await db[PLAN_TYPE_MAPPING_COLLECTION].find(
        {"leave_type_id": lt_oid}, {"leave_plan_id": 1}
    ).to_list(length=None)
    mapped_plan_ids = [d["leave_plan_id"] for d in mapping_docs if d.get("leave_plan_id")]

    or_clauses: list[dict] = [{"leave_type_ids": lt_oid}]
    if mapped_plan_ids:
        or_clauses.append({"_id": {"$in": mapped_plan_ids}})

    query: dict = {"deleted_on": None, "$or": or_clauses}
    if org_id:
        query["org_id"] = {"$in": [to_oid(org_id), str(org_id)]}

    return await db[PLANS_COLLECTION].find(
        query, {"name": 1, "status": 1, "is_active": 1}
    ).sort("name", 1).to_list(length=None)


async def get_leave_type_usage(
    db: AsyncIOMotorDatabase, leave_type_id: str, org_id: str | None = None
) -> dict:
    """
    Report where a leave type is in use so the UI can decide, before firing the
    delete, whether to block outright or ask for confirmation.

      * assigned to an ACTIVE plan  -> cannot delete
      * assigned only to plans that were never activated -> delete allowed, but
        the user is warned which plans it will disappear from
      * not assigned anywhere -> delete freely
    """
    leave_type = await get_leave_type(db, leave_type_id, org_id)
    plans = await _plans_using_leave_type(db, leave_type_id, org_id)

    active_plans = [_plan_summary(p) for p in plans if _plan_is_active(p)]
    inactive_plans = [_plan_summary(p) for p in plans if not _plan_is_active(p)]

    request_count = await db[REQUESTS_COLLECTION].count_documents(
        {"leave_type_id": to_oid(leave_type_id), "deleted_on": None}
    )

    name = leave_type.get("name") or "This leave type"
    if active_plans:
        can_delete = False
        requires_confirmation = False
        message = (
            f"'{name}' is assigned to the active leave plan(s): "
            f"{', '.join(p['name'] for p in active_plans)}. "
            "Remove it from those plans (or deactivate them) before deleting."
        )
    elif inactive_plans:
        can_delete = True
        requires_confirmation = True
        message = (
            f"'{name}' is assigned to the leave plan(s): "
            f"{', '.join(p['name'] for p in inactive_plans)}. "
            "Deleting it will remove it from those plans. Please review them before you continue."
        )
    else:
        can_delete = True
        requires_confirmation = False
        message = f"'{name}' is not assigned to any leave plan and can be deleted."

    return {
        "leave_type_id": str(leave_type["_id"]),
        "name": leave_type.get("name"),
        "code": leave_type.get("code"),
        "in_use": bool(plans),
        "can_delete": can_delete,
        "requires_confirmation": requires_confirmation,
        "message": message,
        "active_plans": active_plans,
        "inactive_plans": inactive_plans,
        "leave_request_count": request_count,
    }


async def delete_leave_type(
    db: AsyncIOMotorDatabase, leave_type_id: str, deleted_by: str, org_id: str | None = None,
    confirm: bool = False,
) -> None:
    existing = await get_leave_type(db, leave_type_id, org_id)

    usage = await get_leave_type_usage(db, leave_type_id, org_id)
    if not usage["can_delete"]:
        raise DomainException(
            message=usage["message"],
            code="LEAVE_TYPE_IN_USE_BY_ACTIVE_PLAN",
            status_code=status.HTTP_409_CONFLICT,
        )
    if usage["requires_confirmation"] and not confirm:
        # Not an error the user can't get past — the client re-sends with
        # confirm=true once the person has acknowledged the warning.
        raise DomainException(
            message=usage["message"],
            code="LEAVE_TYPE_DELETE_CONFIRMATION_REQUIRED",
            status_code=status.HTTP_409_CONFLICT,
        )

    # Detach from the (non-active) plans that referenced it, so no plan is left
    # pointing at a deleted type.
    detached_plan_ids = [p["id"] for p in usage["inactive_plans"]]
    if detached_plan_ids:
        plan_oids = [to_oid(pid) for pid in detached_plan_ids]
        await db[PLANS_COLLECTION].update_many(
            {"_id": {"$in": plan_oids}},
            {
                "$pull": {"leave_type_ids": to_oid(leave_type_id)},
                "$set": audit_fields_update(deleted_by),
            },
        )
        await db[PLAN_TYPE_MAPPING_COLLECTION].delete_many(
            {"leave_plan_id": {"$in": plan_oids}, "leave_type_id": to_oid(leave_type_id)}
        )
        logger.info(
            "Leave type detached from leave plans",
            leave_type_id=leave_type_id,
            leave_plan_ids=detached_plan_ids,
        )

    await db[COLLECTION].update_one(
        {"_id": to_oid(leave_type_id)},
        {"$set": audit_fields_delete(deleted_by)},
    )
    logger.info("Leave type deleted", leave_type_id=leave_type_id)
    await emit_audit(
        action="leave_type.deleted",
        resource=f"leave_type:{leave_type_id}",
        actor_id=deleted_by,
        organisation_id=str(existing["org_id"]) if existing.get("org_id") else None,
        details={"detached_leave_plan_ids": detached_plan_ids} if detached_plan_ids else None,
    )
