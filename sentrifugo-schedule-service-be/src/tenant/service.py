from motor.motor_asyncio import AsyncIOMotorDatabase

from src.logger import logger
from src.tenant.config import tenant_settings
from src.tenant.credentials import credential_registry


class TenantEmailConfigDoc:
    """Lightweight wrapper around a MongoDB document to match attribute access."""
    def __init__(self, doc: dict):
        self.tenant_id = doc.get("tenant_id")
        self.primary_provider = doc.get("primary_provider")
        self.fallback_chain = doc.get("fallback_chain", [])
        self.sender_email = doc.get("sender_email")
        self.sender_name = doc.get("sender_name", "")
        self.daily_rate_limit = doc.get("daily_rate_limit", 1000)
        self.is_active = doc.get("is_active", True)


async def get_tenant_config(db: AsyncIOMotorDatabase, tenant_id: str) -> TenantEmailConfigDoc | None:
    doc = await db.tenant_email_config.find_one({"tenant_id": tenant_id})
    if not doc:
        return None
    return TenantEmailConfigDoc(doc)


def get_tenant_credentials(tenant_id: str, provider: str) -> dict[str, str] | None:
    return credential_registry.get(tenant_id, provider)


def resolve_provider_for_tenant(config: TenantEmailConfigDoc | None) -> str:
    if config and config.primary_provider:
        return config.primary_provider
    return tenant_settings.DEFAULT_EMAIL_PROVIDER


def resolve_fallback_chain(config: TenantEmailConfigDoc | None) -> list[str]:
    if config and config.fallback_chain:
        return config.fallback_chain
    return [p.strip() for p in tenant_settings.DEFAULT_FALLBACK_CHAIN.split(",") if p.strip()]
