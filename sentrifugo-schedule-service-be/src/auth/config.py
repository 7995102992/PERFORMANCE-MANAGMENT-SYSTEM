from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEFAULT_SECRET = "default_unsafe_secret"


class AuthConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    JWT_SECRET_KEY: str = _DEFAULT_SECRET
    JWT_EXP_MINUTES: int = 60
    # Read via pydantic-settings (env or .env) so the guard below can't be
    # bypassed by setting ENVIRONMENT only in the .env file.
    ENVIRONMENT: str = "development"

    @model_validator(mode="after")
    def _reject_default_secret_outside_dev(self) -> "AuthConfig":
        # Fail fast: signing/validating JWTs with the publicly-known default
        # secret outside development means anyone can forge a valid token.
        if self.ENVIRONMENT.lower() != "development" and self.JWT_SECRET_KEY == _DEFAULT_SECRET:
            raise ValueError(
                "JWT_SECRET_KEY must be set to a non-default value when "
                f"ENVIRONMENT={self.ENVIRONMENT!r}"
            )
        return self


auth_settings = AuthConfig()
