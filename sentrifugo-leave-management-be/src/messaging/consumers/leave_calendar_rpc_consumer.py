import asyncio
import json

import aio_pika

from src.database import get_db
from src.logger import logger
from src.messaging.constants.queues import Queues
from src.messaging.consumers.rpc_support import publish_reply, start_with_retry
from src.my_calendar.service import get_employee_calendar
from src.rabbitmq import get_connection
from src.utils import to_oid

_LOG_NAME = "Leave calendar RPC"


async def _resolve_org_id(db, user_id: str) -> str:
    emp = await db["employees"].find_one(
        {"user_id": to_oid(user_id)},
        {"organisation_id": 1},
    )
    if not emp:
        return ""
    return str(emp.get("organisation_id", ""))


async def _process_request(message: aio_pika.IncomingMessage) -> None:
    reply_to = message.reply_to
    correlation_id = message.correlation_id

    async with message.process(requeue=False):
        # Checked first: without a return address every path below is a no-op,
        # and there is no way to report the problem.
        if not reply_to:
            logger.warning("Leave calendar RPC: message has no reply_to, dropping")
            return

        try:
            body = json.loads(message.body)
        except json.JSONDecodeError as exc:
            logger.error("Leave calendar RPC: invalid JSON", error=repr(exc))
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
        from_date_str: str = body.get("from_date", "")
        to_date_str: str = body.get("to_date", "")

        if not from_date_str or not to_date_str:
            logger.warning(
                "Leave calendar RPC: missing required fields",
                from_date=from_date_str,
                to_date=to_date_str,
            )
            await publish_reply(
                reply_to, correlation_id, None,
                error="from_date and to_date are required", log_name=_LOG_NAME,
            )
            return

        if not employee_ids:
            # Asked for nothing, so nothing is the correct answer.
            await publish_reply(reply_to, correlation_id, {}, log_name=_LOG_NAME)
            return

        db = get_db()

        async def _fetch_one(employee_id: str) -> tuple[str, dict]:
            try:
                org_id = await _resolve_org_id(db, employee_id)
                data = await get_employee_calendar(db, employee_id, org_id, from_date_str, to_date_str)
            except Exception as exc:
                logger.error(
                    "Leave calendar RPC: error fetching data for employee",
                    employee_id=employee_id,
                    error=repr(exc),
                )
                data = {"leaves": [], "holidays": [], "error": str(exc)}
            return employee_id, data

        try:
            pairs = await asyncio.gather(*[_fetch_one(eid) for eid in employee_ids])
        except Exception as exc:
            # _fetch_one already swallows per-employee errors, so reaching here
            # means something broader broke. The timesheet client for this queue
            # passes NO timeout, so failing to reply parks it permanently.
            logger.error(
                "Leave calendar RPC: request failed",
                correlation_id=correlation_id, error=repr(exc),
            )
            await publish_reply(
                reply_to, correlation_id, None, error=repr(exc), log_name=_LOG_NAME,
            )
            return

        response_data = {eid: data for eid, data in pairs}

        await publish_reply(reply_to, correlation_id, response_data, log_name=_LOG_NAME)
        logger.info(
            "Leave calendar RPC response sent",
            correlation_id=correlation_id,
            employee_count=len(response_data),
        )


async def _register() -> None:
    # Declared here as well as in rabbitmq_config: on a broker-down boot the
    # config pass is skipped entirely, and this retry is what brings the queue
    # back. Arguments must stay identical to declare_leave_calendar_rpc_
    # infrastructure() or the broker rejects the redeclare with 406.
    channel = await get_connection().channel()
    await channel.set_qos(prefetch_count=5)
    queue = await channel.declare_queue(
        Queues.LEAVE_CALENDAR_RPC,
        durable=True,
        arguments={
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": Queues.DLQ,
        },
    )
    await queue.consume(_process_request)
    logger.info("Leave calendar RPC consumer started", queue=Queues.LEAVE_CALENDAR_RPC)


async def start_leave_calendar_rpc_consumer() -> None:
    start_with_retry(_LOG_NAME, _register)
