from typing import Any

from src.email.providers.base import EmailProviderBase, SendResult
from src.email.providers.brevo import BrevoProvider
from src.email.providers.ses import SESProvider
from src.email.providers.smtp import SMTPProvider
from src.email.service import resolve_provider_template
from src.logger import logger
from src.tenant.credentials import credential_registry

_PROVIDERS: dict[str, EmailProviderBase] = {
    "brevo": BrevoProvider(),
    "ses": SESProvider(),
    "smtp": SMTPProvider(),
}


def get_provider(name: str) -> EmailProviderBase | None:
    return _PROVIDERS.get(name.lower())


async def send_with_fallback(
    tenant_id: str,
    primary_provider: str,
    fallback_chain: list[str],
    to: str,
    template_id: str,
    template_data: dict[str, Any],
    sender_email: str,
    sender_name: str,
    db: Any = None,
) -> SendResult:
    """Try primary provider, then each fallback in order. Returns the first successful result."""
    providers_to_try = [primary_provider] + [p for p in fallback_chain if p != primary_provider]
    errors: dict[str, str] = {}

    for provider_name in providers_to_try:
        provider = get_provider(provider_name)
        if not provider:
            errors[provider_name] = f"Unknown provider: {provider_name}"
            logger.warning("Unknown provider in fallback chain", provider=provider_name, tenant_id=tenant_id)
            continue

        creds = credential_registry.get(tenant_id, provider_name)
        if not creds:
            errors[provider_name] = "No credentials configured"
            logger.warning(
                "No credentials for provider, skipping",
                provider=provider_name,
                tenant_id=tenant_id,
            )
            continue

        provider_template_ref = None
        # `is not None`: db is a Motor Database, which raises NotImplementedError
        # on truth-value testing (`if db:`).
        if db is not None:
            try:
                provider_template_ref = await resolve_provider_template(
                    db, tenant_id, template_id, provider_name
                )
            except Exception:
                pass

        try:
            result = await provider.send(
                to=to,
                template_id=template_id,
                template_data=template_data,
                sender_email=sender_email,
                sender_name=sender_name,
                credentials=creds,
                provider_template_ref=provider_template_ref,
            )
            if result.success:
                if errors:
                    logger.warning(
                        "Email sent via fallback provider",
                        tenant_id=tenant_id,
                        primary=primary_provider,
                        used=provider_name,
                        prior_errors=errors,
                    )
                return result
            errors[provider_name] = result.error or "Send returned failure"
        except Exception as e:
            errors[provider_name] = str(e)
            logger.error(
                "Provider send exception",
                provider=provider_name,
                tenant_id=tenant_id,
                error=str(e),
            )

    return SendResult(
        success=False,
        provider=primary_provider,
        error=f"All providers failed: {errors}",
    )
