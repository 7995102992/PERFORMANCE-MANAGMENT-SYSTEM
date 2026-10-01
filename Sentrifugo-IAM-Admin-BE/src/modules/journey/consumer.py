"""Journey domain-event consumer.

Binds a durable queue to the shared ``domain_events`` topic exchange and turns
each event into a journey_timeline row and/or a journey_metrics update. IAM is
the single sink — it never queries the other services.

Delivery is at-least-once, so every handler is idempotent: we record each
event's idempotency_key in journey_processed_events and skip repeats.
"""
import asyncio
import json
from datetime import date, datetime, timedelta, timezone

import aio_pika
from beanie import PydanticObjectId
from pymongo.errors import DuplicateKeyError

from src.auth.models import UserDocument
from src.logger import logger
from src.rabbitmq import connection
from src.modules.organisation.models import (
    BandDocument,
    BusinessUnitDocument,
    DesignationDocument,
    EmployeeDocument,
    PayGradeDocument,
)
from src.modules.journey.models import (
    JourneyMetricsDocument,
    JourneyProcessedEventDocument,
    JourneyTimelineDocument,
)
from src.modules.exit_management.models import ExitRequestDocument

EXCHANGE_NAME = "domain_events"
QUEUE_NAME = "iam.journey"

_channel: aio_pika.abc.AbstractChannel | None = None
_consumer_task: asyncio.Task | None = None
_RETRY_INTERVAL_SECONDS = 5

# Routing keys we care about. IAM's own events flow today; the timesheet / leave
# / srm keys are bound up-front so those producers need no IAM change later.
ROUTING_KEYS = [
    "employee.created",
    "employee.updated",
    "exit.applied",
    "project.assigned",
    "project.reassigned",
    "leave.allocated",
    "leave.notice_period_changed",
    "service_request.raised",
    "timesheet.approved",
]

NOT_DELETED = {"deleted_on": None}

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12, "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7,
    "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _fy_start_month(fy_setting: str | None) -> int:
    """First month of the financial year from a BU setting like 'April - March'.
    Defaults to January (calendar year) when unknown."""
    if not fy_setting:
        return 1
    first = fy_setting.strip().split("-")[0].strip().lower()
    return _MONTHS.get(first, 1)


def _fy_period(when: datetime | date, fy_setting: str | None) -> str:
    """Bucket a timestamp into the employee's FY label.
    Calendar FY → '2024'; fiscal FY (e.g. Apr–Mar) → '2024-2025'."""
    start_month = _fy_start_month(fy_setting)
    year, month = when.year, when.month
    fy_start = year if month >= start_month else year - 1
    return str(fy_start) if start_month == 1 else f"{fy_start}-{fy_start + 1}"


def _to_oid(val) -> PydanticObjectId | None:
    try:
        return PydanticObjectId(val) if val else None
    except Exception:
        return None


def _parse_dt(val) -> datetime:
    """Parse an ISO date/datetime string → datetime (UTC). Falls back to now."""
    if not val:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(val).replace("Z", "+00:00"))
    except ValueError:
        try:
            return datetime.combine(date.fromisoformat(str(val)[:10]), datetime.min.time())
        except ValueError:
            return datetime.now(timezone.utc)


async def _resolve_fy_setting(user_id: PydanticObjectId | None) -> str | None:
    """The employee's BU financial-year string (drives metric bucketing).
    Best-effort: any lookup failure falls back to the calendar year."""
    if not user_id:
        return None
    try:
        emp = await EmployeeDocument.find_one(EmployeeDocument.user_id == user_id, NOT_DELETED)
        if not emp or not emp.business_unit_id:
            return None
        bu = await BusinessUnitDocument.find_one(BusinessUnitDocument.id == emp.business_unit_id)
        return bu.financial_year if bu else None
    except Exception:
        return None


async def _designation_detail(designation_id) -> dict:
    """Combined designation node detail: designation + its pay grades + bands."""
    oid = _to_oid(designation_id)
    if not oid:
        return {}
    desg = await DesignationDocument.find_one(DesignationDocument.id == oid, NOT_DELETED)
    if not desg:
        return {}
    pay_grades = await PayGradeDocument.find(
        {"_id": {"$in": list(desg.pay_grade_ids or [])}, **NOT_DELETED}
    ).to_list()
    band_ids = {bid for pg in pay_grades for bid in (pg.band_ids or [])}
    bands = await BandDocument.find({"_id": {"$in": list(band_ids)}, **NOT_DELETED}).to_list()
    return {
        "designation_id": str(oid),
        "designation": desg.designation_name,
        "pay_grades": [pg.name for pg in pay_grades],
        "bands": [b.name for b in bands],
    }


