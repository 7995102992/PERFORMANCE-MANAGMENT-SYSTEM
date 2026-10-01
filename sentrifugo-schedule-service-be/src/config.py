from urllib.parse import quote_plus

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = ["*"]

    MONGO_DB_HOST: str = "localhost"
    MONGO_DB_PORT: int = 27017
    MONGO_DB_USER: str | None = None
    MONGO_DB_PASSWORD: str | None = None
    MONGO_DB_NAME: str = "schedule_service_db"

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

    REDIS_URL: str = "redis://localhost:6379/0"
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"

settings = GlobalConfig()
