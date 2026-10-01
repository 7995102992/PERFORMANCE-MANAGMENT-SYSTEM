from typing import Optional
from uuid import UUID

from src.models import CustomModel


class TenantEmailConfigResponse(CustomModel):
    tenant_id: UUID
    primary_provider: str
    fallback_chain: list[str] = []
    sender_email: str
    sender_name: str
    daily_rate_limit: int
    is_active: bool


class TenantCredentialStatus(CustomModel):
    tenant_id: str
    providers_with_credentials: list[str]
