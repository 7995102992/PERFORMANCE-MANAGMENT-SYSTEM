
from pydantic_settings import BaseSettings, SettingsConfigDict


class AuthConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    JWT_SECRET_KEY: str = "default_unsafe_secret"
    JWT_EXP_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    REMEMBER_REFRESH_TOKEN_EXPIRE_DAYS: int = 90

    # Password policy
    PASSWORD_EXPIRY_DAYS: int = 90
    PASSWORD_HISTORY_COUNT: int = 5

    # Account activation
    ACTIVATION_TOKEN_EXPIRE_HOURS: int = 72

    # Password reset
    PASSWORD_RESET_TOKEN_EXPIRE_MINUTES: int = 30

    # Email-change confirmation
    EMAIL_CHANGE_TOKEN_EXPIRE_HOURS: int = 24

    # Azure AD SSO
    AZURE_CLIENT_ID: str | None = None
    AZURE_CLIENT_SECRET: str | None = None
    AZURE_TENANT_ID: str | None = None

    # Redirect URIs
    AZURE_REDIRECT_URI: str = (
        "http://localhost:5173/admin/callback"
    )
    AZURE_REDIRECT_URI_USER: str = (
        "http://localhost:5174/callback"
    )

    # Azure Graph scopes
    AZURE_SCOPES: list[str] = ["User.Read"]


auth_settings = AuthConfig()