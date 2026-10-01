from datetime import date as date_type, datetime, time as time_type, timedelta, timezone
from typing import Any, List, Optional

from bson import ObjectId
from langchain_core.tools import tool
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.utils import to_oid

from src.balance_tracker import get_available_balance
from src.exceptions import DomainException
from src.leave_requests import service
from src.work_calendar.resolver import is_working_day as _calendar_is_working_day
from src.leave_requests.schemas import (
    ApprovalActionPayload,
    DurationMode,
    LeaveRequestCreate,
    SessionHalf,
)
from src.manager.service import (
    approve_managed_leave_request,
    list_pending_approvals as _manager_list_pending_approvals,
    reject_managed_leave_request,
)

_MAX_REASON = 300


def _risk_level(duration_days: float, is_lop: bool) -> str:
    if is_lop or duration_days > 3:
        return "HIGH"
    if round(duration_days) == 2:
        return "MEDIUM"
    return "LOW"


def make_leave_tools(db: AsyncIOMotorDatabase, user_id: str) -> list[Any]:
    """Build leave management tools bound to the current user session."""

    # ── Info tools ────────────────────────────────────────────────────────────

    @tool
    async def list_leave_types() -> str:
        """List all available leave types with their IDs, names, and units.
        Always call this first if the user hasn't provided a leave_type_id.
        """
        leave_types = await db["leave_types"].find({"deleted_on": None}).to_list(length=None)
        if not leave_types:
            return "No leave types are currently available."
        lines = [
            f"- ID: {lt['_id']}  Name: {lt.get('name', 'N/A')}  "
            f"Unit: {lt.get('unit', 'DAYS')}  Deducts balance: {lt.get('deduct_from_balance', True)}"
            for lt in leave_types
        ]
        return "\n".join(lines)

    @tool
    async def check_leave_balance(leave_type_id: str) -> str:
        """Check the current user's available leave balance for a specific leave type.

        Args:
            leave_type_id: The leave type ID. Call list_leave_types if unsure.
        """
        leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
        if not leave_type:
            return "Leave type not found. Call list_leave_types to get valid IDs."

        if not leave_type.get("deduct_from_balance", True):
            return f"{leave_type.get('name', 'N/A')}: no balance limit — unlimited usage."

        unit = leave_type.get("unit", "DAYS")
        available_hours = max(0.0, await get_available_balance(db, user_id, leave_type_id))
        available_days = available_hours / 8.0 if unit == "DAYS" else available_hours

        return (
            f"Leave type : {leave_type.get('name', 'N/A')}\n"
            f"Balance    : {available_days:.2f} day(s)  ({available_hours:.2f} h)"
        )

    @tool
    async def list_upcoming_holidays(days_ahead: int = 30) -> str:
        """List public holidays coming up for the current user.

        Applies both the employee's holiday plan assignment and department/BU
        scoping rules, so only holidays that actually affect this user are shown.

        Args:
            days_ahead: How many calendar days forward to look (default 30, max 365).
        """
        days_ahead = min(max(days_ahead, 1), 365)
        today = date_type.today()
        until = today + timedelta(days=days_ahead)

        employee = await db["employees"].find_one(
            {"user_id": to_oid(user_id), "is_deleted": {"$ne": True}},
            {"organisation_id": 1, "department_id": 1, "business_unit_id": 1},
        )
        if not employee:
            return "Employee profile not found."

        org_id = employee.get("organisation_id")
        dept_id = employee.get("department_id")
        bu_id = employee.get("business_unit_id")

        if not org_id:
            return "No organisation found for this employee."

        # Prefer the employee's explicit holiday plan assignment; fall back to
        # all active plans for the org so the user still gets an answer even
        # without a direct assignment.
        plan_assignment = await db["holiday_plan_employees"].find_one(
            {"user_id": to_oid(user_id), "deleted_on": None}
        )
        holiday_query: dict = {
            "date": {"$gte": today.isoformat(), "$lte": until.isoformat()},
            "deleted_on": None,
        }
        if plan_assignment:
            holiday_query["plan_id"] = plan_assignment["plan_id"]
        else:
            active_plans = await db["holiday_plans"].find(
                {"org_id": to_oid(org_id), "deleted_on": None}, {"_id": 1}
            ).to_list(length=None)
            if not active_plans:
                return f"No upcoming holidays found in the next {days_ahead} days."
            holiday_query["plan_id"] = {"$in": [p["_id"] for p in active_plans]}

        holidays = await db["holidays"].find(holiday_query).sort("date", 1).to_list(length=None)

        # Mirror the resolver's dept/BU filter so only relevant holidays appear
        applicable = []
        for h in holidays:
            applicable_depts = h.get("applicable_department_ids") or []
            if applicable_depts and dept_id and dept_id not in applicable_depts:
                continue
            holiday_bu = h.get("business_unit_id")
            if holiday_bu and bu_id and holiday_bu != bu_id:
                continue
            applicable.append(h)

        if not applicable:
            return f"No upcoming holidays in the next {days_ahead} days."

        lines = [f"Upcoming holidays (next {days_ahead} days):"]
        for h in applicable:
            lines.append(f"  • {h['date']}  {h.get('name', 'Holiday')}")
        return "\n".join(lines)

    @tool
    async def check_day_availability(dates: List[str]) -> str:
        """Check whether specific dates are working days for the current user.

        Uses both the work calendar (weekends, custom off-days) and the holiday
        calendar. Call this before applying for leave to confirm the days actually
        count as working days and to avoid submitting leaves that cover non-working
        days.

        Args:
            dates: List of ISO date strings to check, e.g. ["2026-06-01", "2026-06-02"].
                   Maximum 30 dates per call.
        """
        if not dates:
            return "No dates provided."

        dates = dates[:30]
        lines = []
        for date_str in dates:
            try:
                target = date_type.fromisoformat(date_str)
            except ValueError:
                lines.append(f"  {date_str}: invalid date format (use YYYY-MM-DD)")
                continue

            result = await _calendar_is_working_day(db, user_id, target)
            day_name = target.strftime("%A")

            if result["is_working_day"]:
                lines.append(f"  {date_str} ({day_name}): working day")
            elif result["is_holiday"]:
                lines.append(f"  {date_str} ({day_name}): public holiday")
            elif result["is_weekend"]:
                lines.append(f"  {date_str} ({day_name}): weekend / day off")
            else:
                reason = result.get("reason") or "non-working"
                lines.append(f"  {date_str} ({day_name}): non-working ({reason})")

        return "Day availability:\n" + "\n".join(lines)

    @tool
    async def check_leave_eligibility(
        leave_type_id: str,
        start_date: str,
        end_date: str,
        duration_mode: str = "FULL_DAYS",
        half_day_period: Optional[str] = None,
        start_session: Optional[str] = None,
        end_session: Optional[str] = None,
    ) -> str:
        """Run pre-flight validation for a leave request without submitting it.

        Returns a detailed report covering date validity, estimated duration,
        overlap detection, and balance availability.
        Always call this BEFORE apply_leave so every issue is surfaced upfront.

        Args:
            leave_type_id: The leave type ID.
            start_date: ISO date string (e.g. 2026-05-01).
            end_date: ISO date string (e.g. 2026-05-03).
            duration_mode: FULL_DAYS (default), HALF_DAY, or CUSTOM.
            half_day_period: FIRST_HALF or SECOND_HALF — required for HALF_DAY mode.
            start_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
            end_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
        """
        report: list[str] = []
        issues: list[str] = []
        now_utc = datetime.now(timezone.utc)

        # 1. Parse dates
        try:
            s_date = date_type.fromisoformat(start_date)
            e_date = date_type.fromisoformat(end_date)
        except ValueError:
            return "Invalid date format — use ISO date (e.g. 2026-05-01)."

        if s_date > e_date:
            return "end_date must be on or after start_date."

        if duration_mode == "HALF_DAY" and s_date != e_date:
            return "HALF_DAY mode requires start_date and end_date to be the same day."

        if s_date.year > now_utc.year:
            return f"Leave requests can only be submitted for the current year ({now_utc.year}). Requested year: {s_date.year}."

        report.append("✅ Dates: Valid")

        # 2. Leave type
        leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
        if not leave_type:
            return "Leave type not found. Call list_leave_types for valid IDs."

        unit = leave_type.get("unit", "DAYS")
        report.append(f"ℹ️  Leave type: {leave_type.get('name', 'N/A')} (unit: {unit})")

        # 3. Estimate duration via service (reuses work-calendar resolver and rounding)
        duration_days = 0.0
        try:
            estimate = await service.estimate_leave_duration(
                db,
                employee_id=user_id,
                leave_type_id=leave_type_id,
                start_date_str=start_date,
                end_date_str=end_date,
                duration_mode=duration_mode,
                half_day_period=half_day_period,
                start_session=start_session,
                end_session=end_session,
            )
            duration_hours = estimate["estimated_hours"]
            duration_days = estimate["estimated_days"]

            if duration_hours <= 0:
                issues.append("Duration is zero — check your dates or duration mode.")
                report.append("❌ Duration: Zero after computation")
            else:
                report.append(
                    f"✅ Duration: {duration_days:.2f} day(s)  /  {duration_hours:.2f} hour(s)"
                )
        except DomainException as exc:
            issues.append(exc.message)
            report.append(f"❌ Duration: {exc.message}")
        except Exception as exc:
            issues.append(f"Duration computation failed: {exc}")
            report.append(f"❌ Duration: Could not compute — {exc}")

        # 4. Backdated-leave submission deadline check (only field that gates past dates now)
        today = now_utc.date()
        if s_date < today:
            try:
                policy = await service.get_entitlement_policy_for_employee(db, user_id, leave_type_id)
                entitlement = policy.get("entitlement") or {}
                backdated_cfg = entitlement.get("backdated_leave") or {}
                days_back = (today - s_date).days

                if backdated_cfg.get("enabled"):
                    max_deadline = backdated_cfg.get("max_days")
                    if max_deadline is not None:
                        if days_back > max_deadline:
                            issues.append(
                                f"Backdated leave deadline exceeded — must submit within "
                                f"{max_deadline} day(s) of absence date ({days_back} day(s) ago)."
                            )
                            report.append(
                                f"❌ Backdated deadline: Exceeded ({days_back}/{max_deadline} days)"
                            )
                        else:
                            report.append(
                                f"✅ Backdated deadline: Within limit ({days_back}/{max_deadline} days)"
                            )
                    else:
                        report.append("✅ Backdated leave: Allowed (no deadline)")
                else:
                    report.append("✅ Backdated leave: No restriction configured")
            except DomainException as exc:
                issues.append(f"Could not verify past-date policy: {exc.message}")
                report.append(f"⚠️  Past date: Policy check failed — {exc.message}")
        else:
            report.append("✅ Date policy: OK")

        # 5. Overlaps against existing PENDING / APPROVED requests
        try:
            start_dt = datetime.combine(s_date, time_type.min).replace(tzinfo=timezone.utc)
            end_dt = datetime.combine(e_date, time_type.max).replace(tzinfo=timezone.utc)
            overlap = await db["leave_requests"].find_one({
                "user_id": to_oid(user_id),
                "status": {"$in": ["PENDING", "APPROVED"]},
                "deleted_on": None,
                "start_datetime": {"$lt": end_dt},
                "end_datetime": {"$gt": start_dt},
            })
            if overlap:
                issues.append("An overlapping PENDING/APPROVED request already exists.")
                report.append(
                    f"❌ Overlaps: Conflict found (ID: {overlap['_id']}, Status: {overlap['status']})"
                )
            else:
                report.append("✅ Overlaps: None found")
        except Exception as exc:
            report.append(f"⚠️  Overlaps: Could not check — {exc}")

        # 6. Balance check from tracker
        if leave_type.get("deduct_from_balance", True):
            available_hours = max(0.0, await get_available_balance(db, user_id, leave_type_id))
            balance_days = available_hours / 8.0 if unit == "DAYS" else available_hours

            if duration_days > balance_days:
                shortfall = duration_days - balance_days
                issues.append(
                    f"Insufficient balance: {balance_days:.2f} available, "
                    f"{duration_days:.2f} required (shortfall: {shortfall:.2f})."
                )
                report.append(
                    f"⚠️  Balance: INSUFFICIENT\n"
                    f"   Available : {balance_days:.2f} day(s)\n"
                    f"   Required  : {duration_days:.2f} day(s)\n"
                    f"   Shortfall : {shortfall:.2f} day(s)\n"
                    f"   → Apply as Loss of Pay (LOP)? Risk level will be HIGH."
                )
            else:
                report.append(
                    f"✅ Balance: Sufficient — {balance_days:.2f} day(s) available, "
                    f"{duration_days:.2f} requested"
                )
        else:
            report.append("ℹ️  Balance: Not tracked for this leave type")

        if issues:
            bullet_issues = "\n".join(f"  • {i}" for i in issues)
            summary = f"\n⚠️  {len(issues)} issue(s) found:\n{bullet_issues}"
        else:
            risk = _risk_level(duration_days, is_lop=False)
            summary = f"\n✅ All checks passed. Risk level will be {risk}. You may call apply_leave."

        return "\n".join(report) + summary

    # ── Application tools ─────────────────────────────────────────────────────

    @tool
    async def apply_leave(
        leave_type_id: str,
        start_date: str,
        end_date: str,
        reason: str = "",
        duration_mode: str = "FULL_DAYS",
        half_day_period: Optional[str] = None,
        start_session: Optional[str] = None,
        end_session: Optional[str] = None,
        loss_of_pay: bool = False,
    ) -> str:
        """Submit a leave request for the current user.

        Call check_leave_eligibility first and only proceed when it passes
        (or the user explicitly agrees to LOP for an insufficient-balance case).

        Risk level is auto-computed and attached to the manager note:
          HIGH   — LOP requested, OR leave > 3 days
          MEDIUM — 2 days
          LOW    — ≤ 1 day with sufficient balance

        Args:
            leave_type_id: Leave type ID (from list_leave_types).
            start_date: ISO date string (e.g. 2026-05-01).
            end_date: ISO date string (e.g. 2026-05-03).
            reason: Employee's reason for the leave (max 280 chars).
            duration_mode: FULL_DAYS (default), HALF_DAY, or CUSTOM.
            half_day_period: FIRST_HALF or SECOND_HALF — required for HALF_DAY mode.
            start_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
            end_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
            loss_of_pay: Set True only when the user explicitly agrees to LOP
                         after being informed of insufficient balance.
        """
        try:
            s_date = date_type.fromisoformat(start_date)
            e_date = date_type.fromisoformat(end_date)
        except ValueError as exc:
            return f"Invalid date format — use ISO date (e.g. 2026-05-01). Detail: {exc}"

        leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
        if not leave_type:
            return "Leave type not found. Call list_leave_types to get valid IDs."

        unit = leave_type.get("unit", "DAYS")

        # Estimate duration for risk-level computation
        duration_days = 0.0
        try:
            estimate = await service.estimate_leave_duration(
                db,
                employee_id=user_id,
                leave_type_id=leave_type_id,
                start_date_str=start_date,
                end_date_str=end_date,
                duration_mode=duration_mode,
                half_day_period=half_day_period,
                start_session=start_session,
                end_session=end_session,
            )
            duration_days = estimate["estimated_days"]
        except Exception:
            pass

        # Fetch balance for LOP annotation
        balance_days = 0.0
        if loss_of_pay and leave_type.get("deduct_from_balance", True):
            available_hours = max(0.0, await get_available_balance(db, user_id, leave_type_id))
            balance_days = available_hours / 8.0 if unit == "DAYS" else available_hours

        risk = _risk_level(duration_days, loss_of_pay)
        lop_suffix = (
            f" | LOP — {balance_days:.2f} day(s) available, {duration_days:.2f} requested"
        ) if loss_of_pay else ""
        risk_tag = f"[RISK:{risk}{lop_suffix}]"

        # Cap total reason at schema max of 300 chars
        full_note = f"{risk_tag} {reason.strip()}".strip()[:_MAX_REASON]

        try:
            payload = LeaveRequestCreate(
                leave_type_id=leave_type_id,
                start_date=s_date,
                end_date=e_date,
                duration_mode=DurationMode(duration_mode),
                half_day_period=SessionHalf(half_day_period) if half_day_period else None,
                start_session=SessionHalf(start_session) if start_session else None,
                end_session=SessionHalf(end_session) if end_session else None,
                reason=full_note,
            )
            doc = await service.create_leave_request(db, payload, user_id, loss_of_pay=loss_of_pay)
            return (
                f"Leave request submitted.\n"
                f"Request ID : {doc['_id']}\n"
                f"Duration   : {doc['duration_hours']:.2f} hours  ({doc['duration_days']:.2f} day(s))\n"
                f"Status     : {doc['status']}\n"
                f"Risk level : {risk}"
            )
        except DomainException as exc:
            return f"Could not submit leave request: {exc.message}"
        except Exception as exc:
            return f"Unexpected error submitting leave: {exc}"

    @tool
    async def list_my_leave_requests(status: str = "") -> str:
        """List leave requests submitted by the current user.

        Args:
            status: Optional filter — PENDING, APPROVED, REJECTED, CANCELLED.
                    Omit to return all.
        """
        try:
            requests = await service.list_my_leave_requests(
                db, user_id=user_id, status_filter=status.upper() or None
            )
            if not requests:
                return "No leave requests found."
            lines = [
                f"- ID: {r['_id']}  Status: {r['status']}  "
                f"From: {r.get('start_date')}  To: {r.get('end_date')}  "
                f"Duration: {r['duration_hours']}h"
                for r in requests
            ]
            return "\n".join(lines)
        except DomainException as exc:
            return f"Error: {exc.message}"
        except Exception as exc:
            return f"Unexpected error: {exc}"

    @tool
    async def get_leave_request_details(request_id: str) -> str:
        """Get full details of a specific leave request, including manager info and activity timeline.

        Args:
            request_id: The leave request ID.
        """
        try:
            doc = await service.get_leave_request_detail(db, request_id)
            lines = [
                f"Request ID    : {doc['_id']}",
                f"Leave type    : {doc['leave_type_id']}",
                f"From          : {doc.get('start_date')}",
                f"To            : {doc.get('end_date')}",
                f"Duration      : {doc['duration_hours']} hours ({doc['duration_days']} days)",
                f"Mode          : {doc.get('duration_mode', 'FULL_DAYS')}",
                f"Status        : {doc['status']}",
                f"Approval level: {doc.get('approval_state', {}).get('current_level', 'N/A')}",
                f"Reason        : {doc.get('reason') or '—'}",
            ]
            l1 = doc.get("l1_manager")
            l2 = doc.get("l2_manager")
            if l1:
                lines.append(f"L1 Manager    : {l1.get('name')} (ID: {l1.get('id')})")
            if l2:
                lines.append(f"L2 Manager    : {l2.get('name')} (ID: {l2.get('id')})")
            timeline = doc.get("approval_timeline") or []
            if timeline:
                lines.append("Timeline:")
                for entry in timeline:
                    ts = entry.get("timestamp", "")
                    if hasattr(ts, "isoformat"):
                        ts = ts.isoformat()
                    actor = entry.get("actor_name") or entry.get("actor_id", "?")
                    comment = f" — {entry['comment']}" if entry.get("comment") else ""
                    level = f" (level {entry['level']})" if entry.get("level") is not None else ""
                    lines.append(f"  • {entry['action']}{level} by {actor} at {ts}{comment}")
            return "\n".join(lines)
        except DomainException as exc:
            return f"Error: {exc.message}"
        except Exception as exc:
            return f"Unexpected error: {exc}"

    # ── Manager approval tools ────────────────────────────────────────────────

    @tool
    async def list_pending_approvals() -> str:
        """List PENDING leave requests from your direct reports that await your approval.

        Returns only requests you are eligible to act on based on the leave plan's
        approval policy:
          • OR policy  — either L1 or L2 manager may approve; all your pending requests
                         are shown.
          • AND policy — L1 must approve first (level 1), then L2 (level 2). Only
                         requests at YOUR level are shown.
        """
        try:
            docs = await _manager_list_pending_approvals(db, user_id)
            if not docs:
                return "No leave requests are pending your approval."
            lines = []
            for r in docs:
                reason = r.get("reason") or ""
                risk_tag = ""
                if reason.startswith("[RISK:"):
                    risk_tag = reason[: reason.index("]") + 1] + "  "
                current_level = r.get("approval_state", {}).get("current_level", "?")
                lines.append(
                    f"- Request ID: {r['_id']}  "
                    f"From: {r.get('start_date')}  To: {r.get('end_date')}  "
                    f"Duration: {r.get('duration_hours')}h  "
                    f"Awaiting: L{current_level} approval  {risk_tag}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"Unexpected error: {exc}"

    @tool
    async def approve_leave(request_id: str, comment: str = "") -> str:
        """Approve a leave request from one of your direct reports.

        Only works for employees you manage (l1 or l2 manager).
        Respects the leave plan's approval policy:
          • OR policy  — your approval finalizes the request immediately.
          • AND policy — if you are the L1 manager your approval advances the request
                         to L2; the L2 manager must then also approve before the leave
                         is finalized. If you are the L2 manager your approval finalizes.

        Call list_pending_approvals first if you don't have the request ID.

        Args:
            request_id: The leave request ID to approve.
            comment: Optional approval comment.
        """
        try:
            payload = ApprovalActionPayload(comment=comment or None)
            doc = await approve_managed_leave_request(db, request_id, user_id, payload)
            final_status = doc["status"]
            if final_status == "APPROVED":
                return f"Leave request {request_id} fully approved. Status: APPROVED."
            else:
                next_level = doc.get("approval_state", {}).get("current_level", "?")
                return (
                    f"Leave request {request_id} approved at this level. "
                    f"Status: PENDING — awaiting L{next_level} approval."
                )
        except DomainException as exc:
            return f"Could not approve: {exc.message}"
        except Exception as exc:
            return f"Unexpected error: {exc}"

    @tool
    async def reject_leave(request_id: str, comment: str = "") -> str:
        """Reject a leave request from one of your direct reports.

        Only works for employees you manage (l1 or l2 manager).
        A comment is strongly recommended, especially for LOP or high-risk requests.

        Args:
            request_id: The leave request ID to reject.
            comment: Reason for rejection (recommended).
        """
        try:
            payload = ApprovalActionPayload(comment=comment or None)
            doc = await reject_managed_leave_request(db, request_id, user_id, payload)
            return f"Leave request {request_id} rejected. Final status: {doc['status']}."
        except DomainException as exc:
            return f"Could not reject: {exc.message}"
        except Exception as exc:
            return f"Unexpected error: {exc}"

    @tool
    async def cancel_leave(request_id: str) -> str:
        """Cancel one of your own pending leave requests.

        Args:
            request_id: The leave request ID.
        """
        try:
            await service.cancel_leave_request(db, request_id, user_id)
            return f"Leave request {request_id} cancelled."
        except DomainException as exc:
            return f"Could not cancel: {exc.message}"
        except Exception as exc:
            return f"Unexpected error: {exc}"

    return [
        list_leave_types,
        check_leave_balance,
        list_upcoming_holidays,
        check_day_availability,
        check_leave_eligibility,
        apply_leave,
        list_my_leave_requests,
        get_leave_request_details,
        list_pending_approvals,
        approve_leave,
        reject_leave,
        cancel_leave,
    ]
