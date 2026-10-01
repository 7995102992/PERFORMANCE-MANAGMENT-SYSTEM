import asyncio
import uuid

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.leave_entitlements.schemas import probation_leave_type_ids
from src.leave_plans.schemas import GrantPolicyPayload, LeavePlanCreate, LeavePlanLeaveTypesPayload, LeavePlanUpdate
from src.logger import logger
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update
from src.utils import to_oid

PLANS_COLLECTION = "leave_plans"
TYPE_MAPPING_COLLECTION = "leave_plan_type_mapping"
ENTITLEMENTS_COLLECTION = "leave_entitlement_configurations"

PLAN_STATUS_PENDING = "pending_configuration"
PLAN_STATUS_ACTIVE = "active"
PLAN_STATUS_INACTIVE = "inactive"


def _assert_plan_pending(plan: dict) -> None:
    if plan.get("status") == PLAN_STATUS_ACTIVE:
        raise DomainException(
            message="Leave plan is already active. Configuration changes are not allowed.",
            code="LEAVE_PLAN_ALREADY_ACTIVE",
            status_code=status.HTTP_409_CONFLICT,
        )


async def create_leave_plan(
    db: AsyncIOMotorDatabase, payload: LeavePlanCreate, created_by: str
) -> dict:
    existing = await db[PLANS_COLLECTION].find_one(
        {"org_id": to_oid(payload.org_id), "name": payload.name, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"Leave plan named '{payload.name}' already exists",
            code="DUPLICATE_LEAVE_PLAN",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        **payload.model_dump(mode="json"),
        "status": PLAN_STATUS_PENDING,
        "is_active": False,
        "progress": 1,
        "org_id": to_oid(payload.org_id),
        "asset_id": to_oid(payload.asset_id),
        "business_unit_ids": [to_oid(i) for i in payload.business_unit_ids],
        "department_ids": [to_oid(i) for i in payload.department_ids],
        **audit_fields_create(created_by)
    }
    await db[PLANS_COLLECTION].insert_one(doc)
    logger.info("Leave plan created", leave_plan_id=doc["_id"], name=payload.name)
    await emit_audit(
        action="leave_plan.created",
        resource=f"leave_plan:{doc['_id']}",
        actor_id=created_by,
        organisation_id=str(payload.org_id),
        details={"name": payload.name},
    )
    return doc


async def list_leave_plans(db: AsyncIOMotorDatabase, org_id: str) -> list[dict]:
    pipeline = [
        {"$match": {"org_id": to_oid(org_id), "deleted_on": None}},
        {"$lookup": {
            "from": "assets",
            "let": {"aid": "$asset_id"},
            "pipeline": [
                {"$match": {"$expr": {"$and": [
                    {"$ne": ["$$aid", None]},
                    {"$eq": ["$_id", {"$toObjectId": "$$aid"}]},
                    {"$eq": ["$deleted_on", None]},
                ]}}},
            ],
            "as": "_asset_list",
        }},
        {"$addFields": {"asset": {"$first": "$_asset_list"}}},
        {"$unset": "_asset_list"},
        {"$lookup": {
            "from": "business_units",
            "let": {"bu_ids": {"$ifNull": ["$business_unit_ids", []]}},
            "pipeline": [
                {"$match": {"$expr": {"$in": ["$_id", "$$bu_ids"]}}},
                {"$project": {"_id": 0, "id": {"$toString": "$_id"}, "name": 1}},
            ],
            "as": "business_units",
        }},
        {"$lookup": {
            "from": "departments",
            "let": {"dept_ids": {"$ifNull": ["$department_ids", []]}},
            "pipeline": [
                {"$match": {"$expr": {"$in": ["$_id", "$$dept_ids"]}}},
                {"$project": {"_id": 0, "id": {"$toString": "$_id"}, "name": 1}},
            ],
            "as": "departments",
        }},
        {"$sort": {"name": 1}},
    ]
    return await db[PLANS_COLLECTION].aggregate(pipeline).to_list(length=None)


async def _get_raw_leave_plan(db: AsyncIOMotorDatabase, plan_id: str) -> dict:
    doc = await db[PLANS_COLLECTION].find_one({"_id": to_oid(plan_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def get_leave_plan(db: AsyncIOMotorDatabase, plan_id: str) -> dict:
    doc = await _get_raw_leave_plan(db, plan_id)

    fetches: dict[str, any] = {}
    if doc.get("asset_id"):
        fetches["asset"] = db["assets"].find_one(
            {"_id": to_oid(doc["asset_id"]), "deleted_on": None}
        )
    bu_ids = doc.get("business_unit_ids") or []
    dept_ids = doc.get("department_ids") or []
    if bu_ids:
        fetches["bus"] = db["business_units"].find(
            {"_id": {"$in": bu_ids}}, {"_id": 1, "name": 1}
        ).to_list(length=None)
    if dept_ids:
        fetches["depts"] = db["departments"].find(
            {"_id": {"$in": dept_ids}}, {"_id": 1, "name": 1}
        ).to_list(length=None)

    if fetches:
        results = await asyncio.gather(*fetches.values())
        resolved = dict(zip(fetches.keys(), results))
    else:
        resolved = {}

    doc["asset"] = resolved.get("asset")
    doc["business_units"] = [
        {"id": str(d["_id"]), "name": d["name"]} for d in resolved.get("bus", [])
    ]
    doc["departments"] = [
        {"id": str(d["_id"]), "name": d["name"]} for d in resolved.get("depts", [])
    ]
    return doc


async def update_leave_plan(
    db: AsyncIOMotorDatabase, plan_id: str, payload: LeavePlanUpdate, updated_by: str
) -> dict:
    existing = await _get_raw_leave_plan(db, plan_id)
    _assert_plan_pending(existing)

    update_data = payload.model_dump(exclude_unset=True, mode="json")
    if not update_data:
        return existing

    if "asset_id" in update_data:
        update_data["asset_id"] = to_oid(update_data["asset_id"])
    if "business_unit_ids" in update_data:
        update_data["business_unit_ids"] = [to_oid(i) for i in update_data["business_unit_ids"]]
    if "department_ids" in update_data:
        update_data["department_ids"] = [to_oid(i) for i in update_data["department_ids"]]

    update_data.update(audit_fields_update(updated_by))
    await db[PLANS_COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": update_data})
    logger.info("Leave plan updated", leave_plan_id=plan_id)
    await emit_audit(
        action="leave_plan.updated",
        resource=f"leave_plan:{plan_id}",
        actor_id=updated_by,
        organisation_id=str(existing.get("org_id")) if existing.get("org_id") else None,
        changed_fields=list(payload.model_dump(exclude_unset=True, mode="json").keys()),
    )
    return await get_leave_plan(db, plan_id)


# ---------------------------------------------------------------------------
# Leave-type removal guard
#
# Later wizard steps point at a leave type *by id* (probation funds one specific
# type; clubbing restricts a list). Those pointers are validated when the later
# step is saved, but nothing re-checked them when step 2 changed afterwards — so
# going back and dropping a type left the plan configured against a type it no
# longer has. Removal now has to clear these dependencies first.
# ---------------------------------------------------------------------------


async def _plan_leave_type_ids(db: AsyncIOMotorDatabase, plan_id: str, plan: dict) -> set[str]:
    """Types currently on the plan, from both write paths (embedded + mapping)."""
    mapping_docs = await db[TYPE_MAPPING_COLLECTION].find(
        {"leave_plan_id": to_oid(plan_id)}, {"leave_type_id": 1}
    ).to_list(length=None)
    return {
        *(str(x) for x in plan.get("leave_type_ids") or []),
        *(str(d["leave_type_id"]) for d in mapping_docs if d.get("leave_type_id")),
    }


async def _plan_config_dependencies(
    db: AsyncIOMotorDatabase, plan_id: str, leave_type_ids: list[str]
) -> dict[str, list[str]]:
    """Which of these leave types a later step of the plan points at.

    Returns ``{leave_type_id: ["probation settings ...", ...]}`` — empty when
    none of them is referenced.
    """
    if not leave_type_ids:
        return {}

    wanted = {str(i) for i in leave_type_ids}
    deps: dict[str, list[str]] = {}

    def _mark(lt_id: str | None, label: str) -> None:
        if lt_id and str(lt_id) in wanted:
            labels = deps.setdefault(str(lt_id), [])
            if label not in labels:
                labels.append(label)

    entitlement_doc = await db[ENTITLEMENTS_COLLECTION].find_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
    )
    entitlement = (entitlement_doc or {}).get("entitlement") or {}

    probation = entitlement.get("probation") or {}
    for lt_id in probation_leave_type_ids(probation):
        _mark(lt_id, "probation settings (probation leave type)")

    clubbing = entitlement.get("clubbing") or {}
    for lt_id in clubbing.get("restricted_leave_type_ids") or []:
        _mark(lt_id, "clubbing restrictions")

    return deps


async def _leave_type_names(db: AsyncIOMotorDatabase, leave_type_ids: list[str]) -> dict[str, str]:
    if not leave_type_ids:
        return {}
    docs = await db["leave_types"].find(
        {"_id": {"$in": [to_oid(i) for i in leave_type_ids]}}, {"name": 1}
    ).to_list(length=None)
    return {str(d["_id"]): d.get("name") or str(d["_id"]) for d in docs}


def _dependency_message(deps: dict[str, list[str]], names: dict[str, str]) -> str:
    parts = [
        f"'{names.get(lt_id, lt_id)}' is used by this plan's {' and '.join(labels)}"
        for lt_id, labels in deps.items()
    ]
    return (
        f"{'; '.join(parts)}. Assign a different leave type there before removing it "
        "from this plan."
    )


async def assert_leave_types_removable(
    db: AsyncIOMotorDatabase, plan_id: str, leave_type_ids: list[str]
) -> None:
    """Refuse to remove a leave type a later step of this plan depends on."""
    deps = await _plan_config_dependencies(db, plan_id, leave_type_ids)
    if not deps:
        return
    names = await _leave_type_names(db, list(deps))
    raise DomainException(
        message=_dependency_message(deps, names),
        code="LEAVE_TYPE_USED_IN_PLAN_CONFIG",
        status_code=status.HTTP_409_CONFLICT,
    )


async def check_leave_type_removable(
    db: AsyncIOMotorDatabase, plan_id: str, leave_type_id: str
) -> dict:
    """Pre-check for the wizard: may this type be taken off the plan, and if not, why?"""
    plan = await _get_raw_leave_plan(db, plan_id)
    plan_is_active = plan.get("status") == PLAN_STATUS_ACTIVE

    deps = await _plan_config_dependencies(db, plan_id, [leave_type_id])
    names = await _leave_type_names(db, [leave_type_id])
    name = names.get(str(leave_type_id))
    used_by = deps.get(str(leave_type_id), [])

    if plan_is_active:
        message = (
            "This leave plan is active — its leave types can no longer be changed. "
            "Deactivate the plan first."
        )
    elif used_by:
        message = _dependency_message({str(leave_type_id): used_by}, names)
    else:
        message = f"'{name or leave_type_id}' can be removed from this plan."

    return {
        "leave_plan_id": str(plan["_id"]),
        "leave_type_id": str(leave_type_id),
        "name": name,
        "can_remove": not plan_is_active and not used_by,
        "plan_is_active": plan_is_active,
        "used_by": used_by,
        "message": message,
    }


async def set_leave_types_on_plan(
    db: AsyncIOMotorDatabase, plan_id: str, payload: LeavePlanLeaveTypesPayload, updated_by: str
) -> dict:
    existing = await _get_raw_leave_plan(db, plan_id)
    _assert_plan_pending(existing)

    leave_type_oids = [to_oid(lt_id) for lt_id in payload.leave_type_ids]

    # This payload replaces the whole list, so anything missing from it is being
    # removed — and a removal must not orphan a later step's configuration.
    kept_ids = {str(oid) for oid in leave_type_oids}
    removed_ids = sorted(await _plan_leave_type_ids(db, plan_id, existing) - kept_ids)
    if removed_ids:
        await assert_leave_types_removable(db, plan_id, removed_ids)

    if leave_type_oids:
        existing_count = await db["leave_types"].count_documents(
            {"_id": {"$in": leave_type_oids}, "deleted_on": None}
        )
        if existing_count != len(leave_type_oids):
            raise DomainException(
                message="One or more leave type IDs are invalid or not found",
                code="INVALID_LEAVE_TYPE_IDS",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

    update_data = {"leave_type_ids": leave_type_oids, **audit_fields_update(updated_by)}
    await db[PLANS_COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": update_data})
    if removed_ids:
        # Drop the mapping rows too, or the removed type would still show up via
        # the mapping-backed read path.
        await db[TYPE_MAPPING_COLLECTION].delete_many(
            {
                "leave_plan_id": to_oid(plan_id),
                "leave_type_id": {"$in": [to_oid(i) for i in removed_ids]},
            }
        )
    logger.info("Leave plan leave types updated", leave_plan_id=plan_id)
    await emit_audit(
        action="leave_plan.updated",
        resource=f"leave_plan:{plan_id}",
        actor_id=updated_by,
        organisation_id=str(existing.get("org_id")) if existing.get("org_id") else None,
        changed_fields=["leave_type_ids"],
    )
    return await get_leave_plan(db, plan_id)


async def set_grant_policy(
    db: AsyncIOMotorDatabase, plan_id: str, payload: GrantPolicyPayload, updated_by: str
) -> dict:
    existing = await _get_raw_leave_plan(db, plan_id)
    _assert_plan_pending(existing)
    update_data = {
        "grant_policy": payload.model_dump(mode="json"),
        **audit_fields_update(updated_by),
    }
    await db[PLANS_COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": update_data})
    logger.info("Grant policy set", leave_plan_id=plan_id)
    await emit_audit(
        action="leave_plan.updated",
        resource=f"leave_plan:{plan_id}",
        actor_id=updated_by,
        organisation_id=str(existing.get("org_id")) if existing.get("org_id") else None,
        changed_fields=["grant_policy"],
    )
    return await get_leave_plan(db, plan_id)


async def activate_leave_plan(
    db: AsyncIOMotorDatabase, plan_id: str, updated_by: str
) -> dict:
    from src.leave_plan_assignments.service import ASSIGNMENTS_COLLECTION

    plan = await _get_raw_leave_plan(db, plan_id)
    if plan.get("status") == PLAN_STATUS_ACTIVE:
        raise DomainException(
            message="Leave plan is already active",
            code="LEAVE_PLAN_ALREADY_ACTIVE",
            status_code=status.HTTP_409_CONFLICT,
        )

    # Fetch all prerequisite data in parallel.
    (
        grant_policy,
        entitlement_doc,
        sandwich_doc,
        approval_doc,
        all_assignments,
        other_active_plans,
    ) = await asyncio.gather(
        db["leave_grant_policy"].find_one(
            {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
        ),
        db["leave_entitlement_configurations"].find_one(
            {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
        ),
        db["leave_sandwich_policies"].find_one(
            {"leave_plan_id": to_oid(plan_id)}
        ),
        db["leave_approval_policies"].find_one(
            {"leave_plan_id": to_oid(plan_id)}
        ),
        db[ASSIGNMENTS_COLLECTION].find(
            {"leave_plan_id": to_oid(plan_id), "deleted_on": None},
            {"scope_type": 1, "department_id": 1, "business_unit_id": 1},
        ).to_list(length=None),
        db[PLANS_COLLECTION].find(
            {"is_active": True, "deleted_on": None, "_id": {"$ne": to_oid(plan_id)}},
            {"_id": 1},
        ).to_list(length=None),
    )

    # ── Policy existence checks ───────────────────────────────────────────────
    # NOTE: the grant policy is no longer a separate prerequisite. Its remaining
    # fields (joining_rule, extra_leave) were merged into the entitlement config,
    # so a missing grant policy is fine as long as the entitlement exists.
    if not entitlement_doc:
        raise DomainException(
            message="Cannot activate: entitlement configuration has not been set for this plan",
            code="MISSING_ENTITLEMENT_CONFIG",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not sandwich_doc:
        raise DomainException(
            message="Cannot activate: sandwich policy has not been configured for this plan",
            code="MISSING_SANDWICH_POLICY",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not approval_doc:
        raise DomainException(
            message="Cannot activate: approval policy has not been configured for this plan",
            code="MISSING_APPROVAL_POLICY",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    # Year-end processing is now derived from each leave type's carry-forward and
    # encashment settings — there is no separate year-end policy to configure, so
    # it is no longer an activation prerequisite.

    # ── BU and department conflict checks ─────────────────────────────────────
    # Re-validate that no BU or department assigned to this plan is already
    # active under another plan. This catches conflicts that arose after
    # assignments were saved (e.g. the other plan was activated in the meantime).
    if all_assignments and other_active_plans:
        other_plan_ids = [p["_id"] for p in other_active_plans]

        # A DEPARTMENT assignment is scoped to a (department, business_unit) pair —
        # the same department under a different BU is a distinct employee set, not
        # a conflict — so match conflicts on BOTH ids (mirrors resolve_employee_plan).
        dept_pairs = [
            (a["department_id"], a.get("business_unit_id"))
            for a in all_assignments
            if a.get("scope_type") == "DEPARTMENT" and a.get("department_id")
        ]
        bu_ids = [
            a["business_unit_id"]
            for a in all_assignments
            if a.get("scope_type") == "BU" and a.get("business_unit_id")
        ]

        if dept_pairs:
            dept_or = []
            for _dept_id, _bu_id in dept_pairs:
                cond = {"department_id": _dept_id}
                if _bu_id:
                    cond["business_unit_id"] = _bu_id
                dept_or.append(cond)
            dept_conflicts = await db[ASSIGNMENTS_COLLECTION].find(
                {
                    "scope_type": "DEPARTMENT",
                    "leave_plan_id": {"$in": other_plan_ids},
                    "deleted_on": None,
                    "$or": dept_or,
                },
                {"department_id": 1},
            ).to_list(length=None)
            if dept_conflicts:
                conflict_oids = list({c["department_id"] for c in dept_conflicts})
                dept_docs = await db["departments"].find(
                    {"_id": {"$in": conflict_oids}}, {"name": 1}
                ).to_list(length=None)
                names = [d.get("name") or str(d["_id"]) for d in dept_docs] or [
                    str(o) for o in conflict_oids
                ]
                raise DomainException(
                    message=(
                        f"Cannot activate: the following department(s) are already assigned "
                        f"to an active leave plan: {', '.join(names)}"
                    ),
                    code="DEPARTMENT_CONFLICT_ON_ACTIVATION",
                    status_code=status.HTTP_409_CONFLICT,
                )

        if bu_ids:
            bu_conflicts = await db[ASSIGNMENTS_COLLECTION].find(
                {
                    "scope_type": "BU",
                    "business_unit_id": {"$in": bu_ids},
                    "leave_plan_id": {"$in": other_plan_ids},
                    "deleted_on": None,
                },
                {"business_unit_id": 1},
            ).to_list(length=None)
            if bu_conflicts:
                conflict_oids = list({c["business_unit_id"] for c in bu_conflicts})
                bu_docs = await db["business_units"].find(
                    {"_id": {"$in": conflict_oids}}, {"name": 1}
                ).to_list(length=None)
                names = [d.get("name") or str(d["_id"]) for d in bu_docs] or [
                    str(o) for o in conflict_oids
                ]
                raise DomainException(
                    message=(
                        f"Cannot activate: the following business unit(s) are already assigned "
                        f"to an active leave plan: {', '.join(names)}"
                    ),
                    code="BU_CONFLICT_ON_ACTIVATION",
                    status_code=status.HTTP_409_CONFLICT,
                )

    update_data = {
        "status": PLAN_STATUS_ACTIVE,
        "is_active": True,
        **audit_fields_update(updated_by),
    }
    await db[PLANS_COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": update_data})
    logger.info("Leave plan activated", leave_plan_id=plan_id)
    await emit_audit(
        action="leave_plan.activated",
        resource=f"leave_plan:{plan_id}",
        actor_id=updated_by,
        organisation_id=str(plan.get("org_id")) if plan.get("org_id") else None,
    )
    return await get_leave_plan(db, plan_id)


async def deactivate_leave_plan(
    db: AsyncIOMotorDatabase, plan_id: str, updated_by: str
) -> dict:
    plan = await _get_raw_leave_plan(db, plan_id)
    if plan.get("status") != PLAN_STATUS_ACTIVE:
        raise DomainException(
            message="Only an active leave plan can be deactivated",
            code="LEAVE_PLAN_NOT_ACTIVE",
            status_code=status.HTTP_409_CONFLICT,
        )
    update_data = {
        "status": PLAN_STATUS_INACTIVE,
        "is_active": False,
        **audit_fields_update(updated_by),
    }
    await db[PLANS_COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": update_data})
    logger.info("Leave plan deactivated", leave_plan_id=plan_id)
    await emit_audit(
        action="leave_plan.deactivated",
        resource=f"leave_plan:{plan_id}",
        actor_id=updated_by,
        organisation_id=str(plan.get("org_id")) if plan.get("org_id") else None,
    )
    return await get_leave_plan(db, plan_id)


async def delete_leave_plan(
    db: AsyncIOMotorDatabase, plan_id: str, deleted_by: str
) -> None:
    plan = await _get_raw_leave_plan(db, plan_id)
    await db[PLANS_COLLECTION].update_one(
        {"_id": to_oid(plan_id)},
        {"$set": audit_fields_delete(deleted_by)},
    )
    logger.info("Leave plan deleted", leave_plan_id=plan_id)
    await emit_audit(
        action="leave_plan.deleted",
        resource=f"leave_plan:{plan_id}",
        actor_id=deleted_by,
        organisation_id=str(plan.get("org_id")) if plan.get("org_id") else None,
    )



