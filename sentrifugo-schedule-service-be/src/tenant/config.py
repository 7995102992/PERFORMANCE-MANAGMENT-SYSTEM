from pydantic_settings import BaseSettings, SettingsConfigDict


class TenantConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    CREDENTIAL_SOURCE: str = "env"

    VAULT_URL: str = ""
    VAULT_TOKEN: str = ""
    VAULT_SECRET_PATH: str = ""

    DEFAULT_EMAIL_PROVIDER: str = "brevo"
    DEFAULT_FALLBACK_CHAIN: str = "ses,smtp"

    DEFAULT_BREVO_API_KEY: str = ""
    DEFAULT_SENDER_EMAIL: str = "noreply@example.com"
    DEFAULT_SENDER_NAME: str = "Sentrifugo"


tenant_settings = TenantConfig()
