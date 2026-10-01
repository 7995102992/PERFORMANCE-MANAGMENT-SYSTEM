import json

from fastapi import Header
from pydantic import BaseModel

from src.logs.config import logs_settings
from src.logs.constants import DebugLevel
from src.logs.exceptions import InvalidApiKey


class ApiKeyInfo(BaseModel):
    debug_level: DebugLevel


def validate_api_key(x_api_key: str = Header(...)) -> ApiKeyInfo:
    keys: dict = json.loads(logs_settings.VALID_API_KEYS)
    if x_api_key not in keys:
        raise InvalidApiKey()
    level_name = keys[x_api_key]
    try:
        level = DebugLevel[level_name]
    except KeyError:
        raise InvalidApiKey()
    return ApiKeyInfo(debug_level=level)