# ─── Writers ──────────────────────────────────────────────────────────────────

async def _add_timeline(
    *, user_id, organisation_id, event_type, title, occurred_at,
    source_service, idempotency_key, description=None, metadata=None,
) -> None:
    uid, oid = _to_oid(user_id), _to_oid(organisation_id)
    if not uid or not oid:
        return
    doc = JourneyTimelineDocument(
        user_id=uid,
        organisation_id=oid,
        event_type=event_type,
        title=title,
        description=description,
        occurred_at=occurred_at,
        source_service=source_service,
        metadata=metadata or {},
        idempotency_key=idempotency_key,
        created_at=datetime.now(timezone.utc),
    )
    try:
        await doc.insert()
    except DuplicateKeyError:
        pass  # already recorded (redelivery)


async def _bump_metric(user_id, organisation_id, occurred_at, *, hours=0.0, sr=0) -> None:
    uid, oid = _to_oid(user_id), _to_oid(organisation_id)
    if not uid or not oid:
        return
    period = _fy_period(occurred_at, await _resolve_fy_setting(uid))
    await JourneyMetricsDocument.get_motor_collection().update_one(
        {"user_id": uid, "period": period},
        {
            "$inc": {"worked_hours": float(hours), "service_requests_count": int(sr)},
            "$setOnInsert": {"user_id": uid, "organisation_id": oid, "period": period},
            "$set": {"updated_at": datetime.now(timezone.utc)},
        },
        upsert=True,
    )


# ─── Per-event handlers ───────────────────────────────────────────────────────

async def _manager_name(name, manager_id) -> str | None:
    """Manager display name for L1/L2 event titles: the payload-provided name if
    present, else resolved from the manager's USER id (l1/l2 ids are user ids)."""
    if name:
        return name
    oid = _to_oid(manager_id)
    if not oid:
        return None
    u = await UserDocument.find_one(UserDocument.id == oid)
    if not u:
        return None
    return f"{(u.first_name or '').strip()} {(u.last_name or '').strip()}".strip() or None


async def _handle_employee_created(p: dict, key: str) -> None:
    uid = p.get("user_id")
    oid = p.get("organisation_id")
    occurred = _parse_dt(p.get("date_of_joining"))

    # Onboarded — recorded once, never again
    await _add_timeline(
        user_id=uid, organisation_id=oid,
        event_type="onboarded", title="Onboarded",
        description=p.get("name"),
        occurred_at=occurred,
        source_service="iam", idempotency_key=key,
        metadata={"emp_code": p.get("emp_code")},
    )

    # L1 initial assignment
    if p.get("l1_manager_id"):
        l1_name = await _manager_name(p.get("l1_manager_name"), p.get("l1_manager_id"))
        await _add_timeline(
            user_id=uid, organisation_id=oid,
            event_type="l1_assigned",
            title=f"L1 Manager Assigned: {l1_name}" if l1_name else "L1 Manager Assigned",
            occurred_at=occurred, source_service="iam",
            idempotency_key=f"{key}:l1",
            metadata={"l1_manager_id": p.get("l1_manager_id"), "l1_manager_name": l1_name},
        )

    # L2 initial assignment
    if p.get("l2_manager_id"):
        l2_name = await _manager_name(p.get("l2_manager_name"), p.get("l2_manager_id"))
        await _add_timeline(
            user_id=uid, organisation_id=oid,
            event_type="l2_assigned",
            title=f"L2 Manager Assigned: {l2_name}" if l2_name else "L2 Manager Assigned",
            occurred_at=occurred, source_service="iam",
            idempotency_key=f"{key}:l2",
            metadata={"l2_manager_id": p.get("l2_manager_id"), "l2_manager_name": l2_name},
        )

    # Designation + Band + PayGrade initial assignment
    if p.get("designation_id"):
        detail = await _designation_detail(p.get("designation_id"))
        await _add_timeline(
            user_id=uid, organisation_id=oid,
            event_type="designation_assigned", title=f"Designation Assigned: {detail.get('designation', '')}",
            occurred_at=occurred, source_service="iam",
            idempotency_key=f"{key}:desg", metadata=detail,
        )
        if detail.get("pay_grades"):
            await _add_timeline(
                user_id=uid, organisation_id=oid,
                event_type="paygrade_assigned", title=f"Pay Grade Assigned: {', '.join(detail['pay_grades'])}",
                occurred_at=occurred, source_service="iam",
                idempotency_key=f"{key}:pg", metadata={"pay_grades": detail["pay_grades"]},
            )
        if detail.get("bands"):
            await _add_timeline(
                user_id=uid, organisation_id=oid,
                event_type="band_assigned", title=f"Band Assigned: {', '.join(detail['bands'])}",
                occurred_at=occurred, source_service="iam",
                idempotency_key=f"{key}:band", metadata={"bands": detail["bands"]},
            )


