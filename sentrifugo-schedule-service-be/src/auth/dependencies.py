import jwt
from typing import Annotated
from fastapi import Depends, status
from fastapi.security import OAuth2PasswordBearer

from src.auth.config import auth_settings
from src.auth.schemas import UserBase
from src.auth.service import get_user
from src.auth.utils import ALGORITHM
from src.exceptions import DomainException
from src.logger import logger

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

async def get_current_user(token: Annotated[str, Depends(oauth2_scheme)]) -> UserBase:
    credentials_exception = DomainException(
        message="Could not validate credentials",
        code="UNAUTHENTICATED",
        status_code=status.HTTP_401_UNAUTHORIZED,
    )
    try:
        payload = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except jwt.PyJWTError as e:
        logger.warning("Invalid JWT", error=str(e))
        raise credentials_exception
        
    user = await get_user(username=username)
    if user is None:
        raise credentials_exception
    return user
