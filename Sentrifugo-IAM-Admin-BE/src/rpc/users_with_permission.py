"""RPC server — users holding a given (module, permission) grant.

Queue: {ENVIRONMENT}.iam.rpc.users_with_permission.queue  (Direct Reply-To)

Replaces the unauthenticated ``GET /internal/users-with-permission`` HTTP route.
Used by Leave Management's escalation sweep to find the HR users to notify when
a leave request passes its approval SLA.

Request::

    {"module": "leave_management", "permission": "approve_as_hr",
     "organisation_id": "<oid> | null"}

Reply::

    {"correlation_id": "...",
     "data": [{"user_id": "...", "email": "...", "name": "..."}, ...],
     "error": null}

An empty list means nobody holds the grant; a failure sets ``error`` with
``data: null`` rather than masquerading as "nobody".
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.users_with_permission.queue"


async def _handle(payload: dict) -> list[dict]:
    module = payload.get("module") or ""
    permission = payload.get("permission") or ""
    if not module or not permission:
        raise ValueError("module and permission are required")
    return await service.users_with_permission(
        module, permission, payload.get("organisation_id")
    )


_server = RpcServer(_QUEUE_NAME, _handle, log_name="users_with_permission", prefetch=5)


def start_users_with_permission_rpc() -> None:
    _server.start()


async def stop_users_with_permission_rpc() -> None:
    await _server.stop()