async def _handle_employee_updated(p: dict, key: str) -> None:
    changed = set(p.get("changed_fields") or [])
    occurred = datetime.now(timezone.utc)
    uid, oid = p.get("user_id"), p.get("organisation_id")

    if "l1_manager_id" in changed:
        l1_name = await _manager_name(p.get("l1_manager_name"), p.get("l1_manager_id"))
        await _add_timeline(
            user_id=uid, organisation_id=oid, event_type="l1_changed",
            title=f"L1 Manager changed to {l1_name}" if l1_name else "L1 Manager changed",
            occurred_at=occurred, source_service="iam",
            idempotency_key=f"{key}:l1",
            metadata={"l1_manager_id": p.get("l1_manager_id"), "l1_manager_name": l1_name},
        )
    if "l2_manager_id" in changed:
        l2_name = await _manager_name(p.get("l2_manager_name"), p.get("l2_manager_id"))
        await _add_timeline(
            user_id=uid, organisation_id=oid, event_type="l2_changed",
            title=f"L2 Manager changed to {l2_name}" if l2_name else "L2 Manager changed",
            occurred_at=occurred, source_service="iam",
            idempotency_key=f"{key}:l2",
            metadata={"l2_manager_id": p.get("l2_manager_id"), "l2_manager_name": l2_name},
        )
    if "designation_id" in changed:
        detail = await _designation_detail(p.get("designation_id"))
        await _add_timeline(
            user_id=uid, organisation_id=oid, event_type="designation_changed",
            title=f"Designation changed to {detail['designation']}" if detail.get("designation") else "Designation changed",
            occurred_at=occurred, source_service="iam",
            idempotency_key=f"{key}:desg", metadata=detail,
        )
        if detail.get("pay_grades"):
            await _add_timeline(
                user_id=uid, organisation_id=oid,
                event_type="paygrade_changed", title=f"Pay Grade changed to {', '.join(detail['pay_grades'])}",
                occurred_at=occurred, source_service="iam",
                idempotency_key=f"{key}:pg", metadata={"pay_grades": detail["pay_grades"]},
            )
        if detail.get("bands"):
            await _add_timeline(
                user_id=uid, organisation_id=oid,
                event_type="band_changed", title=f"Band changed to {', '.join(detail['bands'])}",
                occurred_at=occurred, source_service="iam",
                idempotency_key=f"{key}:band", metadata={"bands": detail["bands"]},
            )


async def _handle_exit(p: dict, key: str) -> None:
    await _add_timeline(
        user_id=p.get("user_id"), organisation_id=p.get("org_id") or p.get("organisation_id"),
        event_type="exit", title="Exit",
        description=p.get("reason_for_exit"),
        occurred_at=_parse_dt(p.get("last_working_day")),
        source_service="iam", idempotency_key=key,
        metadata={"exit_id": p.get("exit_id")},
    )


async def _handle_project_assigned(p: dict, key: str) -> None:
    await _add_timeline(
        user_id=p.get("user_id"), organisation_id=p.get("organisation_id") or p.get("org_id"),
        event_type="project_assigned",
        title=f"Assigned to {p.get('project_name')}" if p.get("project_name") else "Project assigned",
        occurred_at=_parse_dt(p.get("assigned_on") or p.get("occurred_at")),
        source_service="timesheet", idempotency_key=key,
        metadata={"project_id": p.get("project_id"), "project_name": p.get("project_name")},
    )


async def _handle_project_reassigned(p: dict, key: str) -> None:
    await _add_timeline(
        user_id=p.get("user_id"), organisation_id=p.get("organisation_id") or p.get("org_id"),
        event_type="project_reassigned",
        title=f"Reassigned to {p.get('project_name')}" if p.get("project_name") else "Project changed",
        occurred_at=_parse_dt(p.get("reassigned_on") or p.get("occurred_at")),
        source_service="timesheet", idempotency_key=key,
        metadata={
            "project_id": p.get("project_id"), "project_name": p.get("project_name"),
            "previous_project_id": p.get("previous_project_id"), "previous_project_name": p.get("previous_project_name"),
        },
    )


