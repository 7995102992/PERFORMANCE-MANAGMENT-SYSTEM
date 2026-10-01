"""RPC server — display profiles for a set of IAM user ids.

Queue: {ENVIRONMENT}.iam.rpc.employee_profiles.queue  (Direct Reply-To)

Consumed by the Expense service to render claimant, approver and forward-target
names onto records it has already authorised the caller to see.

Distinct from ``employee_lookup``, which keys on **emp_code** and returns
employment metadata. This one keys on **user_id** — the id the expense service
actually stores on its records — and returns only what a name chip needs.

Request::

    {"employee_ids": ["<IAM user id>", ...], "organisation_id": "<oid>"}

Reply::

    {"correlation_id": "...",
     "data": {"<user id>": {"user_id", "name", "role", "email"}, ...},
     "error": null}

Ids that are unknown, soft-deleted or outside the organisation are simply absent
from the map — the caller treats a miss as "render the id" rather than failing.
Scoping matters: this is a directory read, and an unscoped reply would leak
names across tenants.
"""
from src.config import settings
from src.internal import service
from src.rpc.server import RpcServer

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.employee_profiles.queue"


async def _handle(payload: dict) -> dict:
    employee_ids = payload.get("employee_ids") or []
    organisation_id = payload.get("organisation_id") or ""
    if not isinstance(employee_ids, list):
        raise ValueError("employee_ids must be a list")
    if not organisation_id:
        raise ValueError("organisation_id is required")
    if not employee_ids:
        return {}
    return await service.employee_profiles(employee_ids, organisation_id)


_server = RpcServer(_QUEUE_NAME, _handle, log_name="employee_profiles", prefetch=10)


def start_employee_profiles_rpc() -> None:
    _server.start()


async def stop_employee_profiles_rpc() -> None:
    await _server.stop()
