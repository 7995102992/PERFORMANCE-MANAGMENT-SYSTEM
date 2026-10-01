import json
from datetime import datetime, timezone

import aio_pika
from bson import ObjectId
from bson.errors import InvalidId

from src.clients.iam_master_data import (
    sync_employment_statuses_to_valkey,
    sync_employment_types_to_valkey,
)
from src.audit import emit_activity, emit_audit
from src.database import get_db
from src.employment_status import EMPLOYMENT_STATUSES_COLLECTION, get_inactive_status_ids
from src.employment_type import EMPLOYMENT_TYPES_COLLECTION
from src.logger import logger
from src.messaging.constants.exchanges import Exchanges
from src.messaging.constants.queues import Queues
from src.messaging.middleware.retry import requeue_with_backoff
from src.rabbitmq import get_connection, get_rabbitmq_channel


# ─── Helpers ──────────────────────────────────────────────────────────────────

def to_oid(val):
    """Strict conversion — raises InvalidId for non-hex strings. Use only for _id fields."""
    return ObjectId(val) if val else None


def safe_oid(val):
    """
    Convert to ObjectId when val is a valid 24-char hex string.
    Falls back to the raw string for values like "system", "migration", or any
    other non-hex actor identifier. Returns None for falsy values.
    """
    if not val:
        return None
    try:
        return ObjectId(val)
    except (InvalidId, TypeError):
        return val


def _extract_fields(payload: dict, exclude: set[str]) -> dict:
    """Return all payload keys except those in `exclude`."""
    return {k: v for k, v in payload.items() if k not in exclude}


def _convert_oids(doc: dict, fields: list[str]) -> None:
    """In-place: apply safe_oid to the specified fields if present in doc."""
    for field in fields:
        if field in doc:
            doc[field] = safe_oid(doc[field])


# ─── Idempotency ──────────────────────────────────────────────────────────────

async def _is_duplicate(idempotency_key: str) -> bool:
    db = get_db()
    return await db["processed_domain_events"].find_one({"_id": idempotency_key}) is not None