async def _handle_leave_allocated(p: dict, key: str) -> None:
    await _add_timeline(
        user_id=p.get("user_id"), organisation_id=p.get("organisation_id") or p.get("org_id"),
        event_type="leave_allocated",
        title=f"{p.get('leave_type')} leave allocated" if p.get("leave_type") else "Leave allocated",
        occurred_at=_parse_dt(p.get("allocated_on") or p.get("occurred_at")),
        source_service="leave", idempotency_key=key,
        metadata={
            "leave_type": p.get("leave_type"),
            "leave_type_id": p.get("leave_type_id"),
            "leave_year": p.get("leave_year"),
            "amount_hours": p.get("amount_hours"),
        },
    )


async def _handle_service_request_raised(p: dict, key: str) -> None:
    org = p.get("organisation_id") or p.get("org_id")
    occurred = _parse_dt(p.get("raised_on") or p.get("occurred_at"))
    await _add_timeline(
        user_id=p.get("user_id"), organisation_id=org,
        event_type="service_request_raised",
        title=p.get("title") or "Service request raised",
        occurred_at=occurred, source_service="srm", idempotency_key=key,
        metadata={"sr_id": p.get("sr_id"), "category": p.get("category")},
    )
    await _bump_metric(p.get("user_id"), org, occurred, sr=1)


async def _handle_timesheet_approved(p: dict, key: str) -> None:
    # Metric only — no timeline node for routine hour logging.
    await _bump_metric(
        p.get("user_id"), p.get("organisation_id") or p.get("org_id"),
        _parse_dt(p.get("period_end") or p.get("occurred_at")),
        hours=float(p.get("hours") or 0),
    )


def _add_business_days(start: date, n: int) -> date:
    """Date `n` business days (Mon-Fri) after `start`.

    Weekend-only skip: IAM has no org holiday calendar, so holidays falling in
    the extension window are not subtracted (a small, documented approximation —
    the leave service already computed `working_days` holiday-aware on its side).
    """
    if n <= 0:
        return start
    d = start
    added = 0
    while added < n:
        d = d + timedelta(days=1)
        if d.weekday() < 5:
            added += 1
    return d


async def _handle_notice_period_changed(p: dict, key: str) -> None:
    """Extend (or revert) an employee's last working day when leave is approved
    (or that approval is undone) during their notice period. Driven by the
    leave-management service over the domain_events bus.

    Idempotency is guaranteed upstream by ``_process_message`` (the handler runs
    once per delivery key), so the accumulator never double-applies. The new LWD
    is recomputed from a stored base + the accumulator, keeping it reversible.
    """
    action = (p.get("action") or "extend").lower()
    user_id = _to_oid(p.get("user_id"))
    try:
        working_days = float(p.get("working_days") or 0)
    except (TypeError, ValueError):
        working_days = 0.0
    if not user_id or working_days <= 0:
        return

    emp = await EmployeeDocument.find_one(EmployeeDocument.user_id == user_id, NOT_DELETED)
    if not emp:
        return

    # Only an employee actively serving notice (exit approved, not yet completed).
    exit_doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.employee_id == emp.id,
        {"status": {"$in": ["approved", "awaiting_clearances"]}},
        NOT_DELETED,
    )
    if not exit_doc or not exit_doc.last_working_day:
        # Employee is flagged notice-period (e.g. an admin set the status on the
        # employee form) but has no exit request / last working day to extend.
        # Nothing to move — log it rather than silently dropping the event.
        logger.warning(
            "journey: notice-period leave event but no exit record to extend",
            action=action, user_id=str(user_id),
            request_id=p.get("request_id"),
        )
        return

    base = exit_doc.base_last_working_day or exit_doc.last_working_day
    current_acc = exit_doc.notice_extension_days or 0.0
    if action == "revert":
        new_acc = max(0.0, current_acc - working_days)
    else:
        new_acc = current_acc + working_days

    whole_days = int(new_acc + 1e-9)  # floor; fractional remainder carried in the accumulator
    new_lwd = _add_business_days(base, whole_days)

    exit_doc.base_last_working_day = base
    exit_doc.notice_extension_days = new_acc
    exit_doc.last_working_day = new_lwd
    await exit_doc.save()

    logger.info(
        "journey: notice-period last working day updated",
        action=action, employee_id=str(emp.id),
        base=str(base), extension_days=new_acc, last_working_day=str(new_lwd),
    )

    await _add_timeline(
        user_id=p.get("user_id"),
        organisation_id=p.get("organisation_id") or p.get("org_id"),
        event_type="notice_period_adjusted",
        title="Notice period adjusted (leave during notice)",
        description=f"Last working day moved to {new_lwd}",
        occurred_at=datetime.now(timezone.utc),
        source_service="leave", idempotency_key=key,
        metadata={
            "request_id": p.get("request_id"), "action": action,
            "working_days": working_days, "last_working_day": str(new_lwd),
        },
    )


