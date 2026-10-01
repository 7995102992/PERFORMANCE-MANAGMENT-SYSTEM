"""Request correlation ID — generated once per inbound request and propagated
through logs, outbox events, and RabbitMQ message headers."""

from contextvars import ContextVar
from datetime import UTC, datetime
from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

HEADER_NAME = "X-Correlation-ID"

correlation_id_ctx: ContextVar[str] = ContextVar("correlation_id", default="")

# Acting user for the current request — set in get_current_user, read by the
# tools layer for audit stamping (created_by / modified_by / deleted_by).
current_user_id_ctx: ContextVar[str] = ContextVar("current_user_id", default="")


def get_correlation_id() -> str:
    return correlation_id_ctx.get()


def set_current_user_id(user_id: str | None) -> None:
    current_user_id_ctx.set(str(user_id) if user_id else "")


def get_actor_id() -> str:
    """The acting user's id for audit fields; falls back to 'system' when there
    is no user context (background tasks, relay, seeds)."""
    return current_user_id_ctx.get() or "system"


def audit_create() -> dict:
    """Audit kwargs for a newly created document: created_by + created_on."""
    return {"created_by": get_actor_id(), "created_on": datetime.now(UTC)}


def stamp_modified(doc) -> None:
    """Stamp modified_by + modified_on on an existing document before save."""
    doc.modified_by = get_actor_id()
    doc.modified_on = datetime.now(UTC)


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        cid = request.headers.get(HEADER_NAME) or str(uuid4())
        token = correlation_id_ctx.set(cid)
        try:
            response = await call_next(request)
            response.headers[HEADER_NAME] = cid
            return response
        finally:
            correlation_id_ctx.reset(token)
