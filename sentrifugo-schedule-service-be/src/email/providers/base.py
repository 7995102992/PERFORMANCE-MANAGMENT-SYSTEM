from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class SendResult:
    success: bool
    provider: str
    provider_message_id: str | None = None
    error: str | None = None


class EmailProviderBase(ABC):
    name: str

    @abstractmethod
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
        ...

    @abstractmethod
    async def health_check(self, credentials: dict[str, str]) -> bool:
        ...