_HANDLERS = {
    "employee.created": _handle_employee_created,
    "employee.updated": _handle_employee_updated,
    "exit.applied": _handle_exit,
    "project.assigned": _handle_project_assigned,
    "project.reassigned": _handle_project_reassigned,
    "leave.allocated": _handle_leave_allocated,
    "service_request.raised": _handle_service_request_raised,
    "timesheet.approved": _handle_timesheet_approved,
    "leave.notice_period_changed": _handle_notice_period_changed,
}


# ─── Dispatch ─────────────────────────────────────────────────────────────────

async def _process_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    async with message.process(requeue=False):
        try:
            payload = json.loads(message.body)
        except (ValueError, TypeError):
            logger.warning("journey: undecodable message", routing_key=message.routing_key)
            return

        event_type = message.routing_key or payload.get("event_type", "")
        idem = (message.headers or {}).get("idempotency_key") or message.message_id or ""
        handler = _HANDLERS.get(event_type)
        if not handler or not idem:
            return

        # Idempotency: skip if we've already handled this delivery.
        if await JourneyProcessedEventDocument.find_one(
            JourneyProcessedEventDocument.idempotency_key == idem
        ):
            return

        try:
            await handler(payload, idem)
        except Exception as exc:
            logger.error("journey: handler failed", event_type=event_type, error=repr(exc))
            return  # acked (requeue=False); avoids poison loops

        try:
            await JourneyProcessedEventDocument(
                idempotency_key=idem, event_type=event_type,
                processed_at=datetime.now(timezone.utc),
            ).insert()
        except DuplicateKeyError:
            pass


# ─── Lifecycle ────────────────────────────────────────────────────────────────

async def start_journey_consumer() -> bool:
    """Declare the queue + bindings and start consuming.

    Returns ``True`` if the consumer was registered, ``False`` if the broker was
    unavailable or setup failed (``run_journey_consumer`` retries on ``False``).
    """
    global _channel
    if not await connection.ensure_ready():
        logger.warning("journey: RabbitMQ not ready, consumer not started")
        return False
    try:
        _channel = await connection.rabbitmq_connection.channel()
        await _channel.set_qos(prefetch_count=20)
        exchange = await _channel.declare_exchange(
            EXCHANGE_NAME, aio_pika.ExchangeType.TOPIC, durable=True,
        )
        queue = await _channel.declare_queue(QUEUE_NAME, durable=True)
        for rk in ROUTING_KEYS:
            await queue.bind(exchange, routing_key=rk)
        await queue.consume(_process_message)
        logger.info("Journey consumer started", queue=QUEUE_NAME)
        return True
    except Exception as exc:
        logger.error("journey: consumer start failed", error=repr(exc))
        return False


async def run_journey_consumer() -> None:
    """Retry wrapper: keep attempting to register the consumer until it
    succeeds, so a broker that was down at boot self-heals with no process
    restart. Once registered, aio-pika's robust connection re-establishes the
    subscription across broker flaps, so this returns after the first success.
    """
    while True:
        if await start_journey_consumer():
            return
        await asyncio.sleep(_RETRY_INTERVAL_SECONDS)


def start_journey_consumer_task() -> None:
    """Launch the consumer retry loop as a background task (non-blocking, so a
    broker down at boot doesn't hold up app startup)."""
    global _consumer_task
    _consumer_task = asyncio.create_task(run_journey_consumer())
    logger.info("Journey consumer task started")


async def stop_journey_consumer() -> None:
    global _channel, _consumer_task
    if _consumer_task is not None and not _consumer_task.done():
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    _consumer_task = None
    if _channel is not None and not _channel.is_closed:
        await _channel.close()
    _channel = None
