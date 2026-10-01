from typing import Any

from src.email.providers.base import EmailProviderBase, SendResult
from src.logger import logger


class SESProvider(EmailProviderBase):
    name = "ses"

    async def send(
        self,
        to: str,
        template_id: str,
        template_data: dict[str, Any],
        sender_email: str,
        sender_name: str,
        credentials: dict[str, str],
        provider_template_ref: str | None = None,
    ) -> SendResult:
        access_key = credentials.get("ACCESS_KEY")
        secret_key = credentials.get("SECRET_KEY")
        if not access_key or not secret_key:
            return SendResult(success=False, provider=self.name, error="Missing ACCESS_KEY or SECRET_KEY")

        # NOT IMPLEMENTED. Fail explicitly so the fallback chain proceeds to the
        # next provider — previously this returned success WITHOUT sending, which
        # silently black-holed every email that failed over to SES.
        # TODO: replace with an actual AWS SES send call.
        logger.warning("SES provider not implemented; reporting failure so failover proceeds", to=to, template_id=template_id)
        return SendResult(success=False, provider=self.name, error="SES provider not implemented")

    async def health_check(self, credentials: dict[str, str]) -> bool:
        # Not implemented — report unhealthy so it isn't preferred/relied upon.
        return False
