from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class AuthConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    JWT_SECRET_KEY: str = "change-me-in-production"


auth_settings = AuthConfig()
