"""X-Internal-Token guard for Schedule-Service-invoked endpoints.

Per Foundation §14, internal job endpoints are gated by a shared-secret
header, not user JWTs.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import Header

from ..config import settings
from ..exceptions import InvalidInternalToken


async def require_internal_token(
    x_internal_token: Annotated[str | None, Header(alias="X-Internal-Token")] = None,
) -> None:
    expected = settings.INTERNAL_TOKEN
    if not expected:
        # Never default to a hardcoded token — see Q-004.
        from ..exceptions import DomainException
        raise DomainException(
            "INTERNAL_TOKEN is not configured on this server",
            "INTERNAL_TOKEN_NOT_CONFIGURED",
            503,
        )
    if not x_internal_token or x_internal_token != expected:
        raise InvalidInternalToken()
