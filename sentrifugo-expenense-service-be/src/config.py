"""Global application configuration.

All settings are read from environment variables (or a local ``.env`` file).
Mirrors the standardised Sentrifugo backend layout (Percona MongoDB + Valkey +
RabbitMQ) used across IAM / Service-Request / Timesheet / Leave / Schedule /
Payroll, with IAM as the canonical reference.
"""

from urllib.parse import quote_plus

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"
    CORS_ORIGINS: list[str] = ["*"]
    API_PREFIX: str = ""

    # MongoDB (Percona Server for MongoDB) — split fields → URL built automatically
    MONGO_DB_HOST: str = "localhost"
    MONGO_DB_PORT: int = 27017
    MONGO_DB_USER: str | None = None
    MONGO_DB_PASSWORD: str | None = None
    MONGO_DB_NAME: str = "sentrifugo_expense"

    @computed_field
    @property
    def MONGODB_URL(self) -> str:
        if self.MONGO_DB_USER and self.MONGO_DB_PASSWORD:
            creds = f"{quote_plus(self.MONGO_DB_USER)}:{quote_plus(self.MONGO_DB_PASSWORD)}@"
        else:
            creds = ""
        db = f"/{self.MONGO_DB_NAME}" if self.MONGO_DB_NAME else ""
        params = "?authSource=admin" if creds else ""
        return f"mongodb://{creds}{self.MONGO_DB_HOST}:{self.MONGO_DB_PORT}{db}{params}"

    # Valkey (Redis-compatible) — split fields → URL built automatically
    VALKEY_HOST: str | None = None
    VALKEY_PORT: int = 6379
    VALKEY_USER: str | None = None
    VALKEY_PASSWORD: str | None = None
    VALKEY_DB: int = 0

    @computed_field
    @property
    def VALKEY_URL(self) -> str:
        if not self.VALKEY_HOST:
            return "redis://localhost:6379/0"
        if self.VALKEY_USER and self.VALKEY_PASSWORD:
            creds = f"{quote_plus(self.VALKEY_USER)}:{quote_plus(self.VALKEY_PASSWORD)}@"
        elif self.VALKEY_PASSWORD:
            creds = f":{quote_plus(self.VALKEY_PASSWORD)}@"
        else:
            creds = ""
        return f"redis://{creds}{self.VALKEY_HOST}:{self.VALKEY_PORT}/{self.VALKEY_DB}"

    # RabbitMQ
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"

    # IAM (sibling microservice — empty = stub/dev mode)
    IAM_BASE_URL: str = ""
    IAM_SERVICE_TOKEN: str = ""

    # Logging Service (sibling — empty = stub mode)
    LOGGING_BASE_URL: str = ""
    LOGGING_SERVICE_TOKEN: str = ""

    # Internal job auth (Schedule Service / cron shared secret)
    INTERNAL_API_KEY: str = ""

    # Frontend URL (for building email links in notifications)
    FRONTEND_URL: str = "http://localhost:3000"

    # DigitalOcean Spaces (S3-compatible object storage) — only required when
    # receipt/document storage is enabled.
    DO_SPACES_ACCESS_KEY: str = ""
    DO_SPACES_SECRET_KEY: str = ""
    DO_SPACES_ENDPOINT: str = ""  # e.g. https://sgp1.digitaloceanspaces.com
    DO_SPACES_REGION: str = "sgp1"
    DO_SPACES_BUCKET: str = ""
    DO_SPACES_FOLDER: str = "expense-receipts"
    DO_SPACES_PRESIGN_TTL: int = 300

    # Encryption — Fernet key used to encrypt sensitive expense fields at rest
    # (reimbursement bank details, card/account identifiers).
    ENCRYPTION_KEY: str | None = None


settings = GlobalConfig()
