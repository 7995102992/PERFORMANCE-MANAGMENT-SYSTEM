"""Internal service-to-service endpoints.

Consumed by other backend services / cron jobs (e.g. Schedule Service), not by
end-user clients. Authenticated with the ``INTERNAL_API_KEY`` shared secret via
the ``X-Internal-Token`` header rather than a user session.
"""

from fastapi import APIRouter, Depends, Header

from src.config import settings
from src.exceptions import InvalidInternalToken

router = APIRouter(prefix="/internal", tags=["internal"])


async def verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Reject the request unless the caller presents the shared internal secret.

    Args:
        x_internal_token: Value of the ``X-Internal-Token`` request header.

    Raises:
        DomainException: ``InvalidInternalToken`` when the header is missing,
            mismatched, or when no ``INTERNAL_API_KEY`` is configured.
    """
    if not settings.INTERNAL_API_KEY or x_internal_token != settings.INTERNAL_API_KEY:
        raise InvalidInternalToken()


@router.get("/ping", dependencies=[Depends(verify_internal_token)])
async def internal_ping() -> dict:
    """Authenticated reachability probe for sibling services."""
    return {"status": "ok", "service": "expense"}
