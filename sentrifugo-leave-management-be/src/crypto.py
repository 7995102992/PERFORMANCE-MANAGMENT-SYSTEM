from functools import lru_cache
from typing import Optional, Union

from cryptography.fernet import Fernet, InvalidToken

from src.config import settings
from src.logger import logger


@lru_cache(maxsize=1)
def _fernet() -> Optional[Fernet]:
    if not settings.ENCRYPTION_KEY:
        return None
    return Fernet(settings.ENCRYPTION_KEY.encode())


def decrypt_amount(token: Optional[Union[str, int, float]]) -> Optional[float]:
    if token is None or token == "":
        return None
    if isinstance(token, (int, float)):
        return float(token)
    f = _fernet()
    if f is None:
        return None
    try:
        plain = f.decrypt(token.encode()).decode()
    except InvalidToken:
        logger.error("Failed to decrypt CTC value: InvalidToken")
        return None
    try:
        return float(plain)
    except (TypeError, ValueError):
        return None
