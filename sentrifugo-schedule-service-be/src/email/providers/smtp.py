import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

from src.email.providers.base import EmailProviderBase, SendResult
from src.email.templates.renderer import get_subject, render_template
from src.logger import logger


class SMTPProvider(EmailProviderBase):
    name = "smtp"

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
        host = credentials.get("HOST")
        if not host:
            return SendResult(success=False, provider=self.name, error="Missing HOST in credentials")

        port = int(credentials.get("PORT", "587"))
        username = credentials.get("USERNAME", "")
        password = credentials.get("PASSWORD", "")
        use_tls = credentials.get("USE_TLS", "true").lower() == "true"

        try:
            html = render_template(template_id, template_data)
            subject = get_subject(template_id, template_data)
        except FileNotFoundError as e:
            return SendResult(success=False, provider=self.name, error=str(e))

        msg = MIMEMultipart("alternative")
        msg["From"] = f"{sender_name} <{sender_email}>" if sender_name else sender_email
        msg["To"] = to
        msg["Subject"] = subject
        msg.attach(MIMEText(html, "html", "utf-8"))

        try:
            with smtplib.SMTP(host, port, timeout=30) as server:
                if use_tls:
                    server.starttls()
                if username and password:
                    server.login(username, password)
                server.send_message(msg)

            logger.info("SMTP email sent", to=to, template_id=template_id, host=host)
            return SendResult(success=True, provider=self.name)
        except Exception as e:
            return SendResult(success=False, provider=self.name, error=str(e))

    async def health_check(self, credentials: dict[str, str]) -> bool:
        host = credentials.get("HOST")
        if not host:
            return False
        port = int(credentials.get("PORT", "587"))
        try:
            with smtplib.SMTP(host, port, timeout=10) as server:
                server.ehlo()
            return True
        except Exception:
            return False
