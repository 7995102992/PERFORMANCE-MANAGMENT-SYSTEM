"""RPC server — the Expense service's live approver/forward picker.

Queue: {ENVIRONMENT}.iam.rpc.permission_holders.queue  (Direct Reply-To)

This is the queue the Expense service calls for its advance Approver 1 picker
and its L2-forward picker (see that service's ``src/directory/README.md`` §2).
It answers "who holds this permission?" — the same question as
``users_with_permission``, but on the queue and with the request/reply vocabulary
the Expense contract specifies:

Request::

    {"organisation_id": "<oid> | null", "module": "expense",
     "permission_code": "expense_manager_approval"}

``module`` is the Expense service's external name; it is normalised to the
canonical grant module code in :func:`src.internal.service.users_with_permission`.
``permission`` is accepted as an alias for ``permission_code`` so this queue and
``users_with_permission`` share one vocabulary.

Reply::

    {"correlation_id": "...",
     "data": [{"user_id": "...", "email": "...", "name": "..."}, ...],
     "error": null}

An empty list means nobody holds the grant; a failure sets ``error`` with
``data: null`` rather than masquerading as "nobody" — the caller must not read a
timeout as an empty picker, which would silently block every advance request.
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.permission_holders.queue"


async def _handle(payload: dict) -> list[dict]:
    module = payload.get("module") or ""
    # Callers send `permission_code`; accept `permission` too so this queue
    # matches the vocabulary of users_with_permission / permission_check.
    permission = payload.get("permission_code") or payload.get("permission") or ""
    if not module or not permission:
        raise ValueError("module and permission_code are required")
    return await service.users_with_permission(
        module, permission, payload.get("organisation_id")
    )


_server = RpcServer(_QUEUE_NAME, _handle, log_name="permission_holders", prefetch=5)


def start_permission_holders_rpc() -> None:
    _server.start()


async def stop_permission_holders_rpc() -> None:
    await _server.stop()
