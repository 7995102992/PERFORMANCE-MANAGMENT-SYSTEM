"""Domain exception + FastAPI handlers.

All domain errors serialise to ``{"detail": str, "code": str, "correlation_id": str}``.
Frontends key on ``code``. Add expense-specific error helpers below as modules
are built (mirrors the SRM pre-declared-codes convention).
"""

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from src.correlation import get_correlation_id
from src.logger import logger


class DomainException(Exception):
    def __init__(
        self,
        message: str,
        code: str = "INTERNAL_ERROR",
        status_code: int = status.HTTP_400_BAD_REQUEST,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code


# ---------- Common pre-declared helpers ----------


def BadRequest(msg: str = "Bad request") -> DomainException:
    return DomainException(msg, "BAD_REQUEST", status.HTTP_400_BAD_REQUEST)


def Unauthorized(msg: str = "Unauthorized") -> DomainException:
    return DomainException(msg, "UNAUTHORIZED", status.HTTP_401_UNAUTHORIZED)


def Forbidden(msg: str = "Forbidden") -> DomainException:
    return DomainException(msg, "FORBIDDEN", status.HTTP_403_FORBIDDEN)


def NotFound(msg: str = "Resource not found") -> DomainException:
    return DomainException(msg, "NOT_FOUND", status.HTTP_404_NOT_FOUND)


def Conflict(msg: str = "Resource conflict") -> DomainException:
    return DomainException(msg, "CONFLICT", status.HTTP_409_CONFLICT)


def InvalidInternalToken() -> DomainException:
    return DomainException(
        "Invalid or missing internal API key",
        "INVALID_INTERNAL_TOKEN",
        status.HTTP_401_UNAUTHORIZED,
    )


# ---------- Handlers ----------


async def domain_exception_handler(request: Request, exc: DomainException) -> JSONResponse:
    logger.warning(
        "Domain error",
        path=request.url.path,
        error_code=exc.code,
        error=exc.message,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.message,
            "code": exc.code,
            "correlation_id": get_correlation_id(),
        },
    )


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    detail_msgs = [f"{'.'.join(str(p) for p in err['loc'] if p != 'body')}: {err['msg']}" for err in exc.errors()]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "; ".join(detail_msgs) if detail_msgs else "Validation error",
            "code": "VALIDATION_ERROR",
            "correlation_id": get_correlation_id(),
        },
    )


async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("Unhandled server exception", path=request.url.path, error=str(exc))
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": "An unexpected error occurred.",
            "code": "INTERNAL_SERVER_ERROR",
            "correlation_id": get_correlation_id(),
        },
    )


def register_exception_handlers(app) -> None:
    app.add_exception_handler(DomainException, domain_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, global_exception_handler)
