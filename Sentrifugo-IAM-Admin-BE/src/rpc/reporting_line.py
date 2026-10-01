"""RPC server — a manager's direct reports.

Queue: {ENVIRONMENT}.iam.rpc.reporting_line.queue  (Direct Reply-To)

Consumed by the Expense service to scope advance allocation: a manager may
allocate an advance only to someone who reports to them directly.

**Direct reports only — never the transitive sub-tree.** Allocation and Gate 1
are one edge deep. Flattening the branch here would silently let a manager
allocate money to someone two levels below them.

Request::

    {"manager_id": "<IAM user id>", "organisation_id": "<oid>"}

Reply::

    {"correlation_id": "...", "data": ["<user id>", ...], "error": null}

An empty list means no direct reports; a failure sets ``error`` with
``data: null`` rather than masquerading as "nobody reports to them".
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.reporting_line.queue"


async def _handle(payload: dict) -> list[str]:
    manager_id = payload.get("manager_id") or ""
    organisation_id = payload.get("organisation_id") or ""
    if not manager_id or not organisation_id:
        raise ValueError("manager_id and organisation_id are required")
    return await service.reporting_line(manager_id, organisation_id)


_server = RpcServer(_QUEUE_NAME, _handle, log_name="reporting_line", prefetch=10)


def start_reporting_line_rpc() -> None:
    _server.start()


async def stop_reporting_line_rpc() -> None:
    await _server.stop()
