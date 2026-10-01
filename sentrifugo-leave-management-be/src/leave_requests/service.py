import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from bson import ObjectId
from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.exceptions import DomainException
from src.leave_requests.schemas import (
    ApprovalActionPayload,
    ApprovalFlowCreate,
    ApprovalOverrideCreate,
    CancellationActionPayload,
    LeaveRequestCreate,
    ToggleConfigUpsert,
)
from src.leave_requests.validation import (
    compute_duration_for_mode,
    dates_to_datetimes,
    should_count_weekends_for_lop,
    validate_and_compute,
    validate_comp_off_worked_days,
    _working_day_list,
)
from src.assets.service import generate_presigned_url
from src.balance_tracker import (
    TRACKER_COLLECTION,
    get_available_balance,
    get_balance_from_tracker,
    upsert_balance,
)
from src.leave_holds.service import (
    convert_hold,
    create_hold,
    get_active_hold_hours,
    get_active_hold_hours_bulk,
    release_hold,
)
from src.clients.iam_master_data import fetch_employment_statuses
from src.employment_status import deactivated_user_ids
from src.leave_entitlements.schemas import probation_leave_type_ids
from src.leave_types.eligibility import (
    filter_eligible,
    ineligibility_reason,
    is_unrestricted_type,
)
from src.leave_types.service import leave_type_sort_key
from src.config import settings
from src.logger import logger
from src.messaging import email_events
from src.audit import emit_activity, emit_audit
from src.models import audit_fields_create, audit_fields_update
from src.utils import to_oid, uid_match

REQUESTS_COLLECTION = "leave_requests"
FLOWS_COLLECTION = "approval_flows"
ACTIVITY_COLLECTION = "leave_request_activity"
OVERRIDES_COLLECTION = "approval_overrides"

# Counted as "used" by the usage warning: already taken, plus what is in flight.
# Pending is included deliberately — an approver deciding on a request needs to
# see the requests queued behind it, or two approvers each wave through what
# looks like a first request.
USAGE_COUNTED_STATUSES = ("PENDING", "APPROVED")


async def _leave_year_start(db: AsyncIOMotorDatabase, plan_oid) -> date:
    """First day of the leave year in progress for this plan.

    Driven by the plan's year-end ``calendar_start_month`` (the same config
    `_current_cycle_end` reads in the dashboard), falling back to 1 January so a
    plan without year-end configuration still yields a sane window.
    """
    calendar_start_month = 1
    if plan_oid is not None:
        config = await db["leave_plan_year_end_processing"].find_one(
            {"leave_plan_id": plan_oid, "deleted_on": None}
        )
        if config and config.get("calendar_start_month"):
            calendar_start_month = int(config["calendar_start_month"])

    today = date.today()
    start_year = today.year if today.month >= calendar_start_month else today.year - 1
    return date(start_year, calendar_start_month, 1)


async def get_leave_type_usage(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id,
    plan_oid=None,
) -> dict:
    """Days of one leave type this employee has used in the current leave year.

    Unrestricted leave keeps no balance, so there is no tracker to read — this
    aggregates the requests themselves. Requests are matched on ``start_date``
    (an ISO string in this collection) falling inside the leave year.
    """
    year_start = await _leave_year_start(db, plan_oid)
    cursor = db[REQUESTS_COLLECTION].find(
        {
            "user_id": to_oid(user_id),
            "leave_type_id": to_oid(leave_type_id),
            "status": {"$in": list(USAGE_COUNTED_STATUSES)},
            "start_date": {"$gte": year_start.isoformat()},
            "deleted_on": None,
        },
        {"duration_hours": 1, "status": 1},
    )
    used_hours = 0.0
    pending_hours = 0.0
    async for row in cursor:
        hours = float(row.get("duration_hours") or 0.0)
        used_hours += hours
        if row.get("status") == "PENDING":
            pending_hours += hours

    return {
        "days_used": round(used_hours / 8.0, 2),
        "pending_days": round(pending_hours / 8.0, 2),
        "period_start": year_start.isoformat(),
        "period_label": str(year_start.year),
    }


async def _get_employee(db: AsyncIOMotorDatabase, employee_id) -> Optional[dict]:
    """Resolve an id that points at a person to their ``employees`` row.

    The id may be the employee document's ``_id`` or their ``user_id``, and
    either an ObjectId or its 24-hex string — the replica has been written both
    ways (see ``attendance.service._manager_refs`` and
    ``dashboard.service.team_out_today``, which both match on both), and an
    ``approver_id`` taken from the auth context is a ``user_id``, never an
    employee ``_id``. Matching only one shape silently returns None, which
    drops the approver from the notification list or blanks
    ``{{approver_name}}`` in the decision mail with no error and no log. Try
    every shape instead.
    """
    if not employee_id:
        return None
    candidates: list = []
    for candidate in (employee_id, str(employee_id)):
        if candidate not in candidates:
            candidates.append(candidate)
    try:
        oid = to_oid(employee_id)
    except Exception:  # not a valid ObjectId — the string forms still apply
        oid = None
    if oid is not None and oid not in candidates:
        candidates.append(oid)
    return await db["employees"].find_one(
        {"$or": [{"_id": {"$in": candidates}}, {"user_id": {"$in": candidates}}]}
    )


async def _find_manager(db: AsyncIOMotorDatabase, mgr_id) -> Optional[dict]:
    """Resolve an ``l1_manager_id`` / ``l2_manager_id`` to its employees row.

    Same id-shape problem as any other employee reference — see
    ``_get_employee``, which this delegates to.
    """
    return await _get_employee(db, mgr_id)


def email_date_strings(request: dict) -> tuple[str, str]:
    """The request's FROM/TO dates as the emails must show them (inclusive).

    ``end_datetime`` is stored as an EXCLUSIVE boundary — ``dates_to_datetimes``
    writes ``end_date + 1 day`` for FULL_DAYS — so formatting it directly prints
    one day past the leave: a single day off on the 17th mailed out as
    "17th to 18th" next to "1 day". The document keeps the employee's own
    inclusive dates in ``start_date``/``end_date``, which is what the submission
    mails already use; every other mail should read the same fields.

    Documents written before those fields existed fall back to de-shifting the
    datetimes, which lands on the right day for every duration mode (a half-day
    ending at 12:00 stays on its own date, an exclusive midnight steps back).
    """
    start_str = request.get("start_date") or ""
    if not start_str and request.get("start_datetime"):
        start_str = request["start_datetime"].strftime("%Y-%m-%d")

    end_str = request.get("end_date") or ""
    if not end_str and request.get("end_datetime"):
        end_str = (request["end_datetime"] - timedelta(microseconds=1)).strftime("%Y-%m-%d")

    return start_str, end_str


def _hr_notify_emails() -> list[str]:
    """HR inboxes copied on every leave submission, from LEAVE_HR_NOTIFY_EMAILS."""
    raw = settings.LEAVE_HR_NOTIFY_EMAILS or ""
    return [addr.strip() for addr in raw.split(",") if addr.strip()]


async def _decision_notice_recipients(
    db: AsyncIOMotorDatabase, employee_doc: dict | None
) -> list[tuple[str, str]]:
    """(email, name) pairs told when a request is approved or rejected.

    The employee's L1 manager plus the configured HR inboxes. Deduped on the
    address so an HR mailbox that is also the manager gets one mail, not two.
    """
    recipients: list[tuple[str, str]] = []
    seen: set[str] = set()

    l1_id = (employee_doc or {}).get("l1_manager_id")
    if l1_id:
        l1_emp = await _find_manager(db, l1_id)
        if l1_emp and l1_emp.get("work_email"):
            recipients.append((l1_emp["work_email"], l1_emp.get("name", "")))
            seen.add(l1_emp["work_email"].lower())
        else:
            logger.warning(
                "L1 manager unresolved — decision notice will skip them",
                l1_manager_id=str(l1_id),
            )

    for hr_email in _hr_notify_emails():
        if hr_email.lower() not in seen:
            recipients.append((hr_email, "HR"))
            seen.add(hr_email.lower())

    return recipients


async def _get_first_approver_info(
    db: AsyncIOMotorDatabase,
    employee_doc: dict,
    leave_plan_id: Optional[str],
) -> tuple[str, str]:
    """Return (work_email, name) for the first-level approver. Falls back to l1_manager_id."""
    if leave_plan_id:
        flow = await get_approval_flow_by_plan(db, leave_plan_id)
        if flow and flow.get("levels"):
            levels = sorted(
                flow["levels"],
                key=lambda lv: lv.get("level", 0) if isinstance(lv, dict) else 0,
            )
            first = levels[0] if levels else None
            if first and first.get("type") == "USER" and first.get("value"):
                approver_emp = await db["employees"].find_one({"user_id": to_oid(first["value"])})
                if not approver_emp:
                    approver_emp = await db["employees"].find_one({"_id": first["value"]})
                if approver_emp and approver_emp.get("work_email"):
                    return approver_emp["work_email"], approver_emp.get("name", "")
    mgr_id = employee_doc.get("l1_manager_id")
    if mgr_id:
        mgr_emp = await _find_manager(db, mgr_id)
        if mgr_emp and mgr_emp.get("work_email"):
            return mgr_emp["work_email"], mgr_emp.get("name", "")
    return "", ""


async def _get_all_approvers_info(
    db: AsyncIOMotorDatabase,
    employee_doc: dict,
    leave_plan_id: Optional[str],
) -> list[tuple[int, str, str]]:
    """Return [(level, work_email, name), ...] for every configured approver.

    Source of truth is the plan's approval_flow when it exists — every
    level configured there is notified at submission so AND / OR policies
    surface to both approvers in parallel instead of L2 only seeing the
    request after L1 has already acted.

    When no flow is configured, falls back to the employee's manager chain:
      L1 → l1_manager_id (always), L2 → l2_manager_id (only when the plan's
      approval policy actually declares a second level).
    """
    approvers: list[tuple[int, str, str]] = []

    flow = await get_approval_flow_by_plan(db, leave_plan_id) if leave_plan_id else None
    if flow and flow.get("levels"):
        sorted_levels = sorted(
            flow["levels"],
            key=lambda lv: lv.get("level", 0) if isinstance(lv, dict) else 0,
        )
        for lv in sorted_levels:
            level = lv.get("level", 0)
            # ROLE-typed approvers aren't resolvable to a single inbox today;
            # skip them rather than emailing nobody.
            if lv.get("type") != "USER" or not lv.get("value"):
                continue
            approver_emp = await db["employees"].find_one({"user_id": to_oid(lv["value"])})
            if not approver_emp:
                approver_emp = await db["employees"].find_one({"_id": lv["value"]})
            if approver_emp and approver_emp.get("work_email"):
                approvers.append((level, approver_emp["work_email"], approver_emp.get("name", "")))
        if approvers:
            return approvers

    # Fallback path: use l1/l2 manager_id off the employee doc. We only
    # expand to L2 when the approval policy explicitly configures level 2,
    # otherwise a plan with single-level approval would suddenly start
    # emailing both managers.
    policy_levels = 1
    if leave_plan_id:
        policy = await db["leave_approval_policies"].find_one(
            {"leave_plan_id": to_oid(leave_plan_id)}
        )
        if policy and policy.get("approval_levels"):
            policy_levels = len(policy["approval_levels"])

    l1_id = employee_doc.get("l1_manager_id")
    if l1_id:
        l1_emp = await _find_manager(db, l1_id)
        if l1_emp and l1_emp.get("work_email"):
            approvers.append((1, l1_emp["work_email"], l1_emp.get("name", "")))
        else:
            # Loud on purpose: this used to fail silently, and a manager who
            # never receives an approval mail is indistinguishable from one who
            # ignores it.
            logger.warning(
                "L1 approver unresolved — no approval email will be sent",
                l1_manager_id=str(l1_id),
                resolved=bool(l1_emp),
                has_work_email=bool(l1_emp and l1_emp.get("work_email")),
            )

    if policy_levels >= 2:
        l2_id = employee_doc.get("l2_manager_id")
        if l2_id:
            l2_emp = await _find_manager(db, l2_id)
            if l2_emp and l2_emp.get("work_email"):
                approvers.append((2, l2_emp["work_email"], l2_emp.get("name", "")))
            else:
                logger.warning(
                    "L2 approver unresolved — no approval email will be sent",
                    l2_manager_id=str(l2_id),
                    resolved=bool(l2_emp),
                    has_work_email=bool(l2_emp and l2_emp.get("work_email")),
                )

    return approvers


async def _get_approver_for_level(
    db: AsyncIOMotorDatabase,
    leave_plan_id: Optional[str],
    level: int,
) -> tuple[str, str]:
    """Return (work_email, name) for the approver at the given approval level."""
    if not leave_plan_id:
        return "", ""
    flow = await get_approval_flow_by_plan(db, leave_plan_id)
    if not flow or not flow.get("levels"):
        return "", ""
    level_cfg = next((lv for lv in flow["levels"] if lv.get("level") == level), None)
    if not level_cfg or level_cfg.get("type") != "USER" or not level_cfg.get("value"):
        return "", ""
    approver_emp = await db["employees"].find_one({"user_id": to_oid(level_cfg["value"])})
    if not approver_emp:
        approver_emp = await db["employees"].find_one({"_id": level_cfg["value"]})
    if approver_emp and approver_emp.get("work_email"):
        return approver_emp["work_email"], approver_emp.get("name", "")
    return "", ""


# ─── Approval Flows ────────────────────────────────────────────────────────────

