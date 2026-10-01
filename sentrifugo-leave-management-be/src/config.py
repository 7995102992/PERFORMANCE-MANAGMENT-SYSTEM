from pydantic_settings import BaseSettings, SettingsConfigDict
from urllib.parse import quote_plus

from pydantic import computed_field

class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Fail closed: an unset ENVIRONMENT is treated as production, so the
    # development-only endpoints stay disabled unless development is explicit.
    ENVIRONMENT: str = "production"
    CORS_ORIGINS: list[str] = ["*"]
    RABBITMQ_URL: str
    # Origin of the main app, used for the deep links in notification emails.
    # Must match where the app is actually served (Vite dev server is :5173;
    # deployed environments set their own domain) or every email button 404s.
    FRONTEND_URL: str = "http://localhost:5173"

    # Sibling service URLs (used for cross-service lookups like master_data).
    IAM_BASE_URL: str = "http://localhost:8000"

    # Inbox(es) copied on every leave request submission, comma-separated.
    # HR tracks leave centrally, so this copy is sent independently of the
    # approver chain — it still arrives when no approver resolves.
    LEAVE_HR_NOTIFY_EMAILS: str = "hrd@sagarsoft.in"

    # Shared with IAM Admin BE — used to decrypt CTC for financial analytics
    ENCRYPTION_KEY: str = ""

    # Valkey/Redis (individual fields → URL built automatically)
    VALKEY_HOST: str = "127.0.0.1"
    VALKEY_PORT: int = 6379
    VALKEY_USER: str | None = None
    VALKEY_PASSWORD: str | None = None
    VALKEY_DB: int = 0

    @computed_field
    @property
    def VALKEY_URL(self) -> str:
        if self.VALKEY_USER and self.VALKEY_PASSWORD:
            creds = f"{quote_plus(self.VALKEY_USER)}:{quote_plus(self.VALKEY_PASSWORD)}@"
        else:
            creds = ""
        return f"redis://{creds}{self.VALKEY_HOST}:{self.VALKEY_PORT}/{self.VALKEY_DB}"
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-2.5-flash"
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-sonnet-4-6"
    ANTHROPIC_HAIKU_MODEL: str = "claude-haiku-4-5"

    # DigitalOcean Spaces (S3-compatible object storage)
    DO_SPACES_ACCESS_KEY: str = ""
    DO_SPACES_SECRET_KEY: str = ""
    DO_SPACES_REGION: str = "sgp1"
    DO_SPACES_BUCKET: str = ""
    DO_SPACES_ENDPOINT: str = ""

    # Neo4j — organisational graph intelligence
    NEO4J_URI: str = "bolt://localhost:7687"
    NEO4J_USER: str = "neo4j"
    NEO4J_PASSWORD: str = ""
    NEO4J_DATABASE: str = "neo4j"

    # Attendance is read-only here: punches are read from MongoDB, which the
    # separate collector service (sentrifugo-attendance-mssql-service) writes.
    # The biometric MS SQL connection, the puller, and the ingest API key all
    # moved to that service, so no attendance-source config lives here.

    # MongoDB (individual fields → URL built automatically)
    MONGO_DB_HOST: str | None = None
    MONGO_DB_PORT: int = 27017
    MONGO_DB_USER: str | None = None
    MONGO_DB_PASSWORD: str | None = None
    MONGO_DB_NAME: str | None = None

    @computed_field
    @property
    def MONGODB_URL(self) -> str | None:
        if not self.MONGO_DB_HOST:
            return None
        if self.MONGO_DB_USER and self.MONGO_DB_PASSWORD:
            creds = f"{quote_plus(self.MONGO_DB_USER)}:{quote_plus(self.MONGO_DB_PASSWORD)}@"
        else:
            creds = ""
        db = f"/{self.MONGO_DB_NAME}" if self.MONGO_DB_NAME else ""
        params = "?authSource=admin" if creds else ""
        return f"mongodb://{creds}{self.MONGO_DB_HOST}:{self.MONGO_DB_PORT}{db}{params}"

settings = GlobalConfig()