async def _mark_processed(idempotency_key: str, event_type: str) -> None:
    db = get_db()
    await db["processed_domain_events"].update_one(
        {"_id": idempotency_key},
        {"$setOnInsert": {
            "_id": idempotency_key,
            "event_type": event_type,
            "processed_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )


# ─── Handlers — employees ─────────────────────────────────────────────────────

_EMPLOYEE_OID_FIELDS = [
    "user_id", "organisation_id",
    "l1_manager_id", "l2_manager_id",
    "designation_id", "department_id", "business_unit_id",
    "employment_status", "employment_type", "project_status", "source_of_hire",
    "permanent_address_id", "present_address_id",
]
_EMPLOYEE_ACTOR_FIELDS = ["created_by", "modified_by", "deleted_by"]


async def _handle_employee_created(payload: dict) -> None:
    employee_id = payload.get("employee_id")
    if not employee_id:
        logger.warning("employee.created missing employee_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"employee_id", "correlation_id"})
    _convert_oids(doc, _EMPLOYEE_OID_FIELDS)
    # Actor fields may be "system" — use safe conversion
    _convert_oids(doc, _EMPLOYEE_ACTOR_FIELDS)
    doc["is_deleted"] = False

    await db["employees"].update_one(
        {"_id": to_oid(employee_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("Employee upserted from domain event", employee_id=employee_id)

    # --- Joining-month pro-rata ---
    # The accrual cron is forward-only and runs monthly, so it only ever credits
    # the periods anchored in its own month. A joiner who arrives mid-month is
    # first seen by the NEXT month's run, which no longer offers their joining
    # period — so the partial first month has to be credited here, at the point we
    # learn about them. credit_employee_on_plan_entry writes the same period keys
    # the cron uses, so the next run no-ops on _already_credited.
    #
    # Anchored on date_of_joining, not "now": a delayed or replayed event must not
    # pro-rate from the wrong day, and under a monthly cron a delay that crosses a
    # month boundary would otherwise land the credit on the wrong period key.
    # credit_employee_on_plan_entry refuses anchors outside the current leave year,
    # which is what stops an IAM backfill from crediting historical joiners.
    # Best-effort — never breaks the employee upsert.
    try:
        # _parse_date is the accrual engine's own parser (str / date / datetime);
        # reuse it so the anchor is read exactly the way _credit_employee reads it.
        from src.leave_balance_processor.processor import (
            _parse_date,
            credit_employee_on_plan_entry,
        )

        emp = await db["employees"].find_one(
            {"_id": to_oid(employee_id)},
            {"user_id": 1, "date_of_joining": 1, "joining_date": 1},
        ) or {}
        user_id = emp.get("user_id")
        joining_raw = emp.get("date_of_joining") or emp.get("joining_date")
        joining_date = _parse_date(joining_raw)
        if user_id and joining_date:
            credited = await credit_employee_on_plan_entry(
                db, str(user_id), joining_date
            )
            logger.info(
                "Joining pro-rata triggered on employee.created",
                employee_id=employee_id, entries=credited, anchor=str(joining_date),
            )
        elif user_id and not joining_date:
            logger.warning(
                "employee.created has no usable joining date; no pro-rata credited",
                employee_id=employee_id, raw=repr(joining_raw),
            )
    except Exception as exc:
        logger.error(
            "Joining pro-rata handling failed",
            employee_id=employee_id, error=repr(exc),
        )


async def _handle_employee_updated(payload: dict) -> None:
    employee_id = payload.get("employee_id")
    if not employee_id:
        logger.warning("employee.updated missing employee_id", payload=payload)
        return

    db = get_db()

    # Capture the OLD employment status before we overwrite it, so we can detect a
    # probation → permanent transition (the confirmation) further down.
    prior = await db["employees"].find_one(
        {"_id": to_oid(employee_id)},
        {"employment_status": 1, "organisation_id": 1, "user_id": 1},
    )
    old_status_oid = prior.get("employment_status") if prior else None

    # Build update from every field in the payload except meta/id fields.
    # For reference fields, use `in` check rather than None check so that
    # explicit null in the payload clears the association.
    ALWAYS_INCLUDE = {
        "organisation_id", "l1_manager_id", "l2_manager_id",
        "designation_id", "department_id", "business_unit_id",
        "created_by", "modified_by", "deleted_by",
    }
    # effective_date / applied_fields / queued_fields / effective_dates are
    # IAM's effective-dated change metadata (which tracked fields changed and
    # when they take/took effect) — event envelope info, not employee fields.
    EXCLUDE = {
        "employee_id", "correlation_id", "changed_fields",
        "effective_date", "applied_fields", "queued_fields", "effective_dates",
    }

    fields: dict = {}
    for key, value in payload.items():
        if key in EXCLUDE:
            continue
        if key in ALWAYS_INCLUDE or value is not None:
            fields[key] = value

    _convert_oids(fields, _EMPLOYEE_OID_FIELDS)
    _convert_oids(fields, _EMPLOYEE_ACTOR_FIELDS)

    if fields:
        await db["employees"].update_one(
            {"_id": to_oid(employee_id)}, {"$set": fields}, upsert=True
        )
        logger.info("Employee updated from domain event", employee_id=employee_id)

    # --- Status transitions OUT of probation ---
    # Decide allocation purely from the employment status change. Best-effort —
    # never breaks the employee update.
    new_status_raw = payload.get("employment_status")
    if new_status_raw and old_status_oid is not None:
        try:
            from src.clients.iam_master_data import fetch_employment_statuses
            from src.leave_balance_processor.processor import credit_employee_on_plan_entry

            org_id = str(prior.get("organisation_id")) if prior and prior.get("organisation_id") else None
            iam_statuses = await fetch_employment_statuses(organisation_id=org_id)

            def _is_probation(info: dict) -> bool:
                return "probation" in (info.get("key") or "").lower() \
                    or "probation" in (info.get("value") or "").lower()

            def _is_notice(info: dict) -> bool:
                return "notice" in (info.get("key") or "").lower() \
                    or "notice" in (info.get("value") or "").lower()

            old_info = iam_statuses.get(str(old_status_oid)) or {}
            new_info = iam_statuses.get(str(new_status_raw)) or {}
            user_id = prior.get("user_id") if prior else None

            # Only a genuine CONFIRMATION allocates the normal plan: probation → an
            # active, non-probation, non-notice status (i.e. permanent/confirmed).
            #   probation → notice  → keep the balance (usable during notice); the
            #                         notice-period rules apply automatically.
            #   probation → exit/inactive → no allocation (blocked, leaves cancelled).
            is_confirmation = (
                _is_probation(old_info)
                and new_info.get("is_active", True) is not False
                and not _is_probation(new_info)
                and not _is_notice(new_info)
            )
            if is_confirmation and user_id:
                # Anchor on the recorded confirmation_date when we have one, not on
                # the moment we happen to process the event. A delayed or replayed
                # event would otherwise pro-rate from the wrong day, and under the
                # monthly forward-only cron a delay crossing a month boundary would
                # put the credit on the wrong period key entirely. Falls back to
                # today when IAM sent no confirmation_date.
                from src.leave_balance_processor.processor import _parse_date

                anchor = (
                    _parse_date(payload.get("confirmation_date"))
                    or datetime.now(timezone.utc).date()
                )
                credited = await credit_employee_on_plan_entry(
                    db, str(user_id), anchor
                )
                logger.info(
                    "Confirmation pro-rata triggered on status change",
                    employee_id=employee_id, entries=credited, anchor=str(anchor),
                )
        except Exception as exc:
            logger.error(
                "Probation status-transition handling failed",
                employee_id=employee_id, error=repr(exc),
            )

    # Cancel pending/approved leaves when employment ends
    raw_status = payload.get("employment_status")
    if raw_status:
        status_oid = safe_oid(raw_status)
        inactive_ids = await get_inactive_status_ids(db)
        # leave_requests are keyed by the owner's user_id (not employee _id), so
        # cancel by user_id — already projected onto `prior`.
        owner_user_id = prior.get("user_id") if prior else None
        if status_oid in inactive_ids and owner_user_id:
            now = datetime.now(timezone.utc)
            # Capture the request ids first so we can release their balance holds
            # after cancelling — otherwise the reserved balance is stranded forever.
            cancel_filter = {
                "user_id": owner_user_id,
                "status": {"$in": ["PENDING", "APPROVED"]},
            }
            cancelled_ids = [
                doc["_id"]
                async for doc in db["leave_requests"].find(cancel_filter, {"_id": 1})
            ]
            result = await db["leave_requests"].update_many(
                cancel_filter,
                {"$set": {"status": "CANCELLED", "modified_on": now, "modified_by": "system"}},
            )
            # Release the balance holds reserved by the now-cancelled requests.
            from src.leave_holds.service import release_hold
            for request_id in cancelled_ids:
                await release_hold(db, str(request_id), "system")
            if result.modified_count:
                logger.info(
                    "Leave requests cancelled due to employment status change",
                    employee_id=employee_id,
                    employment_status=str(status_oid),
                    count=result.modified_count,
                )
                # System-driven lifecycle cancellation — surface to the
                # employee (activity) and record for compliance (audit).
                _cancel_details = {"count": result.modified_count, "reason": "employment_ended"}
                _emp_org = await db["employees"].find_one(
                    {"_id": to_oid(employee_id)}, {"organisation_id": 1}
                )
                _org_id = str(_emp_org["organisation_id"]) if _emp_org and _emp_org.get("organisation_id") else None
                await emit_activity(
                    action="leave_request.cancelled",
                    resource=f"employee:{employee_id}",
                    actor_id="system",
                    organisation_id=_org_id,
                    details=_cancel_details,
                )
                await emit_audit(
                    action="leave_request.cancelled",
                    resource=f"employee:{employee_id}",
                    actor_id="system",
                    organisation_id=_org_id,
                    details=_cancel_details,
                )


async def _handle_employee_deleted(payload: dict) -> None:
    # employee.deleted carries user_id (auth ID), not employee_id
    user_id = payload.get("user_id")
    if not user_id:
        logger.warning("employee.deleted missing user_id", payload=payload)
        return

    db = get_db()
    now = datetime.now(timezone.utc)

    employee = await db["employees"].find_one({"user_id": safe_oid(user_id)})
    if not employee:
        logger.warning("employee.deleted: no employee record for user_id", user_id=user_id)
        return

    await db["employees"].update_one(
        {"_id": employee["_id"]},
        {"$set": {"is_deleted": True}},
    )

    result = await db["leave_requests"].update_many(
        {
            "employee_id": employee["_id"],
            "status": {"$in": ["PENDING", "APPROVED"]},
            "start_datetime": {"$gte": now},
        },
        {"$set": {"status": "CANCELLED", "modified_on": now, "modified_by": "system"}},
    )
    if result.modified_count:
        logger.info(
            "Future leave requests cancelled on employee deletion",
            user_id=user_id,
            count=result.modified_count,
        )
        # System-driven lifecycle cancellation — activity + compliance audit.
        _cancel_details = {"count": result.modified_count, "reason": "employee_deleted"}
        _org_id = str(employee["organisation_id"]) if employee.get("organisation_id") else None
        await emit_activity(
            action="leave_request.cancelled",
            resource=f"employee:{employee['_id']}",
            actor_id="system",
            organisation_id=_org_id,
            details=_cancel_details,
        )
        await emit_audit(
            action="leave_request.cancelled",
            resource=f"employee:{employee['_id']}",
            actor_id="system",
            organisation_id=_org_id,
            details=_cancel_details,
        )
    logger.info("Employee soft-deleted from domain event", user_id=user_id)


# ─── Handlers — organisations ─────────────────────────────────────────────────

_ORG_ACTOR_FIELDS = ["created_by", "modified_by", "deleted_by"]


async def _handle_organisation_created(payload: dict) -> None:
    org_id = payload.get("organisation_id")
    if not org_id:
        logger.warning("organisation.created missing organisation_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"organisation_id", "correlation_id"})
    _convert_oids(doc, _ORG_ACTOR_FIELDS)
    doc["is_deleted"] = False

    await db["organisations"].update_one(
        {"_id": to_oid(org_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("Organisation upserted from domain event", org_id=org_id)


async def _handle_organisation_updated(payload: dict) -> None:
    org_id = payload.get("organisation_id")
    if not org_id:
        logger.warning("organisation.updated missing organisation_id", payload=payload)
        return

    ALWAYS_INCLUDE = {"created_by", "modified_by", "deleted_by"}
    EXCLUDE = {"organisation_id", "correlation_id", "changed_fields"}

    fields: dict = {}
    for key, value in payload.items():
        if key in EXCLUDE:
            continue
        if key in ALWAYS_INCLUDE or value is not None:
            fields[key] = value

    _convert_oids(fields, _ORG_ACTOR_FIELDS)

    if not fields:
        return
    db = get_db()
    await db["organisations"].update_one({"_id": to_oid(org_id)}, {"$set": fields})
    logger.info("Organisation updated from domain event", org_id=org_id)


async def _handle_organisation_deleted(payload: dict) -> None:
    org_id = payload.get("organisation_id")
    if not org_id:
        logger.warning("organisation.deleted missing organisation_id", payload=payload)
        return
    db = get_db()
    doc = _extract_fields(payload, exclude={"organisation_id", "correlation_id"})
    _convert_oids(doc, _ORG_ACTOR_FIELDS)
    doc["is_deleted"] = True
    await db["organisations"].update_one({"_id": to_oid(org_id)}, {"$set": doc})
    logger.info("Organisation soft-deleted from domain event", org_id=org_id)


# ─── Handlers — business units ────────────────────────────────────────────────

async def _handle_business_unit_created(payload: dict) -> None:
    bu_id = payload.get("business_unit_id")
    if not bu_id:
        logger.warning("business_unit.created missing business_unit_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"business_unit_id", "correlation_id"})
    # Codebase queries business_units by org_id — remap the incoming field name
    if "organisation_id" in doc:
        doc["org_id"] = to_oid(doc.pop("organisation_id"))
    # IDs arrive as strings over the wire — store as ObjectId so they match
    # the _id type elsewhere (e.g. users/employees collections).
    if "head_user_id" in doc:
        doc["head_user_id"] = safe_oid(doc["head_user_id"])
    doc.setdefault("is_deleted", False)

    await db["business_units"].update_one(
        {"_id": to_oid(bu_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("Business unit upserted from domain event", bu_id=bu_id)


async def _handle_business_unit_updated(payload: dict) -> None:
    bu_id = payload.get("business_unit_id")
    if not bu_id:
        logger.warning("business_unit.updated missing business_unit_id", payload=payload)
        return

    EXCLUDE = {"business_unit_id", "correlation_id", "changed_fields"}
    fields: dict = {k: v for k, v in payload.items() if k not in EXCLUDE and v is not None}
    if "organisation_id" in fields:
        fields["org_id"] = to_oid(fields.pop("organisation_id"))
    if "head_user_id" in fields:
        fields["head_user_id"] = safe_oid(fields["head_user_id"])

    if not fields:
        return
    db = get_db()
    await db["business_units"].update_one({"_id": to_oid(bu_id)}, {"$set": fields})
    logger.info("Business unit updated from domain event", bu_id=bu_id)


async def _handle_business_unit_deleted(payload: dict) -> None:
    bu_id = payload.get("business_unit_id")
    if not bu_id:
        logger.warning("business_unit.deleted missing business_unit_id", payload=payload)
        return
    db = get_db()
    await db["business_units"].update_one({"_id": to_oid(bu_id)}, {"$set": {"is_deleted": True}})
    logger.info("Business unit soft-deleted from domain event", bu_id=bu_id)


# ─── Handlers — departments ───────────────────────────────────────────────────

async def _handle_department_created(payload: dict) -> None:
    dept_id = payload.get("department_id")
    if not dept_id:
        logger.warning("department.created missing department_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"department_id", "correlation_id"})
    if "organisation_id" in doc:
        doc["org_id"] = to_oid(doc.pop("organisation_id"))
    if "business_unit_id" in doc:
        doc["business_unit_id"] = safe_oid(doc["business_unit_id"])
    if "business_unit_ids" in doc:
        doc["business_unit_ids"] = [safe_oid(bid) for bid in (doc["business_unit_ids"] or [])]
    if "department_head" in doc:
        doc["department_head"] = safe_oid(doc["department_head"])
    doc.setdefault("is_deleted", False)

    await db["departments"].update_one(
        {"_id": to_oid(dept_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("Department upserted from domain event", dept_id=dept_id)


async def _handle_department_updated(payload: dict) -> None:
    dept_id = payload.get("department_id")
    if not dept_id:
        logger.warning("department.updated missing department_id", payload=payload)
        return

    ALWAYS_INCLUDE = {"organisation_id", "business_unit_id", "business_unit_ids"}
    EXCLUDE = {"department_id", "correlation_id", "changed_fields"}

    fields: dict = {}
    for key, value in payload.items():
        if key in EXCLUDE:
            continue
        if key in ALWAYS_INCLUDE or value is not None:
            fields[key] = value

    if "organisation_id" in fields:
        fields["org_id"] = to_oid(fields.pop("organisation_id"))
    if "business_unit_id" in fields:
        fields["business_unit_id"] = safe_oid(fields["business_unit_id"])
    if "business_unit_ids" in fields:
        fields["business_unit_ids"] = [safe_oid(bid) for bid in (fields["business_unit_ids"] or [])]
    if "department_head" in fields:
        fields["department_head"] = safe_oid(fields["department_head"])

    if not fields:
        return
    db = get_db()
    await db["departments"].update_one({"_id": to_oid(dept_id)}, {"$set": fields})
    logger.info("Department updated from domain event", dept_id=dept_id)


async def _handle_department_deleted(payload: dict) -> None:
    dept_id = payload.get("department_id")
    if not dept_id:
        logger.warning("department.deleted missing department_id", payload=payload)
        return
    db = get_db()
    await db["departments"].update_one({"_id": to_oid(dept_id)}, {"$set": {"is_deleted": True}})
    logger.info("Department soft-deleted from domain event", dept_id=dept_id)


# ─── Handlers — designations ──────────────────────────────────────────────────

async def _handle_designation_created(payload: dict) -> None:
    designation_id = payload.get("designation_id")
    if not designation_id:
        logger.warning("designation.created missing designation_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"designation_id", "correlation_id"})
    if "organisation_id" in doc:
        doc["org_id"] = to_oid(doc.pop("organisation_id"))
    if "department_id" in doc:
        doc["department_id"] = safe_oid(doc["department_id"])
    doc.setdefault("is_deleted", False)

    await db["designations"].update_one(
        {"_id": to_oid(designation_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("Designation upserted from domain event", designation_id=designation_id)


async def _handle_designation_updated(payload: dict) -> None:
    designation_id = payload.get("designation_id")
    if not designation_id:
        logger.warning("designation.updated missing designation_id", payload=payload)
        return

    EXCLUDE = {"designation_id", "correlation_id", "changed_fields"}
    fields: dict = {k: v for k, v in payload.items() if k not in EXCLUDE and v is not None}
    if "organisation_id" in fields:
        fields["org_id"] = to_oid(fields.pop("organisation_id"))
    if "department_id" in fields:
        fields["department_id"] = safe_oid(fields["department_id"])

    if not fields:
        return
    db = get_db()
    await db["designations"].update_one({"_id": to_oid(designation_id)}, {"$set": fields})
    logger.info("Designation updated from domain event", designation_id=designation_id)


async def _handle_designation_deleted(payload: dict) -> None:
    designation_id = payload.get("designation_id")
    if not designation_id:
        logger.warning("designation.deleted missing designation_id", payload=payload)
        return
    db = get_db()
    await db["designations"].update_one({"_id": to_oid(designation_id)}, {"$set": {"is_deleted": True}})
    logger.info("Designation soft-deleted from domain event", designation_id=designation_id)


# ─── Handlers — policies ──────────────────────────────────────────────────────

async def _handle_policy_created(payload: dict) -> None:
    policy_id = payload.get("policy_id")
    if not policy_id:
        logger.warning("policy.created missing policy_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"policy_id", "correlation_id"})
    doc.setdefault("is_deleted", False)

    await db["policies"].update_one(
        {"_id": to_oid(policy_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("Policy upserted from domain event", policy_id=policy_id)


async def _handle_policy_deleted(payload: dict) -> None:
    policy_id = payload.get("policy_id")
    if not policy_id:
        logger.warning("policy.deleted missing policy_id", payload=payload)
        return
    db = get_db()
    await db["policies"].update_one({"_id": to_oid(policy_id)}, {"$set": {"is_deleted": True}})
    logger.info("Policy soft-deleted from domain event", policy_id=policy_id)


# ─── Handlers — users ─────────────────────────────────────────────────────────

_USER_ACTOR_FIELDS = ["created_by", "modified_by", "deleted_by", "organisation_id", "org_id"]


async def _handle_user_created(payload: dict) -> None:
    user_id = payload.get("user_id")
    if not user_id:
        logger.warning("user.created missing user_id", payload=payload)
        return

    db = get_db()
    doc = _extract_fields(payload, exclude={"user_id", "correlation_id"})
    _convert_oids(doc, _USER_ACTOR_FIELDS)
    doc.setdefault("is_deleted", False)

    await db["users"].update_one(
        {"_id": safe_oid(user_id)},
        {"$set": doc},
        upsert=True,
    )
    logger.info("User upserted from domain event", user_id=user_id)


async def _handle_user_updated(payload: dict) -> None:
    user_id = payload.get("user_id")
    if not user_id:
        logger.warning("user.updated missing user_id", payload=payload)
        return

    # avatar_* are nullable on purpose: "photo removed" arrives as None and
    # must clear the mirror, not be skipped as a missing field.
    ALWAYS_INCLUDE = {
        "created_by", "modified_by", "deleted_by",
        "avatar_url", "avatar_asset_id",
    }
    EXCLUDE = {"user_id", "correlation_id", "changed_fields"}

    fields: dict = {}
    for key, value in payload.items():
        if key in EXCLUDE:
            continue
        if key in ALWAYS_INCLUDE or value is not None:
            fields[key] = value

    _convert_oids(fields, _USER_ACTOR_FIELDS)

    if not fields:
        return
    db = get_db()
    await db["users"].update_one({"_id": safe_oid(user_id)}, {"$set": fields})
    logger.info("User updated from domain event", user_id=user_id)


async def _handle_user_deleted(payload: dict) -> None:
    user_id = payload.get("user_id")
    if not user_id:
        logger.warning("user.deleted missing user_id", payload=payload)
        return
    db = get_db()
    await db["users"].update_one({"_id": safe_oid(user_id)}, {"$set": {"is_deleted": True}})
    logger.info("User soft-deleted from domain event", user_id=user_id)


# ─── Handlers — employment statuses ──────────────────────────────────────────


async def _handle_employment_status_created(payload: dict) -> None:
    status_id = payload.get("id") or payload.get("_id")
    if not status_id:
        logger.warning("employment_status.created missing id", payload=payload)
        return

    db = get_db()
    doc = {
        "key": payload.get("key"),
        "value": payload.get("value"),
        "is_active": payload.get("isActive", payload.get("is_active", True)),
    }
    await db[EMPLOYMENT_STATUSES_COLLECTION].update_one(
        {"_id": to_oid(status_id)},
        {"$set": doc},
        upsert=True,
    )
    await sync_employment_statuses_to_valkey()
    logger.info("Employment status upserted from domain event", status_id=status_id)


async def _handle_employment_status_updated(payload: dict) -> None:
    status_id = payload.get("id") or payload.get("_id")
    if not status_id:
        logger.warning("employment_status.updated missing id", payload=payload)
        return

    db = get_db()
    fields = {}
    for src_key, dst_key in (("key", "key"), ("value", "value"), ("isActive", "is_active"), ("is_active", "is_active")):
        if src_key in payload:
            fields[dst_key] = payload[src_key]

    if not fields:
        return
    await db[EMPLOYMENT_STATUSES_COLLECTION].update_one(
        {"_id": to_oid(status_id)},
        {"$set": fields},
    )
    await sync_employment_statuses_to_valkey()
    logger.info("Employment status updated from domain event", status_id=status_id)


async def _handle_employment_status_deleted(payload: dict) -> None:
    status_id = payload.get("id") or payload.get("_id")
    if not status_id:
        logger.warning("employment_status.deleted missing id", payload=payload)
        return

    db = get_db()
    await db[EMPLOYMENT_STATUSES_COLLECTION].delete_one({"_id": to_oid(status_id)})
    await sync_employment_statuses_to_valkey()
    logger.info("Employment status deleted from domain event", status_id=status_id)


# ─── Handlers — employment types ─────────────────────────────────────────────


async def _handle_employment_type_created(payload: dict) -> None:
    type_id = payload.get("id") or payload.get("_id")
    if not type_id:
        logger.warning("employment_type.created missing id", payload=payload)
        return

    db = get_db()
    doc = {
        "key": payload.get("key"),
        "value": payload.get("value"),
        "is_active": payload.get("isActive", payload.get("is_active", True)),
    }
    await db[EMPLOYMENT_TYPES_COLLECTION].update_one(
        {"_id": to_oid(type_id)},
        {"$set": doc},
        upsert=True,
    )
    await sync_employment_types_to_valkey()
    logger.info("Employment type upserted from domain event", type_id=type_id)


async def _handle_employment_type_updated(payload: dict) -> None:
    type_id = payload.get("id") or payload.get("_id")
    if not type_id:
        logger.warning("employment_type.updated missing id", payload=payload)
        return

    db = get_db()
    fields = {}
    for src_key, dst_key in (("key", "key"), ("value", "value"), ("isActive", "is_active"), ("is_active", "is_active")):
        if src_key in payload:
            fields[dst_key] = payload[src_key]

    if not fields:
        return
    await db[EMPLOYMENT_TYPES_COLLECTION].update_one(
        {"_id": to_oid(type_id)},
        {"$set": fields},
    )
    await sync_employment_types_to_valkey()
    logger.info("Employment type updated from domain event", type_id=type_id)


async def _handle_employment_type_deleted(payload: dict) -> None:
    type_id = payload.get("id") or payload.get("_id")
    if not type_id:
        logger.warning("employment_type.deleted missing id", payload=payload)
        return

    db = get_db()
    await db[EMPLOYMENT_TYPES_COLLECTION].delete_one({"_id": to_oid(type_id)})
    await sync_employment_types_to_valkey()
    logger.info("Employment type deleted from domain event", type_id=type_id)


# ─── Dispatch table ───────────────────────────────────────────────────────────

_HANDLERS = {
    "employee.created":       _handle_employee_created,
    "employee.updated":       _handle_employee_updated,
    "employee.deleted":       _handle_employee_deleted,
    "organisation.created":   _handle_organisation_created,
    "organisation.updated":   _handle_organisation_updated,
    "organisation.deleted":   _handle_organisation_deleted,
    "business_unit.created":  _handle_business_unit_created,
    "business_unit.updated":  _handle_business_unit_updated,
    "business_unit.deleted":  _handle_business_unit_deleted,
    "department.created":     _handle_department_created,
    "department.updated":     _handle_department_updated,
    "department.deleted":     _handle_department_deleted,
    "designation.created":    _handle_designation_created,
    "designation.updated":    _handle_designation_updated,
    "designation.deleted":    _handle_designation_deleted,
    "policy.created":         _handle_policy_created,
    "policy.deleted":         _handle_policy_deleted,
    "user.created":           _handle_user_created,
    "user.updated":           _handle_user_updated,
    "user.deleted":           _handle_user_deleted,
    "employment_status.created": _handle_employment_status_created,
    "employment_status.updated": _handle_employment_status_updated,
    "employment_status.deleted": _handle_employment_status_deleted,
    "employment_type.created": _handle_employment_type_created,
    "employment_type.updated": _handle_employment_type_updated,
    "employment_type.deleted": _handle_employment_type_deleted,
}


# ─── Message processor ────────────────────────────────────────────────────────

async def _process_domain_event(message: aio_pika.IncomingMessage) -> None:
    try:
        body = json.loads(message.body)
    except json.JSONDecodeError as exc:
        logger.error("Invalid JSON in domain event", error=str(exc))
        await message.ack()
        return

    event_type = message.routing_key or body.get("event_type", "")
    idempotency_key: str | None = (message.headers or {}).get("idempotency_key")

    if idempotency_key and await _is_duplicate(idempotency_key):
        logger.info(
            "Duplicate domain event skipped",
            event_type=event_type,
            idempotency_key=idempotency_key,
        )
        await message.ack()
        return

    handler = _HANDLERS.get(event_type)
    if not handler:
        logger.warning("No handler for domain event type", event_type=event_type)
        await message.ack()
        return

    payload = body.get("payload", body)

    try:
        await handler(payload)
        if idempotency_key:
            await _mark_processed(idempotency_key, event_type)
        await message.ack()
    except Exception as exc:
        logger.error("Failed to process domain event", event_type=event_type, error=str(exc))
        async with get_rabbitmq_channel() as ch:
            exchange = await ch.get_exchange(Exchanges.DOMAIN_EVENTS, ensure=False)
            await requeue_with_backoff(message, exchange, str(exc))


# ─── Consumer startup ─────────────────────────────────────────────────────────

async def start_domain_events_consumer() -> None:
    channel = await get_connection().channel()
    await channel.set_qos(prefetch_count=10)
    queue = await channel.get_queue(Queues.DOMAIN_EVENTS, ensure=False)
    await queue.consume(_process_domain_event)
    logger.info("Domain events consumer started", queue=Queues.DOMAIN_EVENTS)
