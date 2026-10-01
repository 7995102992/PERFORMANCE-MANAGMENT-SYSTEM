from fastapi import Request, status
from fastapi.responses import JSONResponse

from src.logger import logger


class DomainException(Exception):
    def __init__(self, message: str, code: str = "INTERNAL_ERROR", status_code: int = status.HTTP_400_BAD_REQUEST):
        self.message = message
        self.code = code
        self.status_code = status_code

async def domain_exception_handler(request: Request, exc: DomainException):
    logger.warning("Domain error exception", path=request.url.path, error_code=exc.code, error=exc.message)
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "code": exc.code}
    )

async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled server exception", path=request.url.path, error=str(exc))
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An unexpected error occurred.", "code": "INTERNAL_SERVER_ERROR"}
    )
