import os
from abc import ABC, abstractmethod
from typing import Any

from src.logger import logger


class CredentialSource(ABC):
    @abstractmethod
    def load_all(self) -> dict[str, dict[str, dict[str, str]]]:
        """Load all tenant credentials.

        Returns: {tenant_id: {provider: {key: value}}}
        e.g. {"a1b2c3d4": {"brevo": {"API_KEY": "xkeysib-..."}}}
        """
        ...


class EnvCredentialSource(CredentialSource):
    """Parses env vars matching TENANT__{tenant_id}__{PROVIDER}__{KEY}."""

    PREFIX = "TENANT__"

    def load_all(self) -> dict[str, dict[str, dict[str, str]]]:
        registry: dict[str, dict[str, dict[str, str]]] = {}
        for key, value in os.environ.items():
            if not key.startswith(self.PREFIX):
                continue
            parts = key[len(self.PREFIX):].split("__")
            if len(parts) != 3:
                logger.warning("Malformed tenant credential env var, skipping", env_var=key)
                continue
            tenant_id, provider, cred_key = parts
            tenant_id = tenant_id.lower()
            provider = provider.lower()
            registry.setdefault(tenant_id, {}).setdefault(provider, {})[cred_key] = value
        return registry


class VaultCredentialSource(CredentialSource):
    """Placeholder for vault-based credential loading (HashiCorp Vault, AWS Secrets Manager, etc.)."""

    def __init__(self, vault_url: str, vault_token: str, secret_path: str):
        self.vault_url = vault_url
        self.vault_token = vault_token
        self.secret_path = secret_path

    def load_all(self) -> dict[str, dict[str, dict[str, str]]]:
        raise NotImplementedError("Vault credential source not yet implemented — plug in your vault SDK here")


class CredentialRegistry:
    """In-memory credential store. Populated once at startup, queried on the hot path."""

    def __init__(self) -> None:
        self._store: dict[str, dict[str, dict[str, str]]] = {}
        self._defaults: dict[str, dict[str, str]] = {}

    def load(self, source: CredentialSource) -> None:
        self._store = source.load_all()
        tenant_count = len(self._store)
        logger.info("Credential registry loaded", tenant_count=tenant_count)

    def set_defaults(self, defaults: dict[str, dict[str, str]]) -> None:
        self._defaults = {k.lower(): v for k, v in defaults.items()}

    def get(self, tenant_id: str, provider: str) -> dict[str, str] | None:
        creds = self._store.get(tenant_id.lower(), {}).get(provider.lower())
        if creds:
            return creds
        return self._defaults.get(provider.lower())

    def get_api_key(self, tenant_id: str, provider: str) -> str | None:
        creds = self.get(tenant_id, provider)
        if not creds:
            return None
        return creds.get("API_KEY")

    def has_tenant(self, tenant_id: str) -> bool:
        return tenant_id.lower() in self._store

    def tenant_count(self) -> int:
        return len(self._store)

    def all_tenant_providers(self) -> list[tuple[str, str, dict[str, str]]]:
        """Returns [(tenant_id, provider, credentials), ...] for all loaded entries."""
        results = []
        for tenant_id, providers in self._store.items():
            for provider, creds in providers.items():
                results.append((tenant_id, provider, creds))
        return results

    def reload(self, source: CredentialSource) -> None:
        # AUDIT TODO: when a runtime reload trigger is added (e.g. an async admin
        # endpoint), emit `credentials.reloaded` via src.audit.emit_audit there
        # (this method is sync and cannot await). Security-relevant: provider
        # API keys are re-read. Never log the secret values, only tenant_count.
        self.load(source)


credential_registry = CredentialRegistry()
