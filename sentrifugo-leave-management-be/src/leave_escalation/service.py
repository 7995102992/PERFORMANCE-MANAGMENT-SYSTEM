"""Escalation processing: notify HR when leave requests breach their SLA.

A pending leave request is "overdue" once it has been awaiting action for at
least the plan's approval-flow ``skip_if_no_action_days``. When that happens —
and the plan allows HR to act (``allow_hr_to_act``) — every HR-permission holder
in the request's organisation is emailed so they can step in. Each request is
stamped ``escalation_notified_on`` so it is notified only once.
"""
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_activity, emit_audit
from src.clients.iam_users import fetch_hr_users
from src.leave_requests.service import (
    REQUESTS_COLLECTION,
    email_date_strings,
    get_approval_flow_by_plan,
)
from src.logger import logger
from src.messaging import email_events
from src.utils import to_oid


def _days_pending(created, now: datetime) -> int | None:
    if not isinstance(created, datetime):
        return None
    created_aware = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
    return max((now - created_aware).days, 0)


async def run_escalation_processing(db: AsyncIOMotorDatabase, now: datetime) -> int:
    """Scan overdue pending requests and queue HR escalation emails.

    Returns the number of requests escalated this run.
    """
    candidates = await db[REQUESTS_COLLECTION].find({
        "status": "PENDING",
        "deleted_on": None,
        "escalation_notified_on": None,
        "leave_plan_id": {"$ne": None},
    }).to_list(length=None)

    if not candidates:
        return 0

    # Per-plan caches so a busy plan resolves its flow/policy/org/HR-list once.
    flow_cache: dict = {}
    policy_cache: dict = {}
    plan_org_cache: dict = {}
    hr_cache: dict = {}
    lt_cache: dict = {}
    escalated = 0

    for req in candidates:
        plan_id = req.get("leave_plan_id")
        plan_key = str(plan_id)

        # SLA threshold from the approval flow.
        if plan_key not in flow_cache:
            flow_cache[plan_key] = await get_approval_flow_by_plan(db, plan_id)
        flow = flow_cache[plan_key]
        skip_days = flow.get("skip_if_no_action_days") if flow else None
        if not skip_days or skip_days <= 0:
            continue

        days_pending = _days_pending(req.get("created_on"), now)
        if days_pending is None or days_pending < skip_days:
            continue

        # Only escalate where HR is actually allowed to act.
        if plan_key not in policy_cache:
            policy_cache[plan_key] = await db["leave_approval_policies"].find_one(
                {"leave_plan_id": to_oid(plan_id)}
            )
        policy = policy_cache[plan_key]
        if not (policy and policy.get("allow_hr_to_act")):
            continue

        # Resolve the plan's organisation, then its HR users.
        if plan_key not in plan_org_cache:
            plan_doc = await db["leave_plans"].find_one(
                {"_id": to_oid(plan_id)}, {"org_id": 1}
            )
            plan_org_cache[plan_key] = str(plan_doc["org_id"]) if plan_doc and plan_doc.get("org_id") else None
        org_id = plan_org_cache[plan_key]
        if not org_id:
            continue

        if org_id not in hr_cache:
            hr_cache[org_id] = await fetch_hr_users(org_id)
        hr_users = hr_cache[org_id]
        if not hr_users:
            continue

        # Context for the email.
        emp = await db["employees"].find_one({"user_id": req["user_id"]})
        employee_name = (emp.get("name") if emp else "") or ""
        lt_id = req.get("leave_type_id")
        lt_key = str(lt_id)
        if lt_key not in lt_cache:
            lt_doc = await db["leave_types"].find_one({"_id": lt_id})
            lt_cache[lt_key] = lt_doc.get("name", "") if lt_doc else ""
        leave_type_name = lt_cache[lt_key]

        request_id = str(req["_id"])
        start_str, end_str = email_date_strings(req)

        for hr in hr_users:
            await email_events.publish_leave_escalation_to_hr(
                hr_email=hr["email"],
                hr_name=hr.get("name") or "",
                employee_name=employee_name,
                leave_type_name=leave_type_name,
                start_date=start_str,
                end_date=end_str,
                days_pending=days_pending,
                request_id=request_id,
                tenant_id=org_id,
            )

        await db[REQUESTS_COLLECTION].update_one(
            {"_id": req["_id"]},
            {"$set": {"escalation_notified_on": now, "escalation_days": days_pending}},
        )
        escalated += 1
        logger.info(
            "Leave request escalated to HR",
            request_id=request_id,
            days_pending=days_pending,
            hr_count=len(hr_users),
        )

    if escalated:
        logger.info("Escalation cron: requests escalated", count=escalated)
        audit_kwargs = dict(
            action="leave_request.escalated",
            resource="escalation:batch",
            actor_id="system",
            organisation_id=None,
            details={"count": escalated},
        )
        await emit_activity(**audit_kwargs)
        await emit_audit(**audit_kwargs)
    return escalated
