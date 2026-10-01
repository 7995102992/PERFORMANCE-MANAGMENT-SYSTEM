from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = ["*"]
    REDIS_URL: str
    RABBITMQ_URL: str

settings = GlobalConfig()
