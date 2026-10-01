from typing import Any

import httpx

from src.email.providers.base import EmailProviderBase, SendResult
from src.email.templates.renderer import get_subject, render_template
from src.logger import logger

BASE_URL = "https://api.brevo.com/v3"


class BrevoProvider(EmailProviderBase):
    name = "brevo"

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
        api_key = credentials.get("API_KEY")
        if not api_key:
            return SendResult(success=False, provider=self.name, error="Missing API_KEY in credentials")

        if provider_template_ref:
            # Brevo templateId must be an integer; the mapping column is a free-form
            # string, so guard the parse and fail cleanly (lets fallback proceed)
            # instead of raising a confusing "invalid literal for int()".
            try:
                template_id_int = int(provider_template_ref)
            except (TypeError, ValueError):
                return SendResult(
                    success=False,
                    provider=self.name,
                    error=f"Invalid Brevo templateId (not an integer): {provider_template_ref!r}",
                )
            body = {
                "sender": {"email": sender_email, "name": sender_name},
                "to": [{"email": to}],
                "templateId": template_id_int,
                "params": template_data,
            }
        else:
            html = render_template(template_id, template_data)
            subject = get_subject(template_id, template_data)
            body = {
                "sender": {"email": sender_email, "name": sender_name},
                "to": [{"email": to}],
                "subject": subject,
                "htmlContent": html,
            }

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{BASE_URL}/smtp/email",
                    headers={"api-key": api_key, "Content-Type": "application/json"},
                    json=body,
                    timeout=30.0,
                )

            if resp.status_code == 201:
                msg_id = resp.json().get("messageId")
                logger.info("Brevo email sent", to=to, template_id=template_id, message_id=msg_id)
                return SendResult(success=True, provider=self.name, provider_message_id=msg_id)

            return SendResult(
                success=False,
                provider=self.name,
                error=f"Brevo API {resp.status_code}: {resp.text}",
            )
        except Exception as e:
            return SendResult(success=False, provider=self.name, error=str(e))

    async def health_check(self, credentials: dict[str, str]) -> bool:
        api_key = credentials.get("API_KEY")
        if not api_key:
            return False
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{BASE_URL}/account",
                    headers={"api-key": api_key},
                    timeout=10.0,
                )
            return resp.status_code == 200
        except Exception:
            return False
