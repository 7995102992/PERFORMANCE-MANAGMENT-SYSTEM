"""RPC server — cursor-paginated employee snapshot for replica reconciliation.

Queue: {ENVIRONMENT}.iam.rpc.employees_sync.queue  (Direct Reply-To)

Replaces the unauthenticated ``GET /internal/employees-sync`` HTTP route: same
query, same rows, but off the public gateway.

Request::

    {"after_id": "<oid> | null", "limit": 200, "organisation_id": "<oid> | null"}

Reply::

    {"correlation_id": "...", "data": [ {...employee row...}, ... ], "error": null}

``data`` is a page of rows sorted by ``_id`` ascending; the caller advances by
passing the last row's ``employee_id`` back as ``after_id``. An empty list means
end-of-collection — a failure is reported via ``error`` with ``data: null``, so a
sweeping caller can tell "done" from "broken" and abort instead of stopping short.
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.employees_sync.queue"


async def _handle(payload: dict) -> list[dict]:
    return await service.employees_sync(
        after_id=payload.get("after_id"),
        limit=payload.get("limit") or service.DEFAULT_SYNC_LIMIT,
        organisation_id=payload.get("organisation_id"),
    )


_server = RpcServer(_QUEUE_NAME, _handle, log_name="employees_sync")


def start_employees_sync_rpc() -> None:
    _server.start()


async def stop_employees_sync_rpc() -> None:
    await _server.stop()
