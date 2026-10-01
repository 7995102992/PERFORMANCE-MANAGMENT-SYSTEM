"""IAM client: resolve users who hold a given permission.

Used by the escalation cron to find HR users (holders of the dedicated
``leave_management:approve_as_hr`` permission) for an organisation, so it can
notify them when a leave request has gone past its approval SLA. Calls IAM over
RabbitMQ Direct Reply-To RPC (``iam.rpc.users_with_permission.queue``) — this
used to be an unauthenticated HTTP call to IAM's ``/internal/users-with-permission``.

On failure returns an empty list so the cron degrades quietly: a missed
escalation email is re-sent on the next sweep, since requests are only stamped
``escalation_notified_on`` once an email actually goes out.
"""
from typing import Optional

from src.clients.iam_rpc import IamUnavailable, rpc_call
from src.logger import logger

_HR_MODULE = "leave_management"
_HR_PERMISSION = "approve_as_hr"

_QUEUE = "users_with_permission"
_RPC_TIMEOUT_SECONDS = 10.0


async def fetch_hr_users(organisation_id: Optional[str]) -> list[dict]:
    """Return [{user_id, email, name}, ...] of HR-permission holders in an org.

    Returns [] when org is missing, IAM is unreachable, or nobody holds it.
    """
    if not organisation_id:
        return []

    try:
        data = await rpc_call(
            _QUEUE,
            {
                "module": _HR_MODULE,
                "permission": _HR_PERMISSION,
                "organisation_id": organisation_id,
            },
            timeout=_RPC_TIMEOUT_SECONDS,
        )
    except IamUnavailable as exc:
        logger.warning(
            "IAM HR-users fetch failed",
            queue=_QUEUE,
            organisation_id=organisation_id,
            error=str(exc),
        )
        return []

    if not isinstance(data, list):
        return []
    return [u for u in data if isinstance(u, dict) and u.get("email")]
