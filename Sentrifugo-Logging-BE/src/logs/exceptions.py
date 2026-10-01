from fastapi import status

from src.exceptions import DomainException


class InvalidApiKey(DomainException):
    def __init__(self):
        super().__init__(
            message="Invalid or missing API key",
            code="INVALID_API_KEY",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )


class InsufficientAccessLevel(DomainException):
    def __init__(self):
        super().__init__(
            message="Insufficient access level for the requested debug level",
            code="INSUFFICIENT_ACCESS_LEVEL",
            status_code=status.HTTP_403_FORBIDDEN,
        )


class InvalidLogPayload(DomainException):
    def __init__(self, detail: str = "Invalid log payload"):
        super().__init__(
            message=detail,
            code="INVALID_LOG_PAYLOAD",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
