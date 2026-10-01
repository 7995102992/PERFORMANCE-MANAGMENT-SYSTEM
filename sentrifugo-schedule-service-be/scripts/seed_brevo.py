"""Seed script for Brevo email integration.

Seeds:
  1. tenant_email_config — per-tenant provider config (brevo as primary)
  2. template_mappings   — logical template_id → Brevo numeric template ID

Usage:
  python -m scripts.seed_brevo

  Or with a custom tenant ID:
  SEED_TENANT_ID=your-uuid python -m scripts.seed_brevo

Prerequisites:
  - PostgreSQL running with DATABASE_URL configured in .env
  - Tables auto-created (run the app once, or run this script — it creates tables too)

Re-running is safe: uses INSERT ... ON CONFLICT DO UPDATE (upsert).
"""

import asyncio
import os
import sys

from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from src.config import settings
from src.email.models import Base


# ─── Configuration ──────────────────────────────────────────────────────────

SEED_TENANT_ID = os.environ.get("SEED_TENANT_ID", "00000000-0000-0000-0000-000000000001")

TENANT_CONFIG = {
    "tenant_id": SEED_TENANT_ID,
    "primary_provider": "brevo",
    "fallback_chain": ["ses", "smtp"],
    "sender_email": os.environ.get("SEED_SENDER_EMAIL", "noreply@yourdomain.com"),
    "sender_name": os.environ.get("SEED_SENDER_NAME", "Your App"),
    "daily_rate_limit": 1000,
    "is_active": True,
}

# Map logical template_id → Brevo numeric template ID
# Update these with your actual Brevo template IDs from https://app.brevo.com/templates
BREVO_TEMPLATE_MAPPINGS = [
    {"template_id": "activation_v1", "provider_template_ref": "1"},
    {"template_id": "password_reset_v1", "provider_template_ref": "2"},
    {"template_id": "email_change_v1", "provider_template_ref": "3"},
    {"template_id": "welcome_v1", "provider_template_ref": "4"},
    {"template_id": "invite_v1", "provider_template_ref": "5"},
    {"template_id": "exit_request_raised_v1", "provider_template_ref": "6"},
    {"template_id": "exit_manager_approved_v1", "provider_template_ref": "7"},
    {"template_id": "exit_manager_rejected_v1", "provider_template_ref": "8"},
    {"template_id": "exit_clearances_initiated_v1", "provider_template_ref": "9"},
    {"template_id": "exit_clearances_assigned_v1", "provider_template_ref": "10"},
    {"template_id": "exit_completed_v1", "provider_template_ref": "11"},
    {"template_id": "leave_request_submitted_v1", "provider_template_ref": "12"},
    {"template_id": "leave_approval_pending_v1", "provider_template_ref": "13"},
    {"template_id": "leave_request_approved_v1", "provider_template_ref": "14"},
    {"template_id": "leave_request_rejected_v1", "provider_template_ref": "15"},
    {"template_id": "leave_request_cancelled_v1", "provider_template_ref": "16"},
    {"template_id": "onboarding_invite_v1", "provider_template_ref": "17"},
]


# ─── Seed Logic ─────────────────────────────────────────────────────────────

async def seed():
    engine = create_async_engine(settings.DATABASE_URL, echo=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        # Upsert tenant_email_config
        await db.execute(
            text("""
                INSERT INTO tenant_email_config (id, tenant_id, primary_provider, fallback_chain, sender_email, sender_name, daily_rate_limit, is_active, created_at)
                VALUES (gen_random_uuid(), :tenant_id, :primary_provider, :fallback_chain::jsonb, :sender_email, :sender_name, :daily_rate_limit, :is_active, NOW())
                ON CONFLICT (tenant_id) DO UPDATE SET
                    primary_provider = EXCLUDED.primary_provider,
                    fallback_chain = EXCLUDED.fallback_chain,
                    sender_email = EXCLUDED.sender_email,
                    sender_name = EXCLUDED.sender_name,
                    daily_rate_limit = EXCLUDED.daily_rate_limit,
                    is_active = EXCLUDED.is_active,
                    updated_at = NOW()
            """),
            {
                "tenant_id": TENANT_CONFIG["tenant_id"],
                "primary_provider": TENANT_CONFIG["primary_provider"],
                "fallback_chain": '["ses", "smtp"]',
                "sender_email": TENANT_CONFIG["sender_email"],
                "sender_name": TENANT_CONFIG["sender_name"],
                "daily_rate_limit": TENANT_CONFIG["daily_rate_limit"],
                "is_active": TENANT_CONFIG["is_active"],
            },
        )
        print(f"[OK] tenant_email_config seeded for tenant {SEED_TENANT_ID}")

        # Upsert template_mappings
        for mapping in BREVO_TEMPLATE_MAPPINGS:
            await db.execute(
                text("""
                    INSERT INTO template_mappings (id, tenant_id, template_id, provider, provider_template_ref, is_active)
                    VALUES (gen_random_uuid(), :tenant_id, :template_id, :provider, :provider_template_ref, true)
                    ON CONFLICT (tenant_id, template_id, provider) DO UPDATE SET
                        provider_template_ref = EXCLUDED.provider_template_ref,
                        is_active = true
                """),
                {
                    "tenant_id": SEED_TENANT_ID,
                    "template_id": mapping["template_id"],
                    "provider": "brevo",
                    "provider_template_ref": mapping["provider_template_ref"],
                },
            )
            print(f"  [OK] template_mappings: {mapping['template_id']} → brevo template #{mapping['provider_template_ref']}")

        await db.commit()

    await engine.dispose()
    print(f"\nSeed complete. Tenant: {SEED_TENANT_ID}")
    print(f"Remember to set TENANT__{SEED_TENANT_ID.replace('-', '')}__BREVO__API_KEY in your .env")


if __name__ == "__main__":
    asyncio.run(seed())
