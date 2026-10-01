"""RPC server — does one user hold a given (module, permission)?

Queue: {ENVIRONMENT}.iam.rpc.permission_check.queue  (Direct Reply-To)

Consumed by the Expense service for the **collapse rule**: if a claimant's own
L1 already holds ``expense_l2_approval``, forwarding to management would ask the
same tier of authority twice, so the optional third gate is removed for that
record. That is a *permission* test, not an org-chart test — someone senior
without the grant is not management for this purpose, and someone mid-chart with
it is.

Where ``users_with_permission`` answers "who holds this?", this answers "does
*this* person hold it?" — a single-subject test that avoids pulling the whole
holder list just to check one id.

Request::

    {"employee_id": "<IAM user id>", "organisation_id": "<oid>",
     "module": "expense_management", "permission_code": "expense_l2_approval"}

Reply::

    {"correlation_id": "...", "data": true | false, "error": null}

Deny by default: an unknown user or a user with no matching policy is ``false``.
Org and super admins report ``true``, because they bypass permission checks in
the enforcing services too and the collapse rule must agree with what would
actually happen at the gate.
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.permission_check.queue"


async def _handle(payload: dict) -> bool:
    employee_id = payload.get("employee_id") or ""
    organisation_id = payload.get("organisation_id") or ""
    module = payload.get("module") or ""
    # Callers send `permission_code`; accept `permission` too so this queue
    # matches the vocabulary of users_with_permission.
    permission = payload.get("permission_code") or payload.get("permission") or ""
    if not employee_id or not module or not permission:
        raise ValueError("employee_id, module and permission_code are required")
    return await service.permission_check(
        employee_id, organisation_id, module, permission
    )


_server = RpcServer(_QUEUE_NAME, _handle, log_name="permission_check", prefetch=10)


def start_permission_check_rpc() -> None:
    _server.start()


async def stop_permission_check_rpc() -> None:
    await _server.stop()
