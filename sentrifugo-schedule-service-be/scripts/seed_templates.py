"""Seed template_mappings for all providers (brevo, ses, smtp).

Seeds the mapping between logical template_id and provider-specific references
for all three email templates: activation, password reset, email change.

Usage:
  python -m scripts.seed_templates

  Or with a custom tenant ID:
  SEED_TENANT_ID=your-uuid python -m scripts.seed_templates

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


SEED_TENANT_ID = os.environ.get("SEED_TENANT_ID", "00000000-0000-0000-0000-000000000001")

# ─── Template Mappings ─────────────────────────────────────────────────────
#
# Each entry maps a logical template_id to a provider-specific reference.
#
# Brevo:  numeric template ID from https://app.brevo.com/templates
# SES:    SES template name or ARN
# SMTP:   local HTML file name (matches src/email/templates/<name>.html)
#
# Update the Brevo/SES refs with your actual values before running.

TEMPLATE_MAPPINGS = [
    # ── activation_v1 ──
    {"template_id": "activation_v1", "provider": "brevo", "provider_template_ref": "1"},
    {"template_id": "activation_v1", "provider": "ses",   "provider_template_ref": "activation_v1"},
    {"template_id": "activation_v1", "provider": "smtp",  "provider_template_ref": "activation_v1"},

    # ── onboarding_invite_v1 ──
    {"template_id": "onboarding_invite_v1", "provider": "brevo", "provider_template_ref": "16"},
    {"template_id": "onboarding_invite_v1", "provider": "ses",   "provider_template_ref": "onboarding_invite_v1"},
    {"template_id": "onboarding_invite_v1", "provider": "smtp",  "provider_template_ref": "onboarding_invite_v1"},

    # ── password_reset_v1 ──
    {"template_id": "password_reset_v1", "provider": "brevo", "provider_template_ref": "2"},
    {"template_id": "password_reset_v1", "provider": "ses",   "provider_template_ref": "password_reset_v1"},
    {"template_id": "password_reset_v1", "provider": "smtp",  "provider_template_ref": "password_reset_v1"},

    # ── email_change_v1 ──
    {"template_id": "email_change_v1", "provider": "brevo", "provider_template_ref": "3"},
    {"template_id": "email_change_v1", "provider": "ses",   "provider_template_ref": "email_change_v1"},
    {"template_id": "email_change_v1", "provider": "smtp",  "provider_template_ref": "email_change_v1"},

    # ── SRM Templates ──
    {"template_id": "srm_request_submitted_v1", "provider": "brevo", "provider_template_ref": "4"},
    {"template_id": "srm_request_submitted_v1", "provider": "ses",   "provider_template_ref": "srm_request_submitted_v1"},
    {"template_id": "srm_request_submitted_v1", "provider": "smtp",  "provider_template_ref": "srm_request_submitted_v1"},

    {"template_id": "srm_approval_pending_v1", "provider": "brevo", "provider_template_ref": "5"},
    {"template_id": "srm_approval_pending_v1", "provider": "ses",   "provider_template_ref": "srm_approval_pending_v1"},
    {"template_id": "srm_approval_pending_v1", "provider": "smtp",  "provider_template_ref": "srm_approval_pending_v1"},

    {"template_id": "srm_request_approved_v1", "provider": "brevo", "provider_template_ref": "6"},
    {"template_id": "srm_request_approved_v1", "provider": "ses",   "provider_template_ref": "srm_request_approved_v1"},
    {"template_id": "srm_request_approved_v1", "provider": "smtp",  "provider_template_ref": "srm_request_approved_v1"},

    {"template_id": "srm_request_rejected_v1", "provider": "brevo", "provider_template_ref": "7"},
    {"template_id": "srm_request_rejected_v1", "provider": "ses",   "provider_template_ref": "srm_request_rejected_v1"},
    {"template_id": "srm_request_rejected_v1", "provider": "smtp",  "provider_template_ref": "srm_request_rejected_v1"},

    {"template_id": "srm_executor_assigned_v1", "provider": "brevo", "provider_template_ref": "8"},
    {"template_id": "srm_executor_assigned_v1", "provider": "ses",   "provider_template_ref": "srm_executor_assigned_v1"},
    {"template_id": "srm_executor_assigned_v1", "provider": "smtp",  "provider_template_ref": "srm_executor_assigned_v1"},

    {"template_id": "srm_executor_assigned_requester_v1", "provider": "brevo", "provider_template_ref": "9"},
    {"template_id": "srm_executor_assigned_requester_v1", "provider": "ses",   "provider_template_ref": "srm_executor_assigned_requester_v1"},
    {"template_id": "srm_executor_assigned_requester_v1", "provider": "smtp",  "provider_template_ref": "srm_executor_assigned_requester_v1"},

    {"template_id": "srm_request_escalated_v1", "provider": "brevo", "provider_template_ref": "10"},
    {"template_id": "srm_request_escalated_v1", "provider": "ses",   "provider_template_ref": "srm_request_escalated_v1"},
    {"template_id": "srm_request_escalated_v1", "provider": "smtp",  "provider_template_ref": "srm_request_escalated_v1"},

    {"template_id": "srm_request_escalated_requester_v1", "provider": "brevo", "provider_template_ref": "11"},
    {"template_id": "srm_request_escalated_requester_v1", "provider": "ses",   "provider_template_ref": "srm_request_escalated_requester_v1"},
    {"template_id": "srm_request_escalated_requester_v1", "provider": "smtp",  "provider_template_ref": "srm_request_escalated_requester_v1"},

    {"template_id": "srm_request_resolved_v1", "provider": "brevo", "provider_template_ref": "12"},
    {"template_id": "srm_request_resolved_v1", "provider": "ses",   "provider_template_ref": "srm_request_resolved_v1"},
    {"template_id": "srm_request_resolved_v1", "provider": "smtp",  "provider_template_ref": "srm_request_resolved_v1"},

    {"template_id": "srm_request_closed_v1", "provider": "brevo", "provider_template_ref": "13"},
    {"template_id": "srm_request_closed_v1", "provider": "ses",   "provider_template_ref": "srm_request_closed_v1"},
    {"template_id": "srm_request_closed_v1", "provider": "smtp",  "provider_template_ref": "srm_request_closed_v1"},

    {"template_id": "srm_comment_added_v1", "provider": "brevo", "provider_template_ref": "14"},
    {"template_id": "srm_comment_added_v1", "provider": "ses",   "provider_template_ref": "srm_comment_added_v1"},
    {"template_id": "srm_comment_added_v1", "provider": "smtp",  "provider_template_ref": "srm_comment_added_v1"},

    {"template_id": "srm_sla_breached_v1", "provider": "brevo", "provider_template_ref": "15"},
    {"template_id": "srm_sla_breached_v1", "provider": "ses",   "provider_template_ref": "srm_sla_breached_v1"},
    {"template_id": "srm_sla_breached_v1", "provider": "smtp",  "provider_template_ref": "srm_sla_breached_v1"},
]


async def seed():
    engine = create_async_engine(settings.DATABASE_URL, echo=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        for mapping in TEMPLATE_MAPPINGS:
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
                    "provider": mapping["provider"],
                    "provider_template_ref": mapping["provider_template_ref"],
                },
            )
            print(f"  [OK] {mapping['template_id']} → {mapping['provider']}:{mapping['provider_template_ref']}")

        await db.commit()

    await engine.dispose()

    print(f"\nTemplate seed complete. Tenant: {SEED_TENANT_ID}")
    print(f"\nTemplates seeded ({len(TEMPLATE_MAPPINGS)} mappings):")
    print(f"  activation_v1      → brevo:#1, ses:activation_v1, smtp:activation_v1")
    print(f"  password_reset_v1  → brevo:#2, ses:password_reset_v1, smtp:password_reset_v1")
    print(f"  email_change_v1    → brevo:#3, ses:email_change_v1, smtp:email_change_v1")
    print(f"\nUpdate Brevo template IDs in this script with your actual values from https://app.brevo.com/templates")


if __name__ == "__main__":
    asyncio.run(seed())
