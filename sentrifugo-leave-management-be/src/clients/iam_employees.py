"""IAM client: paginated employee hierarchy/status snapshot.

Used by the employee-sync cron to reconcile the local ``employees`` replica
when domain events were missed (consumer downtime, retry exhaustion, changes
made before this service existed). Calls IAM over RabbitMQ Direct Reply-To RPC
(``iam.rpc.employees_sync.queue``) — this used to be an unauthenticated HTTP
call to IAM's ``/internal/employees-sync``.

Returns ``None`` on failure (not ``[]``) so the caller can tell an IAM outage
apart from an empty page and abort the sweep instead of treating it as done.
"""
from typing import Optional

from src.clients.iam_rpc import IamUnavailable, rpc_call
from src.logger import logger

_QUEUE = "employees_sync"
# Generous: each page costs IAM three Mongo round trips (employees → users →
# master-data). The old HTTP client allowed 30s; keep parity.
_RPC_TIMEOUT_SECONDS = 30.0


async def fetch_employees_page(
    after_id: Optional[str] = None, limit: int = 200
) -> Optional[list[dict]]:
    """Return one cursor page of employee sync rows from IAM, or None on failure.

    ``None`` means "could not ask IAM" and MUST abort a sweep. ``[]`` means IAM
    authoritatively reported no further rows.
    """
    payload: dict = {"limit": limit}
    if after_id:
        payload["after_id"] = after_id

    try:
        data = await rpc_call(_QUEUE, payload, timeout=_RPC_TIMEOUT_SECONDS)
    except IamUnavailable as exc:
        # Covers transport failure, timeout, and IAM's own error envelope.
        logger.warning(
            "IAM employees-sync fetch failed",
            queue=_QUEUE,
            after_id=after_id,
            error=str(exc),
        )
        return None

    if not isinstance(data, list):
        logger.warning(
            "IAM employees-sync returned a non-list page",
            queue=_QUEUE,
            after_id=after_id,
            data_type=type(data).__name__,
        )
        return None
    return data
