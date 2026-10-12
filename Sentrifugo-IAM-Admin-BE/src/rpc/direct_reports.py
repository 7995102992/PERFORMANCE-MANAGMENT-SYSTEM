"""RPC server — a manager's direct reports, with the fields PMS needs for a team roster.

Queue: {ENVIRONMENT}.iam.rpc.direct_reports.queue  (Direct Reply-To)

Consumed by the Performance Management service to list a manager's team and to
resolve each report's designation-specific goal template. Replaces the
authenticated ``GET /employees/?l1_manager_id=`` HTTP call PMS used to make on
the caller's forwarded token.

Deliberately a separate queue from ``reporting_line``, which already serves
Expense's advance-allocation scoping with a bare-user-id reply: that contract
is load-bearing for Expense and must not grow fields only PMS needs.

Request::

    {"manager_id": "<IAM user id>", "organisation_id": "<oid>"}

Reply::

    {"correlation_id": "...",
     "data": [{"user_id", "emp_code", "first_name", "last_name", "work_email",
               "department_id", "designation_id", "designation_name"}, ...],
     "error": null}

Direct reports only, never the transitive sub-tree. An empty list means no
direct reports; a failure sets ``error`` with ``data: null`` rather than
masquerading as "this manager has no team".
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.direct_reports.queue"


async def _handle(payload: dict) -> list[dict]:
    manager_id = payload.get("manager_id") or ""
    organisation_id = payload.get("organisation_id") or ""
    if not manager_id or not organisation_id:
        raise ValueError("manager_id and organisation_id are required")
    return await service.direct_reports(manager_id, organisation_id)


_server = RpcServer(_QUEUE_NAME, _handle, log_name="direct_reports", prefetch=10)


def start_direct_reports_rpc() -> None:
    _server.start()


async def stop_direct_reports_rpc() -> None:
    await _server.stop()
