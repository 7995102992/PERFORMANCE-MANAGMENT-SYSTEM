import jwt
from typing import Annotated

from fastapi import Depends, Request, status

from src.auth.config import auth_settings
from src.auth.schemas import UserBase
from src.auth.service import get_user_by_email
from src.auth.utils.oauth2 import ALGORITHM
from src.auth.utils.user_session import get_user_session, is_access_token_revoked
from src.correlation import set_current_user_id
from src.exceptions import DomainException
from src.logger import logger


def _extract_token(request: Request) -> str:
    """Extract Bearer token from Authorization header."""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise DomainException(
            message="Could not validate credentials",
            code="UNAUTHENTICATED",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    return auth_header[7:]


async def get_current_user(token: Annotated[str, Depends(_extract_token)]) -> UserBase:
    credentials_exception = DomainException(
        message="Could not validate credentials",
        code="UNAUTHENTICATED",
        status_code=status.HTTP_401_UNAUTHORIZED,
    )

    # Revocation check first (F-13): a logged-out / revoked token must fail on
    # BOTH the session-cache path and the stateless JWT cold path below.
    if await is_access_token_revoked(token):
        raise credentials_exception

    # Hot path: Valkey session cache (populated at login/refresh by create_user_session)
    session = await get_user_session(token)
    if session:
        set_current_user_id(session["user_id"])
        return UserBase(
            id=session["user_id"],
            email=session["email"],
            first_name=session.get("first_name"),
            last_name=session.get("last_name"),
            is_super_admin=session.get("is_super_admin", False),
            is_org_admin=session.get("is_org_admin", False),
            organisation_id=session.get("org_id") or None,
        )

    # Cold path: JWT decode + MongoDB (cache miss, Valkey restart, etc.)
    try:
        payload = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except jwt.PyJWTError as e:
        logger.warning("Invalid JWT", error=str(e))
        raise credentials_exception

    user = await get_user_by_email(email=email)
    if user is None:
        raise credentials_exception
    set_current_user_id(getattr(user, "id", None))
    return user
