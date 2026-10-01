from pydantic_settings import BaseSettings, SettingsConfigDict


class LogsConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    TIMESCALEDB_DSN: str = "postgresql://postgres:password@localhost:6543/"
    VALID_API_KEYS: str = "{\"my-api-key-1\": \"ADMIN\", \"my-api-key-2\": \"MANAGER\"}"
    LOG_CACHE_TTL_SECONDS: int = 60


logs_settings = LogsConfig()
