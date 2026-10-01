import asyncio
import json

import aio_pika

from src.database import get_db
from src.logger import logger
from src.messaging.constants.queues import Queues
from src.messaging.consumers.rpc_support import publish_reply, start_with_retry
from src.rabbitmq import get_connection
from src.utils import to_oid

_LOG_NAME = "Shift details RPC"


async def _get_shift_details(db, user_id: str) -> dict | None:
    """
    Resolve a user's shift by walking:
      work_calendar_employees → work_calendars
      → work_calendar_shift_assignments → work_calendar_shifts
    Returns None if the user has no calendar assignment.

    weekend_matrix codes (Mon=index 0 .. Sun=index 6):
      0 = full day off (weekend)
      1 = full working day
      2 = half day
      3 = full/half (rotating)
    """
    user_oid = to_oid(user_id)
    user_match = [user_oid, str(user_oid)]

    # Step 1: find the user's work calendar assignment
    cal_emp = await db["work_calendar_employees"].find_one(
        {"user_id": {"$in": user_match}, "deleted_on": None}
    )
    logger.info(
        "Shift RPC: calendar employee lookup",
        user_id=user_id,
        found=cal_emp is not None,
        cal_emp_id=str(cal_emp.get("_id")) if cal_emp else None,
        work_calendar_id=str(cal_emp.get("work_calendar_id")) if cal_emp else None,
    )
    if not cal_emp:
        return None

    calendar_oid = to_oid(cal_emp["work_calendar_id"])

    # Step 2: fetch the calendar document
    calendar = await db["work_calendars"].find_one(
        {"_id": calendar_oid, "deleted_on": None}
    )
    logger.info(
        "Shift RPC: calendar lookup",
        user_id=user_id,
        calendar_oid=str(calendar_oid),
        found=calendar is not None,
        calendar_name=calendar.get("name") if calendar else None,
        has_weekend_matrix=bool(calendar.get("weekend_matrix")) if calendar else False,
    )

    # Step 3: find the shift assignment for this user in that calendar
    shift_assignment = await db["work_calendar_shift_assignments"].find_one(
        {"calendar_id": calendar_oid, "user_id": {"$in": user_match}, "deleted_on": None}
    )
    logger.info(
        "Shift RPC: shift assignment lookup",
        user_id=user_id,
        calendar_oid=str(calendar_oid),
        found=shift_assignment is not None,
        shift_id=str(shift_assignment.get("shift_id")) if shift_assignment else None,
    )

    weekend_matrix = calendar.get("weekend_matrix") if calendar else None
    week_config = calendar.get("week_config") if calendar else None

    if not shift_assignment:
        return {
            "calendar_id": str(calendar_oid),
            "calendar_name": calendar.get("name") if calendar else None,
            "week_config": week_config,
            "weekend_matrix": weekend_matrix,
            "shift_id": None,
            "shift_name": None,
            "start_time": None,
            "end_time": None,
            "break_minutes": None,
        }

    shift_id = shift_assignment["shift_id"]

    # Step 4: fetch the shift document
    shift = await db["work_calendar_shifts"].find_one(
        {"_id": shift_id, "deleted_on": None}
    )
    logger.info(
        "Shift RPC: shift document lookup",
        user_id=user_id,
        shift_id=str(shift_id),
        found=shift is not None,
        shift_name=shift.get("name") if shift else None,
    )

    return {
        "calendar_id": str(calendar_oid),
        "calendar_name": calendar.get("name") if calendar else None,
        "week_config": week_config,
        "weekend_matrix": weekend_matrix,
        "shift_id": str(shift_id),
        "shift_name": shift.get("name") if shift else None,
        "start_time": shift.get("start_time") if shift else None,
        "end_time": shift.get("end_time") if shift else None,
        "break_minutes": shift.get("break_minutes") if shift else None,
    }


async def _process_request(message: aio_pika.IncomingMessage) -> None:
    reply_to = message.reply_to
    correlation_id = message.correlation_id

    async with message.process(requeue=False):
        # Checked first: without a return address every path below is a no-op,
        # and there is no way to report the problem.
        if not reply_to:
            logger.warning("Shift details RPC: message has no reply_to, dropping")
            return

        try:
            body = json.loads(message.body)
        except json.JSONDecodeError as exc:
            logger.error("Shift details RPC: invalid JSON", error=repr(exc))
            await publish_reply(
                reply_to, correlation_id, None,
                error=f"invalid JSON: {exc}", log_name=_LOG_NAME,
            )
            return
        if not isinstance(body, dict):
            await publish_reply(
                reply_to, correlation_id, None,
                error="request payload must be an object", log_name=_LOG_NAME,
            )
            return

        employee_ids: list[str] = body.get("employee_ids", [])

        logger.info(
            "Shift details RPC: request received",
            correlation_id=correlation_id,
            reply_to=reply_to,
            employee_ids=employee_ids,
        )

        if not employee_ids:
            # Asked for nothing, so nothing is the correct answer — an empty
            # result, not an error, and certainly not silence.
            logger.warning("Shift details RPC: employee_ids missing or empty")
            await publish_reply(reply_to, correlation_id, {}, log_name=_LOG_NAME)
            return

        db = get_db()

        async def _fetch_one(employee_id: str) -> tuple[str, dict | None]:
            try:
                data = await _get_shift_details(db, employee_id)
            except Exception as exc:
                logger.error(
                    "Shift details RPC: error fetching shift for employee",
                    employee_id=employee_id,
                    error=repr(exc),
                )
                data = {"error": str(exc)}
            return employee_id, data

        try:
            pairs = await asyncio.gather(*[_fetch_one(eid) for eid in employee_ids])
        except Exception as exc:
            # _fetch_one already swallows per-employee errors, so reaching here
            # means something broader broke. Reply rather than leave the caller
            # waiting out its timeout on a request we will never answer.
            logger.error(
                "Shift details RPC: request failed",
                correlation_id=correlation_id, error=repr(exc),
            )
            await publish_reply(
                reply_to, correlation_id, None, error=repr(exc), log_name=_LOG_NAME,
            )
            return

        response_data = {eid: data for eid, data in pairs}

        logger.info(
            "Shift details RPC: response summary",
            correlation_id=correlation_id,
            results={eid: ("null" if d is None else "has_data") for eid, d in response_data.items()},
        )

        await publish_reply(reply_to, correlation_id, response_data, log_name=_LOG_NAME)
        logger.info(
            "Shift details RPC response sent",
            correlation_id=correlation_id,
            employee_count=len(response_data),
        )


async def _register() -> None:
    # Declared here as well as in rabbitmq_config: on a broker-down boot the
    # config pass is skipped entirely, and this retry is what brings the queue
    # back. Arguments must stay identical to declare_shift_details_rpc_
    # infrastructure() or the broker rejects the redeclare with 406.
    channel = await get_connection().channel()
    await channel.set_qos(prefetch_count=5)
    queue = await channel.declare_queue(
        Queues.SHIFT_DETAILS_RPC,
        durable=True,
        arguments={
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": Queues.DLQ,
        },
    )
    await queue.consume(_process_request)
    logger.info("Shift details RPC consumer started", queue=Queues.SHIFT_DETAILS_RPC)


async def start_shift_details_rpc_consumer() -> None:
    start_with_retry(_LOG_NAME, _register)
