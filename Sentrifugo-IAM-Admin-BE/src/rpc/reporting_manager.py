"""RPC server — an employee's L1 reporting manager.

Queue: {ENVIRONMENT}.iam.rpc.reporting_manager.queue  (Direct Reply-To)

Consumed by the Expense service to open Gate 1. L1 approval is unconditional
there: a record with no resolvable manager is refused at submit rather than
allowed to skip the first substantive check, so a wrong answer here is worse
than no answer.

Request::

    {"employee_id": "<IAM user id>", "organisation_id": "<oid>"}

Reply::

    {"correlation_id": "...",
     "data": {"user_id": "...", "name": "...", "role": "...", "email": "..."} | null,
     "error": null}

``data: null`` means the employee is at the top of the reporting line, or is
unknown / outside the organisation. A failure sets ``error`` with ``data: null``
instead — the caller must be able to tell "no manager" from "IAM broke".
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.reporting_manager.queue"


async def _handle(payload: dict) -> dict | None:
    employee_id = payload.get("employee_id") or ""
    organisation_id = payload.get("organisation_id") or ""
    if not employee_id or not organisation_id:
        raise ValueError("employee_id and organisation_id are required")
    return await service.reporting_manager(employee_id, organisation_id)


_server = RpcServer(_QUEUE_NAME, _handle, log_name="reporting_manager", prefetch=10)


def start_reporting_manager_rpc() -> None:
    _server.start()


async def stop_reporting_manager_rpc() -> None:
    await _server.stop()
