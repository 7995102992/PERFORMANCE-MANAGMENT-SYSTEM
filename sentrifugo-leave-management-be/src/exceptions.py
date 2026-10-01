from bson.errors import InvalidId
from fastapi import Request, status
from fastapi.responses import JSONResponse

from src.logger import logger

class DomainException(Exception):
    def __init__(self, message: str, code: str = "INTERNAL_ERROR", status_code: int = status.HTTP_400_BAD_REQUEST, detail: dict | None = None):
        self.message = message
        self.code = code
        self.status_code = status_code
        self.detail = detail

async def domain_exception_handler(request: Request, exc: DomainException):
    logger.warning("Domain error exception", path=request.url.path, error_code=exc.code, error=exc.message)
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail if exc.detail else exc.message, "code": exc.code}
    )

async def invalid_id_exception_handler(request: Request, exc: InvalidId):
    logger.warning("Invalid ObjectId in request", path=request.url.path, error=str(exc))
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"detail": "Invalid ID format.", "code": "INVALID_ID"}
    )

async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled server exception", path=request.url.path, error=str(exc))
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An unexpected error occurred.", "code": "INTERNAL_SERVER_ERROR"}
    )
