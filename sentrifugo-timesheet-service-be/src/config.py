from __future__ import annotations

from urllib.parse import quote_plus

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Fail closed: an unset/empty ENVIRONMENT must never be treated as development.
    ENVIRONMENT: str = "production"
    LOG_LEVEL: str = "info"
    CORS_ORIGINS: list[str] = ["*"]
    API_PREFIX: str = ""

    # MongoDB
    MONGO_DB_HOST: str = "localhost"
    MONGO_DB_PORT: int = 27017
    MONGO_DB_USER: str | None = None
    MONGO_DB_PASSWORD: str | None = None
    MONGO_DB_NAME: str = "sentrifugo_timesheet"

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

    # Valkey
    VALKEY_HOST: str = "localhost"
    VALKEY_PORT: int = 6379
    VALKEY_USER: str | None = None
    VALKEY_PASSWORD: str | None = None
    VALKEY_DB: int = 0

    @computed_field
    @property
    def VALKEY_URL(self) -> str:
        if self.VALKEY_USER and self.VALKEY_PASSWORD:
            creds = f"{quote_plus(self.VALKEY_USER)}:{quote_plus(self.VALKEY_PASSWORD)}@"
        elif self.VALKEY_PASSWORD:
            creds = f":{quote_plus(self.VALKEY_PASSWORD)}@"
        else:
            creds = ""
        return f"redis://{creds}{self.VALKEY_HOST}:{self.VALKEY_PORT}/{self.VALKEY_DB}"

    # RabbitMQ
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"

    # IAM
    IAM_BASE_URL: str = ""

    # Logging Service
    LOGGING_BASE_URL: str = ""
    LOGGING_API_KEY: str = ""

    # Frontend URL (for building email links)
    FRONTEND_URL: str = "http://localhost:3000"

    # Internal API key for machine-to-machine endpoints (e.g. auto-submit cron)
    INTERNAL_API_KEY: str = ""


settings = GlobalConfig()