async def create_approval_flow(
    db: AsyncIOMotorDatabase, payload: ApprovalFlowCreate, created_by: str, org_id: str | None = None
) -> dict:
    plan_query: dict = {"_id": payload.leave_plan_id, "deleted_on": None}
    if org_id:
        # Tenant isolation: only resolve plans belonging to the caller's org.
        # org_id is stored inconsistently (ObjectId vs string) — match both.
        plan_query["org_id"] = {"$in": [to_oid(org_id), str(org_id)]}
    plan = await db["leave_plans"].find_one(plan_query)
    if not plan:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    existing = await db[FLOWS_COLLECTION].find_one(
        {"leave_plan_id": payload.leave_plan_id, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message="An approval flow already exists for this plan",
            code="DUPLICATE_APPROVAL_FLOW",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "_id": str(uuid.uuid4()),
        **payload.model_dump(mode="json"),
        **audit_fields_create(created_by),
    }
    await db[FLOWS_COLLECTION].insert_one(doc)
    logger.info("Approval flow created", flow_id=doc["_id"])

    await emit_audit(
        action="approval_flow.created",
        resource=f"approval_flow:{doc['_id']}",
        actor_id=created_by,
        details={"leave_plan_id": str(payload.leave_plan_id)},
    )
    return doc


async def get_approval_flow_by_plan(
    db: AsyncIOMotorDatabase, plan_id
) -> Optional[dict]:
    # approval_flows stores leave_plan_id as a plain string (from the API payload);
    # callers may pass an ObjectId — normalize to string so the query matches.
    return await db[FLOWS_COLLECTION].find_one(
        {"leave_plan_id": str(plan_id), "deleted_on": None}
    )


async def _plan_skip_days(db: AsyncIOMotorDatabase, plan_id, cache: dict) -> Optional[int]:
    """Return skip_if_no_action_days for a plan's approval flow (cached per call)."""
    key = str(plan_id) if plan_id else None
    if key in cache:
        return cache[key]
    skip_days: Optional[int] = None
    if plan_id:
        flow = await get_approval_flow_by_plan(db, plan_id)
        if flow:
            skip_days = flow.get("skip_if_no_action_days")
    cache[key] = skip_days
    return skip_days


async def enrich_aging(db: AsyncIOMotorDatabase, requests: list[dict]) -> None:
    """Annotate each request with days_pending, is_overdue and aging_status (in place).

    days_pending is measured from created_on. Against the plan's
    skip_if_no_action_days (SLA) the status is one of:
      * "overdue"   — days_pending >= SLA (breached; escalation also fires here)
      * "due_soon"  — within 1 day of the SLA but not yet breached (early warning)
      * "on_track"  — otherwise, or when the plan has no SLA configured

    Aging only applies while a request is still PENDING — approved/rejected/
    cancelled requests are always on_track so an old approved request is never
    wrongly flagged overdue. is_overdue stays True only on actual breach.
    """
    now = datetime.now(timezone.utc)
    skip_cache: dict = {}
    for req in requests:
        if req.get("status") != "PENDING":
            req["days_pending"] = None
            req["is_overdue"] = False
            req["aging_status"] = "on_track"
            continue

        created = req.get("created_on")
        if isinstance(created, datetime):
            created_aware = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
            days_pending = max((now - created_aware).days, 0)
        else:
            days_pending = None
        req["days_pending"] = days_pending

        skip_days = await _plan_skip_days(db, req.get("leave_plan_id"), skip_cache)
        if days_pending is None or skip_days is None:
            req["is_overdue"] = False
            req["aging_status"] = "on_track"
        elif days_pending >= skip_days:
            req["is_overdue"] = True
            req["aging_status"] = "overdue"
        elif days_pending >= skip_days - 1:
            req["is_overdue"] = False
            req["aging_status"] = "due_soon"
        else:
            req["is_overdue"] = False
            req["aging_status"] = "on_track"


async def get_my_approval_chain(db: AsyncIOMotorDatabase, user_id: str) -> Optional[dict]:
    from src.leave_plan_assignments.service import resolve_employee_plan

    employee_doc = await db["employees"].find_one({"user_id": ObjectId(user_id)})
    if not employee_doc:
        raise DomainException(
            message="Employee not found",
            code="EMPLOYEE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    org_id = str(employee_doc["organisation_id"]) if employee_doc.get("organisation_id") else None
    dept_id = str(employee_doc["department_id"]) if employee_doc.get("department_id") else None
    bu_id = str(employee_doc["business_unit_id"]) if employee_doc.get("business_unit_id") else None

    if not org_id:
        raise DomainException(
            message="No leave plan could be resolved — employee has no org context",
            code="NO_LEAVE_PLAN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    emp_plan = await resolve_employee_plan(db, user_id, org_id, dept_id, bu_id)
    if not emp_plan:
        raise DomainException(
            message="No leave plan found for this employee",
            code="NO_LEAVE_PLAN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    return await db["leave_approval_policies"].find_one(
        {"leave_plan_id": to_oid(emp_plan["leave_plan_id"])}
    )


# ─── Leave Requests ─────────────────────────────────────────────────────────────

async def _resolve_policy_for_employee(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: str,
    employee_doc: Optional[dict] = None,
) -> tuple[dict, dict, Optional[str]]:
    from src.leave_plan_assignments.service import resolve_employee_plan
    if employee_doc is None:
        employee_doc = await db["employees"].find_one({"user_id": ObjectId(user_id)})
    if not employee_doc:
        raise DomainException(
            message="Employee not found",
            code="EMPLOYEE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    org_id = str(employee_doc["organisation_id"]) if employee_doc.get("organisation_id") else None
    dept_id = str(employee_doc["department_id"]) if employee_doc.get("department_id") else None
    bu_id = str(employee_doc["business_unit_id"]) if employee_doc.get("business_unit_id") else None
    if not org_id:
        raise DomainException(
            message="No leave plan could be resolved — employee has no org context",
            code="NO_LEAVE_PLAN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    emp_plan = await resolve_employee_plan(db, user_id, org_id, dept_id, bu_id)

    if not emp_plan:
        raise DomainException(
            message="No leave plan found for this employee's department or business unit",
            code="NO_LEAVE_PLAN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    leave_plan_id = emp_plan["leave_plan_id"]

    # The type is loaded BEFORE the entitlement policy is required: an
    # unrestricted type waives that requirement, and we cannot know it is
    # unrestricted until the document is in hand.
    leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
    if not leave_type:
        raise DomainException(
            message="Leave type not found",
            code="LEAVE_TYPE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    policy = await db["leave_entitlement_configurations"].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "deleted_on": None}
    )
    if not policy:
        if not is_unrestricted_type(leave_type):
            raise DomainException(
                message="No entitlement policy found for this leave type under the employee's leave plan",
                code="NO_ENTITLEMENT_POLICY",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        # An empty policy rather than None: every downstream reader digs in with
        # `(policy or {}).get(...)` or `policy.get(...)`, and a dict satisfies
        # both. The absent sub-configs (sandwich, upload, comment, probation)
        # then read as "not configured", which is the correct meaning here.
        policy = {}

    # Guard: the type must actually belong to the employee's plan. Without this a
    # stray/global type (especially non-deducting or is_paid=False) bypasses the
    # plan's balance + policy gates entirely. (Audit B — LEAVE_TYPE_NOT_IN_PLAN)
    in_plan = await db["leave_plan_type_mapping"].find_one({
        "leave_plan_id": to_oid(leave_plan_id),
        "leave_type_id": to_oid(leave_type_id),
    })
    if not in_plan:
        plan_doc = await db["leave_plans"].find_one(
            {"_id": to_oid(leave_plan_id)}, {"leave_type_ids": 1}
        )
        embedded = {str(x) for x in (plan_doc or {}).get("leave_type_ids", [])}
        if str(leave_type_id) not in embedded:
            raise DomainException(
                message="This leave type is not available under your leave plan",
                code="LEAVE_TYPE_NOT_IN_PLAN",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    return policy, leave_type, leave_plan_id


async def get_entitlement_policy_for_employee(
    db: AsyncIOMotorDatabase, user_id: str, leave_type_id: str
) -> dict:
    policy, _, _ = await _resolve_policy_for_employee(db, user_id, leave_type_id)
    return policy


async def _record_activity(
    db: AsyncIOMotorDatabase,
    request_id_oid: ObjectId,
    action: str,
    actor_id: str,
    level: Optional[int] = None,
    comment: Optional[str] = None,
) -> None:
    await db[ACTIVITY_COLLECTION].insert_one({
        "leave_request_id": request_id_oid,
        "action": action,
        "level": level,
        "actor_id": to_oid(actor_id),
        "comment": comment,
        "timestamp": datetime.now(timezone.utc),
    })


def _resolve_upload_requirement(policy: dict, leave_type: dict) -> dict:
    """Upload-requirement config, with the leave type's own policy overriding the
    plan entitlement (matches the overlay used in validate_and_compute)."""
    lt_policies = (leave_type or {}).get("policies") or {}
    if lt_policies.get("upload_requirement") is not None:
        return lt_policies["upload_requirement"] or {}
    return ((policy or {}).get("entitlement") or {}).get("upload_requirement") or {}


def _check_upload_requirement(
    policy: dict, leave_type: dict, asset_ids, duration_days: float
) -> None:
    """Reject the request when a mandatory attachment is missing.

    ``required_after_days`` makes the attachment mandatory only for leaves longer
    than that many days; when unset, a mandatory upload is always required.
    """
    cfg = _resolve_upload_requirement(policy, leave_type)
    if not cfg.get("mandatory"):
        return
    threshold = cfg.get("required_after_days")
    required = threshold is None or duration_days > threshold
    if required and not asset_ids:
        raise DomainException(
            message=(
                "An attachment is required for this leave request"
                + (f" exceeding {threshold} day(s)" if threshold is not None else "")
            ),
            code="UPLOAD_REQUIRED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def _resolve_comment_requirement(policy: dict, leave_type: dict) -> dict:
    """Comment-requirement config, with the leave type's own policy overriding the
    plan entitlement (same overlay as upload/validation)."""
    lt_policies = (leave_type or {}).get("policies") or {}
    if lt_policies.get("comment_requirement") is not None:
        return lt_policies["comment_requirement"] or {}
    return ((policy or {}).get("entitlement") or {}).get("comment_requirement") or {}


def _check_comment_requirement(policy: dict, leave_type: dict, reason) -> None:
    """Reject the request when a mandatory reason/comment is missing."""
    cfg = _resolve_comment_requirement(policy, leave_type)
    if cfg.get("mode") != "mandatory":
        return
    if not (reason and str(reason).strip()):
        raise DomainException(
            message="A reason is required for this leave request",
            code="COMMENT_REQUIRED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def _resolve_notice_period(policy: dict, leave_type: dict) -> dict:
    """Notice-period config, with the leave type's own policy overriding the
    plan entitlement (same overlay as upload/comment/validation)."""
    lt_policies = (leave_type or {}).get("policies") or {}
    if lt_policies.get("notice_period_leave") is not None:
        return lt_policies["notice_period_leave"] or {}
    return ((policy or {}).get("entitlement") or {}).get("notice_period_leave") or {}


def _is_in_notice_period(status_info: Optional[dict], employee: Optional[dict] = None) -> bool:
    """True when the employee is serving notice. Two signals, because IAM
    represents notice two different ways depending on how it was set:

      * Exit-management flow: manager-approve sets UserDocument.status =
        NOTICE_PERIOD and replicates it onto the employee as ``status`` —
        ``employment_status`` is left unchanged. Detected via the replica field.
      * Admin edits the employee form: ``employment_status`` is set to the
        "notice-period" master-data value (still is_active=True). Detected via
        the master-data name (key/value contains "notice").

    A notice-period employee stays active, so neither is caught by the inactive gate.
    """
    if employee and str(employee.get("status") or "").lower() == "notice_period":
        return True
    if status_info:
        key = (status_info.get("key") or "").lower()
        value = (status_info.get("value") or "").lower()
        if "notice" in key or "notice" in value:
            return True
    return False


def _check_notice_period(
    policy: dict, leave_type: dict, status_info: Optional[dict], employee: Optional[dict] = None
) -> None:
    """Honor the notice_period_leave config for employees serving notice.

    mode == "block"  -> reject the request.
    mode == "allow_with_extension" -> allowed here; the actual extension of the
        last working day is an exit-management concern, not enforced in LMS.
    """
    cfg = _resolve_notice_period(policy, leave_type)
    mode = cfg.get("mode")
    if not mode:
        return
    # Honor BOTH notice signals: the master-data employment_status (admin form) AND
    # the replicated employee.status set by the IAM exit flow. Passing `employee`
    # matches the approve-time path, which already checks both.
    if not _is_in_notice_period(status_info, employee):
        return
    if mode == "block":
        raise DomainException(
            message="Leave cannot be applied during your notice period",
            code="NOTICE_PERIOD_BLOCKED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def _is_in_probation(status_info: Optional[dict]) -> bool:
    """True when the employee's employment status is a probation status.

    Probation is signalled only via the master-data employment_status (an admin
    sets it on the employee form); there's no separate UserDocument lifecycle
    value for it, so the replica `status` field is not consulted here.
    """
    if not status_info:
        return False
    key = (status_info.get("key") or "").lower()
    value = (status_info.get("value") or "").lower()
    return "probation" in key or "probation" in value


def _check_probation_leave_type(
    policy: dict, status_info: Optional[dict], requested_leave_type_id
) -> None:
    """While in probation (by status), restrict applications to the single
    configured probation leave type. Only applies in tiered mode with a type
    configured — same_for_all probation has no restriction, and an unconfigured
    type keeps legacy behavior (no restriction)."""
    if not _is_in_probation(status_info):
        return
    probation_cfg = ((policy or {}).get("entitlement") or {}).get("probation") or {}
    if not probation_cfg.get("enabled"):
        return
    if probation_cfg.get("credit_mode") != "tiered_by_duration":
        return
    prob_lt_ids = probation_leave_type_ids(probation_cfg)
    if not prob_lt_ids:
        return
    if str(requested_leave_type_id) not in prob_lt_ids:
        raise DomainException(
            message=(
                "During probation you can only apply for the designated probation "
                "leave type"
                if len(prob_lt_ids) == 1
                else "During probation you can only apply for the designated probation leave types"
            ),
            code="PROBATION_LEAVE_TYPE_RESTRICTED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def _check_eligibility_restrictions(leave_type: dict, employee: Optional[dict]) -> None:
    """Enforce a leave type's gender / marital-status eligibility at apply time.

    The rule itself (token comparison, legacy field fallbacks) lives in
    ``src.leave_types.eligibility``, shared with the listing surfaces so the
    two cannot drift. This is the ENFORCING half: a client can post any
    leave_type_id, so hiding a type in the dropdown is never the control.

    ``unknown_blocks=True`` is the one deliberate difference from the listing.
    A restricted type stays VISIBLE to an employee whose gender / marital
    status never synced from IAM — better than options silently disappearing —
    but it cannot be USED, because treating "unknown" as "eligible" would let
    anyone with a gap in their profile take Maternity Leave. The error names
    the missing field so the employee knows to get their profile completed.
    """
    reason = ineligibility_reason(leave_type, employee, unknown_blocks=True)
    if reason:
        code, message = reason
        raise DomainException(
            message=message,
            code=code,
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def _leave_working_days(db: AsyncIOMotorDatabase, request: dict) -> float:
    """Pure working days of a leave — excludes weekends/holidays and any
    sandwich / LOP weekend charges. Used to extend a notice period by the
    actual number of working days the employee will be absent."""
    from datetime import date as _date

    from src.leave_requests.validation import compute_duration_for_mode

    try:
        sd = _date.fromisoformat(request["start_date"])
        ed = _date.fromisoformat(request["end_date"])
    except Exception:
        return 0.0
    hours = await compute_duration_for_mode(
        db, sd, ed, str(request["user_id"]),
        request.get("duration_mode", "FULL_DAYS"),
        request.get("half_day_period"),
        request.get("start_session"),
        request.get("end_session"),
        count_calendar_days=False,
        include_weekends=False,
    )
    return round(hours / 8.0, 4)


async def _maybe_emit_notice_extension(
    db: AsyncIOMotorDatabase, request: dict, request_id: str
) -> None:
    """On final approval of a notice-period employee's leave whose policy is
    'allow_with_extension', emit a domain event so IAM extends the employee's
    last working day by the leave's working days. Best-effort — never blocks
    the approval itself (caller wraps in try/except)."""
    user_id = request.get("user_id")
    if not user_id:
        return
    emp = await db["employees"].find_one({"user_id": user_id})
    if not emp:
        return
    org_id = str(emp["organisation_id"]) if emp.get("organisation_id") else None
    # Only the exit-management flow can have its last working day extended: it sets
    # the replica status to NOTICE_PERIOD *and* creates an ExitRequestDocument with
    # a real last working day. An admin-form employment_status="notice" master-data
    # value creates no exit record, so emitting/stamping for it would claim an
    # extension IAM cannot apply — gate strictly on the exit-flow replica signal.
    if str(emp.get("status") or "").lower() != "notice_period":
        return

    plan_id = request.get("leave_plan_id")
    policy = None
    if plan_id:
        policy = await db["leave_entitlement_configurations"].find_one(
            {"leave_plan_id": to_oid(str(plan_id)), "deleted_on": None}
        )
    leave_type = await db["leave_types"].find_one({"_id": request["leave_type_id"]})
    if _resolve_notice_period(policy or {}, leave_type or {}).get("mode") != "allow_with_extension":
        return

    working_days = await _leave_working_days(db, request)
    if working_days <= 0:
        return

    from src.messaging.constants.exchanges import Exchanges
    from src.messaging.outbox.worker import publish as _publish

    await _publish(
        "leave.notice_period_changed",
        {
            "action": "extend",
            "user_id": str(user_id),
            "organisation_id": org_id,
            "request_id": request_id,
            "working_days": working_days,
            "start_date": request.get("start_date"),
            "end_date": request.get("end_date"),
        },
        idempotency_key=f"notice_ext:{request_id}",
        exchange=Exchanges.DOMAIN_EVENTS,
    )
    await db[REQUESTS_COLLECTION].update_one(
        {"_id": to_oid(request_id)},
        {"$set": {"notice_extended": True, "notice_extension_days": working_days}},
    )
    logger.info(
        "Emitted notice-period LWD extension",
        request_id=request_id, working_days=working_days,
    )


async def _maybe_emit_notice_reversal(
    db: AsyncIOMotorDatabase, request: dict, request_id: str
) -> None:
    """Reverse a previously-emitted notice-period LWD extension when an
    already-approved leave is undone. Dormant today (approved leaves are
    terminal — cancel/reject are PENDING-only), but wired at the cancel point
    so enabling cancel-of-approved later pulls the last working day back."""
    if not request.get("notice_extended"):
        return
    working_days = request.get("notice_extension_days") or 0
    if working_days <= 0:
        return
    emp = await db["employees"].find_one({"user_id": request.get("user_id")})
    org_id = str(emp["organisation_id"]) if emp and emp.get("organisation_id") else None

    from src.messaging.constants.exchanges import Exchanges
    from src.messaging.outbox.worker import publish as _publish

    await _publish(
        "leave.notice_period_changed",
        {
            "action": "revert",
            "user_id": str(request.get("user_id")),
            "organisation_id": org_id,
            "request_id": request_id,
            "working_days": working_days,
        },
        idempotency_key=f"notice_revert:{request_id}",
        exchange=Exchanges.DOMAIN_EVENTS,
    )
    logger.info(
        "Emitted notice-period LWD reversal",
        request_id=request_id, working_days=working_days,
    )


async def _enforce_no_overreserve(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: str,
    request_id,
    policy: dict,
) -> None:
    """Roll back a just-created hold if concurrent submits over-reserved the balance.

    Holds are summed in ObjectId order (deterministic for near-simultaneous inserts);
    the request whose running hold-total first exceeds the real balance + extra-leave
    buffer is the loser and is removed. Earlier holds survive, so exactly the right
    number of requests are kept.
    """
    from src.balance_tracker import get_raw_balance_unclamped

    my_hold = await db["leave_balance_holds"].find_one(
        {"request_id": str(request_id)}, {"_id": 1}
    )
    if not my_hold:
        return
    raw = await get_raw_balance_unclamped(db, user_id, leave_type_id)
    _ex = ((policy.get("entitlement") or {}).get("extra_leave")) or {}
    extra_hours = (_ex.get("max_days") or 0) * 8.0 if _ex.get("status") == "ALLOWED" else 0.0

    rows = await db["leave_balance_holds"].aggregate([
        {"$match": {
            "user_id": to_oid(user_id),
            "leave_type_id": to_oid(leave_type_id),
            "status": "ACTIVE",
            "_id": {"$lte": my_hold["_id"]},
        }},
        {"$group": {"_id": None, "total": {"$sum": "$hours"}}},
    ]).to_list(length=1)
    running = float(rows[0]["total"]) if rows else 0.0

    if running > raw + extra_hours + 0.001:
        await release_hold(db, str(request_id), user_id)
        await db[REQUESTS_COLLECTION].delete_one({"_id": request_id})
        raise DomainException(
            message="Insufficient leave balance — another request reserved it first",
            code="INSUFFICIENT_BALANCE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def create_leave_request(
    db: AsyncIOMotorDatabase, payload: LeaveRequestCreate, user_id: str, *, loss_of_pay: bool = False
) -> dict:
    employee = await db["employees"].find_one({"user_id": ObjectId(user_id), "is_deleted": {"$ne": True}})

    if not employee:
        raise DomainException(
            message="Employee not found",
            code="EMPLOYEE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # USER-account gate: a soft-deleted user, or one stamped with an ended
    # status key on exit finalisation, can no longer raise leave even if the
    # employee record was never touched.
    if await deactivated_user_ids(db, [user_id]):
        raise DomainException(
            message="Cannot submit a leave request: user account is deactivated",
            code="INACTIVE_USER",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Block leave-request creation for employees whose employment_status is
    # marked inactive in IAM (absconded / exit / retired / terminated). Falls
    # through silently if IAM is unreachable so a transient outage doesn't
    # block legitimate requests.
    emp_status_id = employee.get("employment_status")
    status_info = None
    # The refusal is deferred rather than raised here: an unrestricted leave
    # type waives it, and the type is only resolved below. The lookup still
    # happens now because the notice-period and probation gates need it.
    inactive_status: Optional[dict] = None
    if emp_status_id:
        org_id_for_lookup = (
            str(employee.get("organisation_id"))
            if employee.get("organisation_id") is not None else None
        )
        iam_statuses = await fetch_employment_statuses(organisation_id=org_id_for_lookup)
        status_info = iam_statuses.get(str(emp_status_id))
        if status_info and status_info.get("is_active") is False:
            inactive_status = status_info

    has_l1 = bool(employee.get("l1_manager_id"))
    has_l2 = bool(employee.get("l2_manager_id"))
    if not has_l1 and not has_l2:
        raise DomainException(
            message="Cannot submit a leave request: no reporting manager (L1 or L2) is assigned to your profile",
            code="NO_MANAGER_ASSIGNED",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    policy, leave_type, plan_id = await _resolve_policy_for_employee(
        db, user_id, payload.leave_type_id, employee_doc=employee
    )

    # An unrestricted type waives every employment-status-derived gate below —
    # the inactive-status block, notice period and probation. See
    # `is_unrestricted_type` for what stays enforced.
    unrestricted = is_unrestricted_type(leave_type)

    if inactive_status and not unrestricted:
        raise DomainException(
            message=(
                f"Cannot submit a leave request: employee is in "
                f"'{inactive_status.get('value') or inactive_status.get('key')}' status"
            ),
            code="INACTIVE_EMPLOYEE",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    if not unrestricted:
        # Notice-period gate (honors notice_period_leave.mode: block / allow).
        _check_notice_period(policy, leave_type, status_info, employee=employee)
        # Probation gate: in probation, only the designated probation leave type is allowed.
        _check_probation_leave_type(policy, status_info, payload.leave_type_id)
    # Eligibility gate: gender / marital-status restrictions on the leave type.
    # Enforced for every type — this is who the leave is FOR, which an
    # unrestricted type does not change.
    _check_eligibility_restrictions(leave_type, employee)

    start_datetime, end_datetime = dates_to_datetimes(
        payload.start_date,
        payload.end_date,
        payload.duration_mode.value,
        payload.half_day_period.value if payload.half_day_period else None,
        payload.start_session.value if payload.start_session else None,
        payload.end_session.value if payload.end_session else None,
    )

    # Projected raw balance (for the LOP decision) and projected available
    # balance (raw minus active holds, for the sufficiency check). A new request
    # has no hold yet, so no exclusion is needed here.
    projected_raw = await _projected_balance_hours(
        db, user_id, plan_id, payload.leave_type_id, payload.start_date
    )
    held = await get_active_hold_hours(db, user_id, payload.leave_type_id)
    projected_available = projected_raw - held

    duration_hours = await validate_and_compute(
        db,
        user_id=user_id,
        leave_type_id=payload.leave_type_id,
        start=start_datetime,
        end=end_datetime,
        policy=policy,
        leave_type=leave_type,
        loss_of_pay=loss_of_pay,
        duration_mode=payload.duration_mode.value,
        half_day_period=payload.half_day_period.value if payload.half_day_period else None,
        start_session=payload.start_session.value if payload.start_session else None,
        end_session=payload.end_session.value if payload.end_session else None,
        projected_balance_hours=projected_available,
        lop_balance_hours=projected_raw,
    )

    # Expiring / comp-off leave: no balance — instead each requested day must
    # point to a non-working day the employee worked, within the expiry window.
    if leave_type.get("is_comp_off"):
        if payload.duration_mode.value != "FULL_DAYS":
            raise DomainException(
                message="Expiring (comp-off) leave can only be applied for full days",
                code="COMP_OFF_FULL_DAYS_ONLY",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        comp_off_leave_days = await _working_day_list(
            db, payload.start_date, payload.end_date, user_id
        )
        await validate_comp_off_worked_days(
            db,
            user_id,
            payload.worked_dates,
            comp_off_leave_days,
            leave_type.get("expiry_days"),
            datetime.now(timezone.utc).date(),
        )

    # Mandatory-attachment gate (after duration is known so required_after_days
    # can be evaluated against the real charged days).
    _check_upload_requirement(policy, leave_type, payload.asset_ids, duration_hours / 8.0)
    # Mandatory reason/comment gate.
    _check_comment_requirement(policy, leave_type, payload.reason)

    # Determine whether this request is (or was auto-converted to) Loss of Pay,
    # so weekends are charged and the balance is not debited on approval. LOP is
    # decided on the RAW balance — pending holds never make a request unpaid.
    # "Extra leave" lets a request go paid-negative up to max_days, so within that
    # buffer it's not LOP. (Negative balance proper stays disabled.)
    _extra = ((policy.get("entitlement") or {}).get("extra_leave")) or {}
    allow_negative_balance = bool(_extra.get("status") == "ALLOWED" and (_extra.get("max_days") or 0) > 0)
    is_lop = await should_count_weekends_for_lop(
        db,
        user_id,
        payload.leave_type_id,
        leave_type,
        loss_of_pay=loss_of_pay,
        allow_negative_balance=allow_negative_balance,
        balance_hours=projected_raw,
    )

    now = datetime.now(timezone.utc)
    doc = {
        "user_id": to_oid(user_id),
        "leave_type_id": to_oid(payload.leave_type_id),
        "leave_plan_id": plan_id,
        "loss_of_pay": is_lop,
        "start_date": payload.start_date.isoformat(),
        "end_date": payload.end_date.isoformat(),
        "start_datetime": start_datetime,
        "end_datetime": end_datetime,
        "duration_mode": payload.duration_mode.value,
        "half_day_period": payload.half_day_period.value if payload.half_day_period else None,
        "start_session": payload.start_session.value if payload.start_session else None,
        "end_session": payload.end_session.value if payload.end_session else None,
        "duration_hours": duration_hours,
        "duration_days": duration_hours / 8.0,
        "status": "PENDING",
        # approved_by collects the user_ids who've already approved, so AND
        # policies can surface the request to L1 + L2 in parallel without a
        # single approver being able to satisfy both levels by clicking
        # twice. current_level keeps its existing counter semantics.
        "approval_state": {"current_level": 1, "approved_by": []},
        "reason": payload.reason,
        "notify_cc": payload.notify_cc,
        "asset_ids": payload.asset_ids,
        "worked_dates": [d.isoformat() for d in payload.worked_dates],
        **audit_fields_create(user_id),
    }
    await db[REQUESTS_COLLECTION].insert_one(doc)
    request_id = doc["_id"]

    # Reserve (hold) the requested hours until the request is approved (hold →
    # debit) or rejected/cancelled (hold released). Skip LOP / non-deducting
    # types — they never debit the balance.
    if leave_type.get("deduct_from_balance", True) and not is_lop and not unrestricted:
        await create_hold(db, doc, user_id, now)
        # Submit-race guard: two concurrent requests can both pass the balance check
        # above and both create a hold, over-reserving the balance. Reconcile now —
        # if the running total of holds up to (and including) this one exceeds the
        # real balance + extra buffer, THIS request is the one that pushed it over,
        # so release its hold and delete it. (Audit B — hold race)
        await _enforce_no_overreserve(db, user_id, payload.leave_type_id, request_id, policy)

    await _record_activity(db, doc["_id"], "SUBMITTED", user_id)

    # Lifecycle state-change: user-facing activity + compliance audit.
    org_id = str(employee["organisation_id"]) if employee.get("organisation_id") else None
    await emit_activity(
        action="leave_request.applied",
        resource=f"leave_request:{request_id}",
        actor_id=user_id,
        organisation_id=org_id,
    )
    await emit_audit(
        action="leave_request.applied",
        resource=f"leave_request:{request_id}",
        actor_id=user_id,
        organisation_id=org_id,
    )

    # Email notifications
    lt_name = leave_type.get("name", "") if leave_type else ""
    start_str = payload.start_date.isoformat()
    end_str = payload.end_date.isoformat()
    rid = str(request_id)
    tenant_id_str = str(employee.get("organisation_id", ""))
    employee_name = employee.get("name", "")

    # Only the employee's own confirmation depends on their work_email. The
    # approver and HR copies must not — an employee synced without one used to
    # suppress every mail for the request, including the manager's.
    if employee.get("work_email"):
        logger.info(
            "Triggering leave_request_submitted email",
            to=employee["work_email"],
            employee_name=employee_name,
            leave_type_name=lt_name,
            start_date=start_str,
            end_date=end_str,
            duration_hours=duration_hours,
            request_id=rid,
            tenant_id=tenant_id_str,
        )
        await email_events.publish_leave_request_submitted(
            employee_email=employee["work_email"],
            employee_name=employee_name,
            leave_type_name=lt_name,
            start_date=start_str,
            end_date=end_str,
            duration_hours=duration_hours,
            request_id=rid,
            tenant_id=tenant_id_str,
        )
    else:
        logger.warning(
            "Employee has no work_email — submission confirmation skipped",
            request_id=rid,
            employee_id=user_id,
        )

    # Notify every configured approver at submission time. For AND
    # policies both still have to act; for OR whoever clicks first
    # finalizes the request — either way both inboxes need the email
    # so neither approver is silently bypassed.
    approvers = await _get_all_approvers_info(db, employee, plan_id)
    if not approvers:
        logger.warning(
            "No approver resolved for leave request — only HR will be notified",
            request_id=rid,
            employee_id=user_id,
            leave_plan_id=str(plan_id) if plan_id else None,
        )

    notified: set[str] = set()

    for level, approver_email, approver_name in approvers:
        if not approver_email or approver_email.lower() in notified:
            continue
        notified.add(approver_email.lower())
        logger.info(
            "Triggering leave_approval_pending email",
            to=approver_email,
            approver_name=approver_name,
            employee_name=employee_name,
            leave_type_name=lt_name,
            start_date=start_str,
            end_date=end_str,
            duration_hours=duration_hours,
            request_id=rid,
            level=level,
            tenant_id=tenant_id_str,
        )
        await email_events.publish_leave_approval_pending(
            approver_email=approver_email,
            approver_name=approver_name,
            employee_name=employee_name,
            leave_type_name=lt_name,
            start_date=start_str,
            end_date=end_str,
            duration_hours=duration_hours,
            request_id=rid,
            level=level,
            tenant_id=tenant_id_str,
        )

    # HR is copied on every submission regardless of the approver chain, but as
    # an INTIMATION — it is not in the chain, so it must not get the approver's
    # "requires your approval" mail with a CTA onto the approve screen. The
    # `notified` guard still applies: an HR address that is also a real approver
    # already had the actionable mail, and the intimation would only duplicate it.
    for hr_email in _hr_notify_emails():
        if not hr_email or hr_email.lower() in notified:
            continue
        notified.add(hr_email.lower())
        logger.info(
            "Triggering leave_request_submitted_notice email",
            to=hr_email,
            employee_name=employee_name,
            leave_type_name=lt_name,
            start_date=start_str,
            end_date=end_str,
            duration_hours=duration_hours,
            request_id=rid,
            tenant_id=tenant_id_str,
        )
        await email_events.publish_leave_submission_notice(
            recipient_email=hr_email,
            recipient_name="HR",
            employee_name=employee_name,
            leave_type_name=lt_name,
            start_date=start_str,
            end_date=end_str,
            duration_hours=duration_hours,
            request_id=rid,
            tenant_id=tenant_id_str,
        )

    # Allocation-exceeded warning. Advisory: the request is already accepted.
    # It exists for types whose yearly count nothing enforces — a balance-
    # deducting type would have been refused with INSUFFICIENT_BALANCE long
    # before here, so this only ever fires for WFH-style unrestricted /
    # non-deducting leave.
    await _notify_allocation_exceeded(
        db,
        leave_type=leave_type,
        user_id=user_id,
        plan_id=plan_id,
        employee=employee,
        employee_name=employee_name,
        leave_type_name=lt_name,
        start_date=start_str,
        end_date=end_str,
        request_id=rid,
        tenant_id=tenant_id_str,
        recipients=approvers,
    )

    logger.info("Leave request created", request_id=request_id, employee_id=user_id)
    return doc


def _effective_annual_limit(leave_type: dict) -> Optional[float]:
    """The yearly allocation to measure usage against, or None if untracked.

    Prefers the advisory ``annual_limit`` — the types that need this warning
    carry no accrual, so ``accrual.annual_count`` is absent for exactly the
    types where it matters — and falls back to the accrual count for types that
    do declare one.
    """
    limit = (leave_type or {}).get("annual_limit")
    if limit is None:
        limit = ((leave_type or {}).get("accrual") or {}).get("annual_count")
    try:
        limit = float(limit) if limit is not None else None
    except (TypeError, ValueError):
        return None
    return limit if limit and limit > 0 else None


async def _notify_allocation_exceeded(
    db: AsyncIOMotorDatabase,
    *,
    leave_type: dict,
    user_id: str,
    plan_id,
    employee: dict,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    request_id: str,
    tenant_id: str,
    recipients: list,
) -> None:
    """Email the employee and their approvers once a request takes them past the
    type's yearly allocation. No-ops when the type declares no limit, or when
    the total is still within it.

    Never raises: a warning that fails must not roll back an accepted request.
    """
    limit = _effective_annual_limit(leave_type)
    if not limit:
        return
    try:
        usage = await get_leave_type_usage(
            db, user_id, leave_type.get("_id"), plan_id
        )
        days_used = usage.get("days_used") or 0.0
        if days_used <= limit:
            return

        period_label = usage.get("period_label") or ""
        targets: list[tuple[str, str, bool]] = []
        if employee.get("work_email"):
            targets.append((employee["work_email"], employee_name, True))
        for _level, approver_email, approver_name in recipients:
            if approver_email:
                targets.append((approver_email, approver_name, False))

        seen: set[str] = set()
        for email, name, is_employee in targets:
            key = email.lower()
            if key in seen:
                continue
            seen.add(key)
            await email_events.publish_leave_allocation_exceeded(
                recipient_email=email,
                recipient_name=name,
                employee_name=employee_name,
                leave_type_name=leave_type_name,
                days_used=days_used,
                annual_limit=limit,
                period_label=period_label,
                start_date=start_date,
                end_date=end_date,
                request_id=request_id,
                is_employee=is_employee,
                tenant_id=tenant_id,
            )
        logger.info(
            "Leave allocation exceeded — warned employee and approvers",
            request_id=request_id,
            employee_id=user_id,
            leave_type=leave_type_name,
            days_used=days_used,
            annual_limit=limit,
            recipients=len(seen),
        )
    except Exception:
        logger.exception(
            "Failed to send leave allocation-exceeded notification",
            request_id=request_id,
            employee_id=user_id,
        )


async def list_leave_requests(
    db: AsyncIOMotorDatabase,
    employee_id: Optional[str] = None,
    status_filter: Optional[str] = None,
) -> list[dict]:
    query: dict = {"deleted_on": None}
    if employee_id:
        query["user_id"] = ObjectId(employee_id)
    if status_filter:
        query["status"] = status_filter
    cursor = db[REQUESTS_COLLECTION].find(query).sort("created_on", -1)
    return await cursor.to_list(length=None)


_MY_REQUESTS_ALLOWED_STATUSES = ("PENDING", "APPROVED", "REJECTED", "CANCELLED")


async def list_my_leave_requests(
    db: AsyncIOMotorDatabase,
    user_id: str,
    *,
    status_filter: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = 10,
    sort: str = "-created_on",
) -> dict:
    """Paginated + summarised view of the current user's leave requests.

    `counts` is computed before the `status` filter so the stat cards stay
    accurate while the user clicks one to filter the list. Date range and
    search apply to BOTH the items and the counts so they're consistent.

    Out-of-range pages return an empty `items` list with `total` / `counts`
    still populated — never a 404.
    """
    # ── Base query — applied to both counts and items ────────────────────
    base_query: dict = {
        "user_id": to_oid(user_id),
        "deleted_on": None,
        "status": {"$in": list(_MY_REQUESTS_ALLOWED_STATUSES)},
    }

    if from_date or to_date:
        date_clause: dict = {}
        if from_date:
            date_clause["$gte"] = from_date
        if to_date:
            date_clause["$lte"] = to_date
        base_query["start_date"] = date_clause

    if search:
        regex = {"$regex": re.escape(search), "$options": "i"}
        lt_docs = await db["leave_types"].find(
            {"name": regex, "deleted_on": None},
            {"_id": 1},
        ).to_list(length=None)
        matching_lt_ids = [d["_id"] for d in lt_docs]
        base_query["$or"] = [
            {"leave_type_id": {"$in": matching_lt_ids}},
            {"reason": regex},
        ]

    # ── Counts (ignore status filter, respect everything else) ───────────
    counts_pipeline = [
        {"$match": base_query},
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]
    raw_counts = await db[REQUESTS_COLLECTION].aggregate(counts_pipeline).to_list(length=None)
    by_status = {r["_id"]: r["count"] for r in raw_counts}
    counts = {
        "pending":   by_status.get("PENDING", 0),
        "approved":  by_status.get("APPROVED", 0),
        "rejected":  by_status.get("REJECTED", 0),
        "cancelled": by_status.get("CANCELLED", 0),
    }
    # Invariant: counts.all === sum of the four bucket counts. Computed from
    # the buckets (not a separate $count) so the invariant holds by
    # construction even if an unexpected status sneaks into the DB.
    counts["all"] = counts["pending"] + counts["approved"] + counts["rejected"] + counts["cancelled"]

    # ── Items query: apply status filter on top of base ──────────────────
    items_query = dict(base_query)
    if status_filter:
        items_query["status"] = status_filter
        total = by_status.get(status_filter, 0)
    else:
        total = counts["all"]

    sort_field = sort[1:] if sort.startswith("-") else sort
    sort_dir = -1 if sort.startswith("-") else 1

    skip = (page - 1) * page_size
    items_docs = await (
        db[REQUESTS_COLLECTION]
        .find(items_query)
        .sort(sort_field, sort_dir)
        .skip(skip)
        .limit(page_size)
        .to_list(length=page_size)
    )

    total_pages = (total + page_size - 1) // page_size if total > 0 else 0

    await enrich_aging(db, items_docs)

    return {
        "items": items_docs,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
        "counts": counts,
    }


async def _populate_assets(db: AsyncIOMotorDatabase, asset_ids: list[str]) -> list[dict]:
    if not asset_ids:
        return []
    oids = []
    for aid in asset_ids:
        try:
            oids.append(ObjectId(aid))
        except Exception:
            pass
    if not oids:
        return []
    docs = await db["assets"].find({"_id": {"$in": oids}, "deleted_on": None}).to_list(length=None)
    result = []
    for doc in docs:
        try:
            url = await generate_presigned_url(str(doc["_id"]), doc["storage_key"])
        except Exception:
            url = None
        result.append({
            "id": str(doc["_id"]),
            "original_filename": doc.get("original_filename", ""),
            "content_type": doc.get("content_type", ""),
            "size": doc.get("size", 0),
            "url": url,
        })
    return result


async def get_leave_request(
    db: AsyncIOMotorDatabase, request_id: str, current_user: Optional[str] = None
) -> dict:
    query: dict = {"_id": to_oid(request_id), "deleted_on": None}
    if current_user:
        query["user_id"] = to_oid(current_user)
    doc = await db[REQUESTS_COLLECTION].find_one(query)
    if not doc:
        raise DomainException(
            message="Leave request not found",
            code="LEAVE_REQUEST_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    doc["assets"] = await _populate_assets(db, doc.get("asset_ids") or [])
    # Usage warning: only for a type configured to show it. Attached here so the
    # employee's detail view and the approver's both get it from the one call —
    # there is no balance for either of them to read instead.
    lt = await db["leave_types"].find_one(
        {"_id": to_oid(doc.get("leave_type_id"))},
        {"is_unrestricted": 1, "show_usage_warning": 1},
    )
    if lt and lt.get("is_unrestricted") and lt.get("show_usage_warning"):
        doc["usage_warning"] = await get_leave_type_usage(
            db,
            str(doc.get("user_id")),
            doc.get("leave_type_id"),
            doc.get("leave_plan_id"),
        )
    return doc


async def _fetch_person_info(db: AsyncIOMotorDatabase, ref_oid: ObjectId) -> Optional[dict]:
    """Resolve a person's basic info. ref_oid may be their user_id or employee._id."""
    projection = {"user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1}
    emp = await db["employees"].find_one({"_id": ref_oid}, projection)
    if not emp:
        emp = await db["employees"].find_one({"user_id": ref_oid}, projection)

    user_oid = (emp.get("user_id") if emp else None) or ref_oid
    user = await db["users"].find_one({"_id": user_oid}, projection) if user_oid else None

    source = user or emp
    if not source:
        return None

    first = source.get("first_name", "")
    last = source.get("last_name", "")
    full_name = f"{first} {last}".strip() if (first or last) else (
        source.get("full_name") or source.get("name") or ""
    )
    return {"id": str(user_oid), "name": full_name, "email": source.get("email")}


async def _compute_accrual_hours(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_plan_id,
    lt_id_str: str,
    days_until_leave: int,
) -> float:
    """Estimate hours to be accrued between now and the leave start date."""
    if not leave_plan_id or days_until_leave <= 0:
        return 0.0

    # The leave type now owns its accrual config — prefer it over the plan.
    _periods = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}
    _cycle_days = {"monthly": 30, "quarterly": 90, "half_yearly": 180, "yearly": 365}
    lt_doc = await db["leave_types"].find_one(
        {"_id": to_oid(lt_id_str)}, {"accrual": 1, "unit": 1}
    )
    acc = (lt_doc or {}).get("accrual") or {}
    if acc.get("annual_count") is not None and acc.get("accrual_frequency"):
        freq = acc["accrual_frequency"]
        cycle_days = _cycle_days.get(freq, 0)
        if not cycle_days:
            return 0.0
        per_cycle = float(acc["annual_count"]) / _periods.get(freq, 1)
        unit = (lt_doc.get("unit") or "DAYS").lower()
        per_cycle_hours = per_cycle if "hour" in unit else per_cycle * 8.0
        return per_cycle_hours * (days_until_leave // cycle_days)

    emp = await db["employees"].find_one(
        {"user_id": to_oid(user_id)}, {"organisation_id": 1}
    )
    org_id = emp.get("organisation_id") if emp else None
    if not org_id:
        return 0.0
    ent_config = await db["leave_entitlement_configurations"].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "org_id": org_id, "deleted_on": None}
    )
    if not ent_config:
        return 0.0
    distribution = (ent_config.get("entitlement") or {}).get("distribution", {})
    if not distribution.get("enabled") or distribution.get("mode") != "step_by_step":
        return 0.0
    posting_cycles = distribution.get("posting_cycles", [])
    cycle = next((c for c in posting_cycles if c.get("leave_type_id") == lt_id_str), None)
    if not cycle:
        return 0.0
    # Each leave type accrues on its own frequency (falls back to the plan-level
    # value for legacy plans).
    freq = cycle.get("accrual_frequency") or distribution.get("accrual_frequency")
    cycle_days = {"monthly": 30, "quarterly": 90, "half_yearly": 180, "yearly": 365}.get(freq, 0)
    if not cycle_days:
        return 0.0
    val = float(cycle.get("value") or 0)
    unit = (cycle.get("unit") or "days").lower()
    accrual_per_cycle_hours = val if "hour" in unit else val * 8.0
    return accrual_per_cycle_hours * (days_until_leave // cycle_days)


async def _projected_balance_hours(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_plan_id,
    leave_type_id: str,
    start_date,
) -> float:
    """Raw balance expected by the leave start date (current credited/approved
    balance plus accruals posted before the leave starts).

    This is the RAW balance — it does NOT subtract pending holds. The LOP
    decision keys off this so a tentative reservation can't make a request
    unpaid. Callers net out holds themselves for the sufficiency check.
    """
    current = await get_balance_from_tracker(db, user_id, leave_type_id) or 0.0
    now = datetime.now(timezone.utc)
    leave_start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    days_until_leave = max(0, (leave_start - now).days)
    accrual = await _compute_accrual_hours(
        db, user_id, leave_plan_id, leave_type_id, days_until_leave
    )
    return current + accrual


async def _get_approval_timeline(db: AsyncIOMotorDatabase, request_id_oid) -> list[dict]:
    activities = await db[ACTIVITY_COLLECTION].find(
        {"leave_request_id": request_id_oid}
    ).sort("timestamp", 1).to_list(length=None)

    timeline = []
    for act in activities:
        info = await _fetch_person_info(db, act["actor_id"])
        timeline.append({
            "action": act["action"],
            "level": act.get("level"),
            "actor_id": str(act["actor_id"]),
            "actor_name": info["name"] if info else None,
            "comment": act.get("comment"),
            "timestamp": act["timestamp"],
        })
    return timeline


async def get_leave_request_detail(
    db: AsyncIOMotorDatabase, request_id: str, current_user: Optional[str] = None
) -> dict:
    doc = await get_leave_request(db, request_id, current_user)

    employee = await db["employees"].find_one(
        {"user_id": doc["user_id"]},
        {"l1_manager_id": 1, "l2_manager_id": 1, "department_id": 1},
    )

    # Employee identity
    person = await _fetch_person_info(db, doc["user_id"])
    if person:
        dept_id = str(employee["department_id"]) if employee and employee.get("department_id") else None
        dept_name = None
        if dept_id:
            dept_doc = await db["departments"].find_one({"_id": employee["department_id"]}, {"name": 1})
            dept_name = dept_doc.get("name") if dept_doc else None
        # Profile photo lives on the IAM user replica (kept fresh by user.updated).
        user_doc = await db["users"].find_one({"_id": doc["user_id"]}, {"avatar_url": 1})
        doc["employee"] = {
            "id": person["id"],
            "name": person["name"],
            "email": person.get("email"),
            "department_id": dept_id,
            "department_name": dept_name,
            "avatar_url": (user_doc or {}).get("avatar_url") or None,
        }
    else:
        doc["employee"] = None

    # Managers
    l1_manager = None
    l2_manager = None
    if employee:
        if employee.get("l1_manager_id"):
            l1_manager = await _fetch_person_info(db, employee["l1_manager_id"])
        if employee.get("l2_manager_id"):
            l2_manager = await _fetch_person_info(db, employee["l2_manager_id"])

    doc["l1_manager"] = l1_manager
    doc["l2_manager"] = l2_manager
    doc["approval_timeline"] = await _get_approval_timeline(db, doc["_id"])

    # Balance projection: available today / projected by leave date / after approval
    lt_oid = doc.get("leave_type_id")
    req_user_id = str(doc["user_id"])
    if lt_oid:
        lt_id_str = str(lt_oid)
        leave_type = await db["leave_types"].find_one({"_id": lt_oid})
        lt_name = leave_type.get("name", "") if leave_type else ""
        doc["leave_type_name"] = lt_name

        # Exclude THIS request's own hold — otherwise after_approval_hours below
        # (projected - this_leave_hours) subtracts this request's hours twice
        # (once via its active hold inside available, once explicitly).
        available_today_hours = await get_available_balance(
            db, req_user_id, lt_id_str, exclude_request_id=str(doc["_id"])
        )

        # Estimate accruals between today and leave start date
        leave_plan_id = doc.get("leave_plan_id")
        leave_start = doc.get("start_datetime")
        now = datetime.now(timezone.utc)
        if leave_start and hasattr(leave_start, "tzinfo") and leave_start.tzinfo is None:
            leave_start = leave_start.replace(tzinfo=timezone.utc)
        days_until_leave = max(0, (leave_start - now).days) if leave_start else 0
        accrual_hours = await _compute_accrual_hours(
            db, req_user_id, leave_plan_id, lt_id_str, days_until_leave
        )

        projected_hours = available_today_hours + accrual_hours
        this_leave_hours = doc.get("duration_hours", 0.0) or 0.0
        after_approval_hours = max(0.0, projected_hours - this_leave_hours)

        doc["balance_projection"] = {
            "leave_type_id": lt_id_str,
            "leave_type_name": lt_name,
            "available_today_hours": round(available_today_hours, 2),
            "available_today_days": round(available_today_hours / 8.0, 2),
            "projected_by_leave_date_hours": round(projected_hours, 2),
            "projected_by_leave_date_days": round(projected_hours / 8.0, 2),
            "after_approval_hours": round(after_approval_hours, 2),
            "after_approval_days": round(after_approval_hours / 8.0, 2),
        }
    else:
        doc["balance_projection"] = None

    return doc


async def get_balance_projection(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: Optional[str] = None,
) -> dict:
    user_oid = ObjectId(user_id)
    now = datetime.now(timezone.utc)

    lt_query: dict = {"deleted_on": None}
    if leave_type_id:
        lt_query["_id"] = to_oid(leave_type_id)
    leave_types = await db["leave_types"].find(lt_query).to_list(length=None)

    projections = []
    for lt in leave_types:
        lt_oid = lt["_id"]
        lt_id_str = str(lt_oid)

        current_hours = await get_available_balance(db, user_id, lt_id_str)

        pending_docs = await db[REQUESTS_COLLECTION].find({
            "user_id": user_oid,
            "leave_type_id": lt_oid,
            "status": "PENDING",
            "deleted_on": None,
        }).to_list(length=None)
        pending_hours = sum(d.get("duration_hours", 0) for d in pending_docs)

        approved_docs = await db[REQUESTS_COLLECTION].find({
            "user_id": user_oid,
            "leave_type_id": lt_oid,
            "status": "APPROVED",
            "start_datetime": {"$gte": now},
            "deleted_on": None,
        }).to_list(length=None)
        approved_future_hours = sum(d.get("duration_hours", 0) for d in approved_docs)

        # Skip leave types with no activity and no balance
        if current_hours == 0 and pending_hours == 0 and approved_future_hours == 0:
            continue

        # max_balance = what balance would be if all pending requests were rejected
        max_balance_hours = current_hours + pending_hours

        projections.append({
            "leave_type_id": lt_id_str,
            "leave_type_name": lt.get("name", ""),
            "current_balance_hours": current_hours,
            "current_balance_days": current_hours / 8.0,
            "pending_hours": pending_hours,
            "pending_days": pending_hours / 8.0,
            "approved_future_hours": approved_future_hours,
            "approved_future_days": approved_future_hours / 8.0,
            "max_balance_hours": max_balance_hours,
            "max_balance_days": max_balance_hours / 8.0,
        })

    return {"projections": projections}


async def get_leave_history(
    db: AsyncIOMotorDatabase,
    user_id: str,
    year: Optional[int] = None,
    status_filter: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    user_oid = ObjectId(user_id)
    query: dict = {"user_id": user_oid, "deleted_on": None}

    if status_filter:
        query["status"] = status_filter

    if year:
        query["created_on"] = {
            "$gte": datetime(year, 1, 1, tzinfo=timezone.utc),
            "$lt": datetime(year + 1, 1, 1, tzinfo=timezone.utc),
        }

    total = await db[REQUESTS_COLLECTION].count_documents(query)
    docs = await db[REQUESTS_COLLECTION].find(query).sort("created_on", -1).skip(offset).limit(limit).to_list(length=None)

    return {"total": total, "offset": offset, "limit": limit, "items": docs}


async def get_leave_balance(
    db: AsyncIOMotorDatabase, user_id: str, leave_type_id: str
) -> dict:
    available_hours = await get_available_balance(db, user_id, leave_type_id)

    return {
        "user_id": user_id,
        "leave_type_id": leave_type_id,
        "available_hours": available_hours,
        "available_days": available_hours / 8.0,
    }


async def get_all_leave_balances(
    db: AsyncIOMotorDatabase, user_id: str, org_id: str | None = None
) -> dict:
    # Scope leave types to the caller's org (plus system-wide types, which have
    # org_id=None) so balances never surface another tenant's leave types.
    # Matches the ObjectId/string forms defensively, as list_leave_types does.
    lt_query: dict = {"deleted_on": None}
    if org_id:
        lt_query["$or"] = [
            {"org_id": {"$in": [to_oid(org_id), str(org_id)]}},
            {"org_id": None},
        ]

    # Only show leave types opted in to the balance view. The field defaults to
    # False, so only types explicitly set to True appear (legacy types with no
    # stored value read as hidden).
    lt_query["show_in_leave_balance"] = True

    # Restrict to the leave types the employee's OWN plan offers. Without this the
    # balance lists every org type carrying the flag, so an employee sees types
    # they can never actually use — the submit path rejects them with
    # LEAVE_TYPE_NOT_IN_PLAN. The Leave Management screen already filtered this
    # way client-side; doing it here keeps every surface (dashboard included)
    # agreeing without each one re-implementing the allowlist.
    #
    # When no plan resolves we deliberately do NOT filter, so a missing
    # assignment degrades to "shows everything" rather than blanking the card —
    # the same fallback the FE allowlist uses.
    if org_id:
        from src.leave_plan_assignments.service import resolve_employee_plan

        emp_plan = await resolve_employee_plan(db, user_id, org_id)
        if emp_plan:
            plan_doc = await db["leave_plans"].find_one(
                {"_id": emp_plan["leave_plan_id"]}, {"leave_type_ids": 1}
            )
            plan_type_ids = list((plan_doc or {}).get("leave_type_ids") or [])
            if plan_type_ids:
                lt_query["_id"] = {"$in": plan_type_ids}

    leave_types = await db["leave_types"].find(lt_query).to_list(length=None)

    # Hide the types this employee is restricted out of (Maternity for a man,
    # etc). Same predicate the apply gate enforces, so the balance card never
    # advertises a type the submit path would reject. Unknown employee → no
    # filtering, matching that gate's fail-open rule.
    employee_doc = await db["employees"].find_one(
        {"user_id": to_oid(user_id)}, {"gender": 1, "marital_status": 1}
    )
    leave_types = filter_eligible(leave_types, employee_doc)

    tracker_docs = await db[TRACKER_COLLECTION].find(
        {"user_id": to_oid(user_id)}
    ).to_list(length=None)
    tracker_map = {doc["leave_type_id"]: doc for doc in tracker_docs if doc.get("leave_type_id")}

    holds_map = await get_active_hold_hours_bulk(db, user_id)

    balances = []
    for lt in leave_types:
        tracker = tracker_map.get(lt["_id"])
        hours = max(tracker.get("balance_hours", 0.0), 0.0) if tracker else 0.0
        held = holds_map.get(str(lt["_id"]), 0.0)
        available = hours - held
        balances.append({
            "leave_type_id": str(lt["_id"]),
            "leave_type_name": lt.get("name", ""),
            "leave_type_code": lt.get("code"),
            "rank": lt.get("rank"),
            "unit": lt.get("unit", "DAYS"),
            # Deliberately NOT rounded here. Rounding is owned by
            # entitlement.fractional_balance.mode, applied at accrual time
            # (processor._round_hours) and when charging a request
            # (validation._apply_rounding). A plan set to "exact" stores an exact
            # value, so rounding it on the way out would override the very
            # setting that decided it. Clients format for display.
            "balance_hours": hours,
            "balance_days": hours / 8.0,
            "on_hold_hours": held,
            "on_hold_days": held / 8.0,
            "available_hours": available,
            "available_days": available / 8.0,
            "deduct_from_balance": lt.get("deduct_from_balance", True),
        })

    # Configured display order, not alphabetical — the same order the admin
    # sees in the leave-types table and the employee sees in the apply
    # dropdown. Unranked legacy types fall to the end, then sort by name.
    balances.sort(key=lambda b: leave_type_sort_key({"rank": b["rank"], "name": b["leave_type_name"]}))
    return {"user_id": user_id, "balances": balances}


async def estimate_leave_duration(
    db: AsyncIOMotorDatabase,
    employee_id: str,
    leave_type_id: str,
    start_date_str: str,
    end_date_str: str,
    duration_mode: str,
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
) -> dict:
    from datetime import date as date_type

    start_date = date_type.fromisoformat(start_date_str)
    end_date = date_type.fromisoformat(end_date_str)

    # Maternity / Paternity / statutory (and any leave type flagged
    # count_calendar_days) include weekends + holidays in the duration, so the
    # estimate must mirror that. Statutory always counts calendar days regardless
    # of the stored flag (matches validate_and_compute).
    leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
    count_calendar_days = bool(
        leave_type.get("count_calendar_days", False)
        or leave_type.get("is_statutory_leave", False)
    ) if leave_type else False

    # Loss of Pay (exhausted balance / unpaid type) charges weekends too — but when
    # extra-leave is allowed, within the buffer the leave is paid, so mirror create.
    allow_neg = False
    try:
        _pol, _, _ = await _resolve_policy_for_employee(db, employee_id, leave_type_id)
        _ex = ((_pol.get("entitlement") or {}).get("extra_leave")) or {}
        allow_neg = bool(_ex.get("status") == "ALLOWED" and (_ex.get("max_days") or 0) > 0)
    except Exception:
        pass
    include_weekends = await should_count_weekends_for_lop(
        db, employee_id, leave_type_id, leave_type, allow_negative_balance=allow_neg
    )

    duration_hours = await compute_duration_for_mode(
        db,
        start_date,
        end_date,
        employee_id,
        duration_mode,
        half_day_period,
        start_session,
        end_session,
        count_calendar_days=count_calendar_days,
        include_weekends=include_weekends,
    )

    return {
        "estimated_hours": duration_hours,
        "estimated_days": duration_hours / 8.0,
        "is_lop": include_weekends,
        "includes_weekends": include_weekends,
    }


async def get_balance_estimate(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: str,
    start_date_str: str,
    end_date_str: str,
    duration_mode: str,
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
) -> dict:
    from datetime import date as date_type

    start_date = date_type.fromisoformat(start_date_str)
    end_date = date_type.fromisoformat(end_date_str)
    policy, leave_type, leave_plan_id = await _resolve_policy_for_employee(
        db, user_id, leave_type_id
    )

    start_datetime, end_datetime = dates_to_datetimes(
        start_date,
        end_date,
        duration_mode,
        half_day_period,
        start_session,
        end_session,
    )

    lt_id_str = leave_type_id
    lt_name = leave_type.get("name", "") if leave_type else ""

    # available_today drives the sufficiency check (and the display); raw_today
    # drives the LOP decision — pending holds reduce what's spendable but must
    # not flip the request to unpaid.
    available_today_hours = await get_available_balance(db, user_id, lt_id_str)
    raw_today_hours = await get_balance_from_tracker(db, user_id, lt_id_str) or 0.0

    now = datetime.now(timezone.utc)
    from datetime import datetime as dt_type
    leave_start_dt = dt_type(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    days_until_leave = max(0, (leave_start_dt - now).days)

    accrual_hours = await _compute_accrual_hours(
        db, user_id, leave_plan_id, lt_id_str, days_until_leave
    )

    projected_hours = available_today_hours + accrual_hours
    projected_raw_hours = raw_today_hours + accrual_hours

    # Run full policy validation (same rules as leave request creation)
    duration_hours = await validate_and_compute(
        db,
        user_id=user_id,
        leave_type_id=leave_type_id,
        start=start_datetime,
        end=end_datetime,
        policy=policy,
        leave_type=leave_type,
        loss_of_pay=False,
        duration_mode=duration_mode,
        half_day_period=half_day_period,
        start_session=start_session,
        end_session=end_session,
        projected_balance_hours=projected_hours,
        lop_balance_hours=projected_raw_hours,
    )

    after_approval_hours = max(0.0, projected_hours - duration_hours)

    entitlement = policy.get("entitlement") or {}
    backdated = entitlement.get("backdated_leave") or {}
    entitlement_constraints = {
        "backdated_leave": {
            "enabled": backdated.get("enabled", False),
            "max_days": backdated.get("max_days"),
        },
    }

    # Mirror the duration rule so the UI can explain a weekend-inclusive count.
    # Use the SAME extra-leave-derived flag as create/update (negative_balance is
    # disabled product-wide), otherwise the estimate's is_lop disagrees with the
    # request that actually gets created.
    _extra_est = (entitlement.get("extra_leave") or {})
    is_lop = await should_count_weekends_for_lop(
        db,
        user_id,
        lt_id_str,
        leave_type,
        allow_negative_balance=bool(
            _extra_est.get("status") == "ALLOWED" and (_extra_est.get("max_days") or 0) > 0
        ),
        balance_hours=projected_raw_hours,
    )

    return {
        "leave_type_id": lt_id_str,
        "leave_type_name": lt_name,
        "is_lop": is_lop,
        "includes_weekends": is_lop,
        "estimated_hours": round(duration_hours, 2),
        "estimated_days": round(duration_hours / 8.0, 2),
        "available_today_hours": round(available_today_hours, 2),
        "available_today_days": round(available_today_hours / 8.0, 2),
        "projected_by_leave_date_hours": round(projected_hours, 2),
        "projected_by_leave_date_days": round(projected_hours / 8.0, 2),
        "after_approval_hours": round(after_approval_hours, 2),
        "after_approval_days": round(after_approval_hours / 8.0, 2),
        "entitlement_constraints": entitlement_constraints,
    }


async def approve_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    approver_id: str,
    payload: ApprovalActionPayload,
) -> dict:
    request = await get_leave_request(db, request_id)

    if request["status"] != "PENDING":
        raise DomainException(
            message=f"Cannot approve a request with status '{request['status']}'",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    current_level = request["approval_state"]["current_level"]
    request_oid = to_oid(request_id)
    plan_id = request.get("leave_plan_id")
    approver_oid = to_oid(approver_id)

    # An employee can never approve their own leave request. (Audit B)
    if str(request.get("user_id")) == str(approver_id):
        raise DomainException(
            message="You cannot approve your own leave request",
            code="SELF_APPROVAL_NOT_ALLOWED",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    # Resolve the approval policy ONCE (AND/OR operator + number of levels).
    levels_operator = None
    max_level = current_level
    if plan_id:
        approval_policy = await db["leave_approval_policies"].find_one(
            {"leave_plan_id": to_oid(plan_id)}
        )
        if approval_policy:
            levels_operator = approval_policy.get("levels_operator")
            approval_levels = approval_policy.get("approval_levels") or []
            if approval_levels:
                max_level = max(l["level"] for l in approval_levels)

    # Atomically record this approver — succeeds only while the request is still
    # PENDING and this approver hasn't already approved. Serialises concurrent
    # approvals so two managers can't read-modify-write, lose an update, or both
    # double-count toward finalize. (Audit B — concurrent approval race)
    from pymongo import ReturnDocument

    claimed = await db[REQUESTS_COLLECTION].find_one_and_update(
        {
            "_id": request_oid,
            "status": "PENDING",
            "approval_state.approved_by": {"$ne": approver_oid},
        },
        {
            "$addToSet": {"approval_state.approved_by": approver_oid},
            "$set": audit_fields_update(approver_id),
        },
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        latest = await get_leave_request(db, request_id)
        if any(str(b) == str(approver_oid) for b in (latest["approval_state"].get("approved_by") or [])):
            raise DomainException(
                message="You have already approved this request",
                code="ALREADY_APPROVED",
                status_code=status.HTTP_409_CONFLICT,
            )
        raise DomainException(
            message=f"Cannot approve a request with status '{latest['status']}'",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    approved_by = list(claimed["approval_state"].get("approved_by") or [])

    await _record_activity(
        db, request_oid, "APPROVED", approver_id,
        level=current_level, comment=payload.comment if payload else None,
    )

    # Required approvals = the number of DISTINCT managers in THIS employee's own
    # chain, up to the configured number of levels. L1/L2 are per-employee, so when
    # the same person is both the L1 and L2 manager (small teams), their single
    # approval fills both slots — otherwise a 2-level AND would deadlock, needing two
    # distinct approvers when only one exists. (Audit B — same-person both levels)
    emp_doc = await db["employees"].find_one(
        {"user_id": request["user_id"]}, {"l1_manager_id": 1, "l2_manager_id": 1}
    )
    chain = [emp_doc.get("l1_manager_id"), emp_doc.get("l2_manager_id")] if emp_doc else []
    distinct_managers = len({str(m) for m in chain[:max_level] if m})
    required_approvals = max(1, distinct_managers) if distinct_managers else max_level
    # OR: first approval finalizes. AND: every distinct required manager must approve.
    should_finalize = (levels_operator == "OR") or (len(approved_by) >= required_approvals)

    now = datetime.now(timezone.utc)
    if should_finalize:
        # Atomically claim the finalize so only ONE approval performs the debit,
        # even if two approvals cross the threshold concurrently. (no double-debit)
        finalized = await db[REQUESTS_COLLECTION].find_one_and_update(
            {"_id": request_oid, "status": "PENDING"},
            {"$set": {"status": "APPROVED", **audit_fields_update(approver_id)}},
            return_document=ReturnDocument.AFTER,
        )
        if not finalized:
            return await get_leave_request(db, request_id)

        leave_type = await db["leave_types"].find_one({"_id": request["leave_type_id"]})
        # Loss-of-Pay requests are unpaid and never debit the leave balance,
        # even for a normally balance-deducting type (auto-converted at 0 balance).
        if leave_type and leave_type.get("deduct_from_balance", True) and not request.get("loss_of_pay"):
            lt_id_str = str(request["leave_type_id"])
            await db["leave_entitlement_ledger"].insert_one({
                "_id": str(uuid.uuid4()),
                "user_id": request["user_id"],
                "leave_type_id": request["leave_type_id"],
                "transaction_type": "DEBIT",
                "amount": request["duration_hours"],
                "reference_id": request_id,
                "note": "Debit on leave approval",
                "created_on": now,
                "created_by": to_oid(approver_id),
            })
            await upsert_balance(
                db,
                str(request["user_id"]),
                lt_id_str,
                request.get("leave_plan_id"),
                -request["duration_hours"],
                approver_id,
                now,
            )
            # The reservation is now a real debit — convert the hold so it stops
            # counting against available balance.
            await convert_hold(db, request_id, approver_id, now)

        logger.info("Leave request fully approved", request_id=request_id)

        # Notice-period: if this employee is serving notice and the policy is
        # allow_with_extension, tell IAM to push their last working day out by
        # the approved working days. Best-effort — must not break approval.
        try:
            await _maybe_emit_notice_extension(db, request, request_id)
        except Exception as exc:
            logger.warning(
                "notice-period extension emit failed",
                request_id=request_id, error=repr(exc),
            )
    else:
        # Guard on status=PENDING so this intermediate-level write no-ops if the
        # request was finalized (APPROVED/REJECTED) concurrently — otherwise it
        # would clobber approval_state on an already-finalized request.
        await db[REQUESTS_COLLECTION].update_one(
            {"_id": request_oid, "status": "PENDING"},
            {"$set": {
                "approval_state.current_level": current_level + 1,
                "approval_state.approved_by": approved_by,
                **audit_fields_update(approver_id),
            }},
        )

    # Lifecycle state-change: user-facing activity + compliance audit.
    emp_doc = await db["employees"].find_one({"user_id": request["user_id"]})
    org_id = str(emp_doc["organisation_id"]) if emp_doc and emp_doc.get("organisation_id") else None
    await emit_activity(
        action="leave_request.approved",
        resource=f"leave_request:{request_id}",
        actor_id=approver_id,
        organisation_id=org_id,
    )
    await emit_audit(
        action="leave_request.approved",
        resource=f"leave_request:{request_id}",
        actor_id=approver_id,
        organisation_id=org_id,
    )

    # Email notifications. Only the employee's own mail depends on their
    # work_email — the manager/HR notices and the next-level approver mail must
    # not be suppressed just because the employee record is missing an address.
    if emp_doc:
        leave_type_doc = await db["leave_types"].find_one({"_id": request["leave_type_id"]})
        lt_name = leave_type_doc.get("name", "") if leave_type_doc else ""
        approver_emp = await _get_employee(db, approver_id)
        approver_name = approver_emp.get("name", "") if approver_emp else ""
        if not approver_name:
            # The mail prints "approved by {{approver_name}}", so an empty name
            # ships a blank. Log rather than fail — the approval itself stands.
            logger.warning(
                "Approver name unresolved for leave approval email",
                request_id=request_id, approver_id=str(approver_id),
            )
        start_str, end_str = email_date_strings(request)
        tenant_id_str = str(emp_doc.get("organisation_id", ""))

        # Send the "approved" email whenever the request was actually FINALIZED —
        # not just when the last level acted. Under an OR policy a single (L1)
        # approval finalizes, so keying off current_level >= max_level would wrongly
        # send a "pending next level" email for an already-approved request and
        # never notify the employee. Mirror the finalize decision instead.
        if should_finalize:
            if emp_doc.get("work_email"):
                logger.info(
                    "Triggering leave_request_approved email",
                    to=emp_doc["work_email"],
                    employee_name=emp_doc.get("name", ""),
                    leave_type_name=lt_name,
                    start_date=start_str,
                    end_date=end_str,
                    duration_hours=request.get("duration_hours", 0),
                    request_id=request_id,
                    approver_name=approver_name,
                    tenant_id=tenant_id_str,
                )
                await email_events.publish_leave_request_approved(
                    employee_email=emp_doc["work_email"],
                    employee_name=emp_doc.get("name", ""),
                    leave_type_name=lt_name,
                    start_date=start_str,
                    end_date=end_str,
                    duration_hours=request.get("duration_hours", 0),
                    request_id=request_id,
                    approver_name=approver_name,
                    tenant_id=tenant_id_str,
                )

            # L1 manager + HR get the third-person copy for their records.
            for notice_email, notice_name in await _decision_notice_recipients(db, emp_doc):
                logger.info(
                    "Triggering leave_request_approved_notice email",
                    to=notice_email,
                    employee_name=emp_doc.get("name", ""),
                    request_id=request_id,
                )
                await email_events.publish_leave_decision_notice(
                    recipient_email=notice_email,
                    recipient_name=notice_name,
                    employee_name=emp_doc.get("name", ""),
                    leave_type_name=lt_name,
                    start_date=start_str,
                    end_date=end_str,
                    duration_hours=request.get("duration_hours", 0),
                    request_id=request_id,
                    approved=True,
                    approver_name=approver_name,
                    tenant_id=tenant_id_str,
                )
        else:
            next_level = current_level + 1
            next_approver_email, next_approver_name = await _get_approver_for_level(
                db, plan_id, next_level
            )
            if next_approver_email:
                logger.info(
                    "Triggering leave_approval_pending email (next level)",
                    to=next_approver_email,
                    approver_name=next_approver_name,
                    employee_name=emp_doc.get("name", ""),
                    leave_type_name=lt_name,
                    start_date=start_str,
                    end_date=end_str,
                    duration_hours=request.get("duration_hours", 0),
                    request_id=request_id,
                    level=next_level,
                    tenant_id=tenant_id_str,
                )
                await email_events.publish_leave_approval_pending(
                    approver_email=next_approver_email,
                    approver_name=next_approver_name,
                    employee_name=emp_doc.get("name", ""),
                    leave_type_name=lt_name,
                    start_date=start_str,
                    end_date=end_str,
                    duration_hours=request.get("duration_hours", 0),
                    request_id=request_id,
                    level=next_level,
                    tenant_id=tenant_id_str,
                )

    return await get_leave_request(db, request_id)


async def reject_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    approver_id: str,
    payload: ApprovalActionPayload,
) -> dict:
    request = await get_leave_request(db, request_id)

    if request["status"] != "PENDING":
        raise DomainException(
            message=f"Cannot reject a request with status '{request['status']}'",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    current_level = request["approval_state"]["current_level"]
    request_oid = to_oid(request_id)

    now = datetime.now(timezone.utc)
    await _record_activity(
        db, request_oid, "REJECTED", approver_id,
        level=current_level, comment=payload.comment if payload else None,
    )
    await db[REQUESTS_COLLECTION].update_one(
        {"_id": request_oid},
        {"$set": {"status": "REJECTED", **audit_fields_update(approver_id)}},
    )
    # Return the reserved balance.
    await release_hold(db, request_id, approver_id, now)

    # Lifecycle state-change: user-facing activity + compliance audit.
    emp_doc = await db["employees"].find_one({"user_id": request["user_id"]})
    org_id = str(emp_doc["organisation_id"]) if emp_doc and emp_doc.get("organisation_id") else None
    await emit_activity(
        action="leave_request.rejected",
        resource=f"leave_request:{request_id}",
        actor_id=approver_id,
        organisation_id=org_id,
    )
    await emit_audit(
        action="leave_request.rejected",
        resource=f"leave_request:{request_id}",
        actor_id=approver_id,
        organisation_id=org_id,
    )

    # As on approve: only the employee's own mail depends on their work_email;
    # the manager/HR notices go out regardless.
    if emp_doc:
        leave_type_doc = await db["leave_types"].find_one({"_id": request["leave_type_id"]})
        approver_emp = await _get_employee(db, approver_id)
        lt_name = leave_type_doc.get("name", "") if leave_type_doc else ""
        approver_name = approver_emp.get("name", "") if approver_emp else ""
        if not approver_name:
            logger.warning(
                "Approver name unresolved for leave rejection email",
                request_id=request_id, approver_id=str(approver_id),
            )
        start_str, end_str = email_date_strings(request)
        tenant_id_str = str(emp_doc.get("organisation_id", ""))

        if emp_doc.get("work_email"):
            logger.info(
                "Triggering leave_request_rejected email",
                to=emp_doc["work_email"],
                employee_name=emp_doc.get("name", ""),
                leave_type_name=lt_name,
                start_date=start_str,
                end_date=end_str,
                request_id=request_id,
                approver_name=approver_name,
                comment=payload.comment or "",
                tenant_id=tenant_id_str,
            )
            await email_events.publish_leave_request_rejected(
                employee_email=emp_doc["work_email"],
                employee_name=emp_doc.get("name", ""),
                leave_type_name=lt_name,
                start_date=start_str,
                end_date=end_str,
                request_id=request_id,
                approver_name=approver_name,
                comment=payload.comment or "",
                tenant_id=tenant_id_str,
            )

        # L1 manager + HR get the third-person copy for their records.
        for notice_email, notice_name in await _decision_notice_recipients(db, emp_doc):
            logger.info(
                "Triggering leave_request_rejected_notice email",
                to=notice_email,
                employee_name=emp_doc.get("name", ""),
                request_id=request_id,
            )
            await email_events.publish_leave_decision_notice(
                recipient_email=notice_email,
                recipient_name=notice_name,
                employee_name=emp_doc.get("name", ""),
                leave_type_name=lt_name,
                start_date=start_str,
                end_date=end_str,
                duration_hours=request.get("duration_hours", 0),
                request_id=request_id,
                approved=False,
                approver_name=approver_name,
                comment=payload.comment or "",
                tenant_id=tenant_id_str,
            )

    logger.info("Leave request rejected", request_id=request_id)
    return await get_leave_request(db, request_id)


async def update_leave_request(
    db: AsyncIOMotorDatabase, request_id: str, payload: LeaveRequestCreate, user_id: str
) -> dict:
    """Update a PENDING leave request owned by the user.

    Allowed only while status is PENDING. Re-runs duration/validation against the
    selected leave type and writes the new fields. Approval state is preserved.
    """
    existing = await get_leave_request(db, request_id)

    if str(existing["user_id"]) != user_id:
        raise DomainException(
            message="You can only edit your own leave requests",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if existing["status"] != "PENDING":
        raise DomainException(
            message=f"Cannot edit a request with status '{existing['status']}'",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    policy, leave_type, plan_id = await _resolve_policy_for_employee(
        db, user_id, payload.leave_type_id
    )

    # Same status-based gates as creation, so an edit can't switch a request to a
    # leave type the employee isn't allowed during probation / notice period.
    if await deactivated_user_ids(db, [user_id]):
        raise DomainException(
            message="Cannot edit a leave request: user account is deactivated",
            code="INACTIVE_USER",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    employee = await db["employees"].find_one({"user_id": to_oid(user_id)})
    status_info = None
    emp_status_id = employee.get("employment_status") if employee else None
    if emp_status_id:
        org_id_for_lookup = (
            str(employee.get("organisation_id"))
            if employee and employee.get("organisation_id") is not None else None
        )
        iam_statuses = await fetch_employment_statuses(organisation_id=org_id_for_lookup)
        status_info = iam_statuses.get(str(emp_status_id))
    # Inactive + no-manager gates (same as creation) — an inactive or manager-less
    # employee must not be able to edit a pending request either. (Audit B)
    if status_info and status_info.get("is_active") is False:
        raise DomainException(
            message=(
                f"Cannot edit a leave request: employee is in "
                f"'{status_info.get('value') or status_info.get('key')}' status"
            ),
            code="INACTIVE_EMPLOYEE",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if employee and not (employee.get("l1_manager_id") or employee.get("l2_manager_id")):
        raise DomainException(
            message="Cannot edit a leave request: no reporting manager (L1 or L2) is assigned to your profile",
            code="NO_MANAGER_ASSIGNED",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    _check_notice_period(policy, leave_type, status_info, employee=employee)
    _check_probation_leave_type(policy, status_info, payload.leave_type_id)
    _check_eligibility_restrictions(leave_type, employee)

    start_datetime, end_datetime = dates_to_datetimes(
        payload.start_date,
        payload.end_date,
        payload.duration_mode.value,
        payload.half_day_period.value if payload.half_day_period else None,
        payload.start_session.value if payload.start_session else None,
        payload.end_session.value if payload.end_session else None,
    )

    projected_raw = await _projected_balance_hours(
        db, user_id, plan_id, payload.leave_type_id, payload.start_date
    )
    # Exclude this request's own existing hold so the edit doesn't count against
    # itself; other pending holds still reduce availability.
    held = await get_active_hold_hours(
        db, user_id, payload.leave_type_id, exclude_request_id=request_id
    )
    projected_available = projected_raw - held

    duration_hours = await validate_and_compute(
        db,
        user_id=user_id,
        leave_type_id=payload.leave_type_id,
        start=start_datetime,
        end=end_datetime,
        policy=policy,
        leave_type=leave_type,
        loss_of_pay=False,
        duration_mode=payload.duration_mode.value,
        half_day_period=payload.half_day_period.value if payload.half_day_period else None,
        start_session=payload.start_session.value if payload.start_session else None,
        end_session=payload.end_session.value if payload.end_session else None,
        exclude_request_id=request_id,
        projected_balance_hours=projected_available,
        lop_balance_hours=projected_raw,
    )

    # Expiring / comp-off leave: re-validate the worked days against the edited
    # dates (same rules as creation).
    if leave_type.get("is_comp_off"):
        if payload.duration_mode.value != "FULL_DAYS":
            raise DomainException(
                message="Expiring (comp-off) leave can only be applied for full days",
                code="COMP_OFF_FULL_DAYS_ONLY",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        comp_off_leave_days = await _working_day_list(
            db, payload.start_date, payload.end_date, user_id
        )
        await validate_comp_off_worked_days(
            db,
            user_id,
            payload.worked_dates,
            comp_off_leave_days,
            leave_type.get("expiry_days"),
            datetime.now(timezone.utc).date(),
        )

    # Mandatory-attachment gate (same rule as creation).
    _check_upload_requirement(policy, leave_type, payload.asset_ids, duration_hours / 8.0)
    # Mandatory reason/comment gate.
    _check_comment_requirement(policy, leave_type, payload.reason)

    # "Extra leave" lets a request go paid-negative up to max_days, so within that
    # buffer it's not LOP. (Negative balance proper stays disabled.)
    _extra = ((policy.get("entitlement") or {}).get("extra_leave")) or {}
    allow_negative_balance = bool(_extra.get("status") == "ALLOWED" and (_extra.get("max_days") or 0) > 0)
    is_lop = await should_count_weekends_for_lop(
        db,
        user_id,
        payload.leave_type_id,
        leave_type,
        allow_negative_balance=allow_negative_balance,
        balance_hours=projected_raw,
    )

    request_oid = to_oid(request_id)
    # Gate the mutation on status=PENDING (not just _id): the PENDING check above is
    # a read; without this guard a concurrent approve/reject between the read and
    # this write would let us mutate a finalized request AND revive its converted
    # hold via the hold-reconcile below. modified_count==0 means we lost that race.
    _upd = await db[REQUESTS_COLLECTION].update_one(
        {"_id": request_oid, "status": "PENDING"},
        {
            "$set": {
                "leave_type_id": to_oid(payload.leave_type_id),
                "leave_plan_id": plan_id,
                "loss_of_pay": is_lop,
                "start_date": payload.start_date.isoformat(),
                "end_date": payload.end_date.isoformat(),
                "start_datetime": start_datetime,
                "end_datetime": end_datetime,
                "duration_mode": payload.duration_mode.value,
                "half_day_period": payload.half_day_period.value if payload.half_day_period else None,
                "start_session": payload.start_session.value if payload.start_session else None,
                "end_session": payload.end_session.value if payload.end_session else None,
                "duration_hours": duration_hours,
                "duration_days": duration_hours / 8.0,
                "reason": payload.reason,
                "notify_cc": payload.notify_cc,
                "asset_ids": payload.asset_ids,
                "worked_dates": [d.isoformat() for d in payload.worked_dates],
                **audit_fields_update(user_id),
            }
        },
    )
    if _upd.modified_count == 0:
        # Lost the race: the request was approved/rejected/cancelled concurrently.
        # Do NOT touch its hold (the approve path already converted/debited it).
        raise DomainException(
            message="Leave request can no longer be edited — it is no longer pending.",
            code="REQUEST_NOT_PENDING",
            status_code=status.HTTP_409_CONFLICT,
        )

    # Reconcile the balance hold to the edited request: re-hold the new hours
    # for a deducting non-LOP request, otherwise release any existing hold
    # (e.g. it became LOP or switched to a non-deducting type).
    if leave_type.get("deduct_from_balance", True) and not is_lop:
        hold_doc = {
            "_id": request_id,
            "user_id": to_oid(user_id),
            "leave_type_id": to_oid(payload.leave_type_id),
            "leave_plan_id": plan_id,
            "duration_hours": duration_hours,
        }
        await create_hold(db, hold_doc, user_id)
    else:
        await release_hold(db, request_id, user_id)

    await _record_activity(db, request_oid, "UPDATED", user_id)

    # Lifecycle state-change: user-facing activity + compliance audit.
    emp_for_org = await db["employees"].find_one(
        {"user_id": to_oid(user_id)}, {"organisation_id": 1}
    )
    org_id = str(emp_for_org["organisation_id"]) if emp_for_org and emp_for_org.get("organisation_id") else None
    await emit_activity(
        action="leave_request.updated",
        resource=f"leave_request:{request_id}",
        actor_id=user_id,
        organisation_id=org_id,
    )
    await emit_audit(
        action="leave_request.updated",
        resource=f"leave_request:{request_id}",
        actor_id=user_id,
        organisation_id=org_id,
    )

    logger.info("Leave request updated", request_id=request_id, employee_id=user_id)
    return await get_leave_request(db, request_id)


async def cancel_leave_request(
    db: AsyncIOMotorDatabase, request_id: str, employee_id: str
) -> dict:
    request = await get_leave_request(db, request_id)

    if str(request["user_id"]) != employee_id:
        raise DomainException(
            message="You can only cancel your own leave requests",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if request["status"] not in ("PENDING",):
        raise DomainException(
            message=f"Cannot cancel a request with status '{request['status']}'",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    now = datetime.now(timezone.utc)
    request_oid = to_oid(request_id)
    await _record_activity(db, request_oid, "CANCELLED", employee_id)
    await db[REQUESTS_COLLECTION].update_one(
        {"_id": request_oid},
        {"$set": {"status": "CANCELLED", **audit_fields_update(employee_id)}},
    )
    # Return the reserved balance.
    await release_hold(db, request_id, employee_id, now)

    # Dormant today (cancel is PENDING-only, so no approved leave reaches here),
    # but reverse any notice-period LWD extension if cancel-of-approved is later enabled.
    try:
        await _maybe_emit_notice_reversal(db, request, request_id)
    except Exception as exc:
        logger.warning(
            "notice-period reversal emit failed",
            request_id=request_id, error=repr(exc),
        )

    # Lifecycle state-change: user-facing activity + compliance audit.
    emp_doc = await db["employees"].find_one({"user_id": request["user_id"]})
    org_id = str(emp_doc["organisation_id"]) if emp_doc and emp_doc.get("organisation_id") else None
    await emit_activity(
        action="leave_request.cancelled",
        resource=f"leave_request:{request_id}",
        actor_id=employee_id,
        organisation_id=org_id,
    )
    await emit_audit(
        action="leave_request.cancelled",
        resource=f"leave_request:{request_id}",
        actor_id=employee_id,
        organisation_id=org_id,
    )

    if emp_doc and emp_doc.get("work_email"):
        leave_type_doc = await db["leave_types"].find_one({"_id": request["leave_type_id"]})
        start_str, end_str = email_date_strings(request)
        logger.info(
            "Triggering leave_request_cancelled email",
            to=emp_doc["work_email"],
            employee_name=emp_doc.get("name", ""),
            leave_type_name=leave_type_doc.get("name", "") if leave_type_doc else "",
            start_date=start_str,
            end_date=end_str,
            request_id=request_id,
            tenant_id=emp_doc.get("organisation_id", ""),
        )
        await email_events.publish_leave_request_cancelled(
            employee_email=emp_doc["work_email"],
            employee_name=emp_doc.get("name", ""),
            leave_type_name=leave_type_doc.get("name", "") if leave_type_doc else "",
            start_date=start_str,
            end_date=end_str,
            request_id=request_id,
            tenant_id=emp_doc.get("organisation_id", ""),
        )

    logger.info("Leave request cancelled", request_id=request_id)
    return await get_leave_request(db, request_id)


IST = timezone(timedelta(hours=5, minutes=30))
MANAGER_CANCEL_CUTOFF_HOUR = 10  # 10:00 AM IST on the cutoff day


def _manager_cancellation_cutoff(end_date: date) -> datetime:
    """Moment after which a manager may no longer cancel an approved leave:
    10:00 AM IST on the 24th that closes the payroll cycle (25th → 24th)
    containing the leave's end date. A leave ending on the 1st–24th belongs to
    that month's payroll; one ending on the 25th–31st rolls into the next
    cycle, so its window runs to the NEXT month's 24th."""
    if end_date.day <= 24:
        cutoff_day = date(end_date.year, end_date.month, 24)
    elif end_date.month == 12:
        cutoff_day = date(end_date.year + 1, 1, 24)
    else:
        cutoff_day = date(end_date.year, end_date.month + 1, 24)
    return datetime(
        cutoff_day.year, cutoff_day.month, cutoff_day.day,
        MANAGER_CANCEL_CUTOFF_HOUR, 0, 0, tzinfo=IST,
    )


def _as_date(value) -> date:
    """Normalise a persisted date that may be a date, datetime, or ISO string."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.fromisoformat(str(value)).date()


async def cancel_approved_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    manager_id: str,
    payload: CancellationActionPayload,
) -> dict:
    """Manager-initiated cancellation of an APPROVED leave request.

    Only allowed while the payroll window is open (see
    ``_manager_cancellation_cutoff``). Reverses the balance debit made at
    approval — LOP and non-deducting types never debited, so there is nothing
    to reverse for them; the payroll side simply drops the salary deduction
    when it sees the CANCELLED status.
    """
    request = await get_leave_request(db, request_id)

    if request["status"] != "APPROVED":
        raise DomainException(
            message=f"Only approved requests can be cancelled here (status is '{request['status']}')",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    cutoff = _manager_cancellation_cutoff(_as_date(request["end_date"]))
    if datetime.now(timezone.utc) > cutoff:
        raise DomainException(
            message=f"The cancellation window for this leave closed on {cutoff.strftime('%d %b %Y, %I:%M %p')} IST",
            code="CANCELLATION_WINDOW_CLOSED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    now = datetime.now(timezone.utc)
    request_oid = to_oid(request_id)

    # Atomically claim APPROVED → CANCELLED so a concurrent cancel (or any other
    # state change) can't double-credit the balance reversal.
    from pymongo import ReturnDocument

    claimed = await db[REQUESTS_COLLECTION].find_one_and_update(
        {"_id": request_oid, "status": "APPROVED"},
        {"$set": {
            "status": "CANCELLED",
            "cancelled_by": to_oid(manager_id),
            "cancellation_reason": payload.reason,
            "cancelled_on": now,
            **audit_fields_update(manager_id),
        }},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        latest = await get_leave_request(db, request_id)
        raise DomainException(
            message=f"Cannot cancel a request with status '{latest['status']}'",
            code="INVALID_REQUEST_STATUS",
            status_code=status.HTTP_409_CONFLICT,
        )

    await _record_activity(
        db, request_oid, "CANCELLED", manager_id, comment=payload.reason
    )

    # Reverse the debit the approval made. Mirrors the approval's debit
    # condition exactly: LOP requests and non-deducting types never debited,
    # so they get no credit. The credit lands on the employee's current
    # tracker balance — after a year rollover that IS the new year's balance.
    leave_type = await db["leave_types"].find_one({"_id": request["leave_type_id"]})
    if leave_type and leave_type.get("deduct_from_balance", True) and not request.get("loss_of_pay"):
        await db["leave_entitlement_ledger"].insert_one({
            "_id": str(uuid.uuid4()),
            "user_id": request["user_id"],
            "leave_type_id": request["leave_type_id"],
            "transaction_type": "CREDIT",
            "amount": request["duration_hours"],
            "reference_id": request_id,
            "note": "Credit on manager cancellation of approved leave",
            "created_on": now,
            "created_by": to_oid(manager_id),
        })
        await upsert_balance(
            db,
            str(request["user_id"]),
            str(request["leave_type_id"]),
            request.get("leave_plan_id"),
            request["duration_hours"],
            manager_id,
            now,
        )

    # Pull back any notice-period LWD extension the approval pushed out.
    try:
        await _maybe_emit_notice_reversal(db, request, request_id)
    except Exception as exc:
        logger.warning(
            "notice-period reversal emit failed",
            request_id=request_id, error=repr(exc),
        )

    # Lifecycle state-change: user-facing activity + compliance audit.
    emp_doc = await db["employees"].find_one({"user_id": request["user_id"]})
    org_id = str(emp_doc["organisation_id"]) if emp_doc and emp_doc.get("organisation_id") else None
    await emit_activity(
        action="leave_request.cancelled",
        resource=f"leave_request:{request_id}",
        actor_id=manager_id,
        organisation_id=org_id,
    )
    await emit_audit(
        action="leave_request.cancelled",
        resource=f"leave_request:{request_id}",
        actor_id=manager_id,
        organisation_id=org_id,
        details={"cancelled_by_manager": True, "reason": payload.reason},
    )

    if emp_doc and emp_doc.get("work_email"):
        leave_type_doc = leave_type or {}
        start_str, end_str = email_date_strings(request)
        logger.info(
            "Triggering leave_request_cancelled email (manager cancel)",
            to=emp_doc["work_email"],
            employee_name=emp_doc.get("name", ""),
            leave_type_name=leave_type_doc.get("name", ""),
            start_date=start_str,
            end_date=end_str,
            request_id=request_id,
            tenant_id=emp_doc.get("organisation_id", ""),
        )
        await email_events.publish_leave_request_cancelled(
            employee_email=emp_doc["work_email"],
            employee_name=emp_doc.get("name", ""),
            leave_type_name=leave_type_doc.get("name", ""),
            start_date=start_str,
            end_date=end_str,
            request_id=request_id,
            tenant_id=emp_doc.get("organisation_id", ""),
        )

    logger.info("Approved leave request cancelled by manager", request_id=request_id)
    return await get_leave_request(db, request_id)


# ─── Approval Overrides ──────────────────────────────────────────────────────

async def create_approval_override(
    db: AsyncIOMotorDatabase, payload: ApprovalOverrideCreate, created_by: str, org_id: str | None = None
) -> dict:
    req = await get_leave_request(db, payload.leave_request_id)

    # Tenant isolation: the override must target a request in the caller's org.
    req_org = req.get("organisation_id")
    if not org_id or (req_org is not None and str(req_org) != str(org_id)):
        raise DomainException(
            message="You do not have permission to override this leave request",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    request_oid = req["_id"]

    now = datetime.now(timezone.utc)
    doc = {
        "_id": str(uuid.uuid4()),
        **payload.model_dump(mode="json"),
        "created_by": created_by,
        "created_on": now,
    }
    await db[OVERRIDES_COLLECTION].insert_one(doc)

    for level_cfg in payload.levels:
        await _record_activity(
            db, request_oid, "REASSIGNED", created_by,
            level=level_cfg.level,
            comment=f"Approver reassigned to {level_cfg.approver_id}",
        )

    logger.info("Approval override applied", request_id=payload.leave_request_id)

    # Privilege-sensitive: reassigns who approves a live request. Compliance audit.
    await emit_audit(
        action="approval_override.created",
        resource=f"approval_override:{doc['_id']}",
        actor_id=created_by,
        details={
            "leave_request_id": str(payload.leave_request_id),
            "levels": [
                {"level": lc.level, "approver_id": str(lc.approver_id)}
                for lc in payload.levels
            ],
        },
    )
    return doc


# ─── Toggle Config ──────────────────────────────────────────────────────────

TOGGLE_COLLECTION = "leave_toggle_configs"


async def _validate_leave_plan(db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str) -> None:
    plan = await db["leave_plans"].find_one(
        {"_id": to_oid(leave_plan_id), "org_id": to_oid(org_id), "deleted_on": None}
    )
    if not plan:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )


async def get_toggle_config(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str
) -> dict | None:
    # None (not 404) when the plan exists but no config was saved yet — a new
    # plan legitimately has no toggle document until the first PUT. The FE
    # keeps its own initial state in that case; saved BE values always win.
    await _validate_leave_plan(db, leave_plan_id, org_id)
    return await db[TOGGLE_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})


async def upsert_toggle_config(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: ToggleConfigUpsert,
    user_id: str,
    org_id: str,
) -> dict:
    await _validate_leave_plan(db, leave_plan_id, org_id)
    existing = await db[TOGGLE_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})

    if existing:
        changed = payload.model_dump(mode="json")
        update_data = {
            **changed,
            **audit_fields_update(user_id),
        }
        await db[TOGGLE_COLLECTION].update_one(
            {"leave_plan_id": to_oid(leave_plan_id)},
            {"$set": update_data},
        )
        logger.info("Toggle config updated", leave_plan_id=leave_plan_id)
        await emit_audit(
            action="toggle_config.updated",
            resource=f"toggle_config:{leave_plan_id}",
            actor_id=user_id,
            organisation_id=str(org_id),
            changed_fields=list(changed.keys()),
        )
    else:
        doc = {
            "leave_plan_id": to_oid(leave_plan_id),
            **payload.model_dump(mode="json"),
            **audit_fields_create(user_id),
        }
        await db[TOGGLE_COLLECTION].insert_one(doc)
        logger.info("Toggle config created", leave_plan_id=leave_plan_id)
        await emit_audit(
            action="toggle_config.created",
            resource=f"toggle_config:{leave_plan_id}",
            actor_id=user_id,
            organisation_id=str(org_id),
        )

    return await db[TOGGLE_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})
