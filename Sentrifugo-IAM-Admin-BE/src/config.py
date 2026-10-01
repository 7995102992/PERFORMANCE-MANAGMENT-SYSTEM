
from urllib.parse import quote_plus

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ENVIRONMENT: str = "production"

    # Expose /docs, /redoc, /openapi.json.
    # Keep false in production; enable explicitly for local/staging.
    DOCS_ENABLED: bool = False

    # CORS
    CORS_ORIGINS: list[str] = []

    # Database
    DATABASE_TYPE: str = "sql"

    # PostgreSQL
    POSTGRES_URL: str | None = None

    # MongoDB (supports full URL and individual fields)
    MONGO_DB_URL: str | None = None
    MONGO_DB_HOST: str | None = None
    MONGO_DB_PORT: int = 27017
    MONGO_DB_USER: str | None = None
    MONGO_DB_PASSWORD: str | None = None
    MONGO_DB_NAME: str | None = None

    @computed_field
    @property
    def MONGODB_URL(self) -> str | None:
        # Prefer a complete MongoDB URL, such as MongoDB Atlas.
        if self.MONGO_DB_URL:
            return self.MONGO_DB_URL

        # Fall back to individual MongoDB connection fields.
        if not self.MONGO_DB_HOST:
            return None

        if self.MONGO_DB_USER and self.MONGO_DB_PASSWORD:
            creds = (
                f"{quote_plus(self.MONGO_DB_USER)}:"
                f"{quote_plus(self.MONGO_DB_PASSWORD)}@"
            )
        else:
            creds = ""

        db = f"/{self.MONGO_DB_NAME}" if self.MONGO_DB_NAME else ""
        params = "?authSource=admin" if creds else ""

        return (
            f"mongodb://{creds}"
            f"{self.MONGO_DB_HOST}:{self.MONGO_DB_PORT}"
            f"{db}{params}"
        )

    # Valkey (supports Upstash and local Valkey)
    VALKEY_FULL_URL: str | None = None
    VALKEY_HOST: str | None = None
    VALKEY_PORT: int = 6379
    VALKEY_USER: str | None = None
    VALKEY_PASSWORD: str | None = None
    VALKEY_DB: int = 0

    @computed_field
    @property
    def VALKEY_URL(self) -> str:
        # Prefer the full Upstash connection URL.
        if self.VALKEY_FULL_URL:
            return self.VALKEY_FULL_URL

        # Fall back to local Valkey if no host is configured.
        if not self.VALKEY_HOST:
            return "redis://localhost:6379/0"

        if self.VALKEY_USER and self.VALKEY_PASSWORD:
            creds = (
                f"{quote_plus(self.VALKEY_USER)}:"
                f"{quote_plus(self.VALKEY_PASSWORD)}@"
            )
        elif self.VALKEY_PASSWORD:
            creds = f":{quote_plus(self.VALKEY_PASSWORD)}@"
        else:
            creds = ""

        return (
            f"redis://{creds}"
            f"{self.VALKEY_HOST}:{self.VALKEY_PORT}/{self.VALKEY_DB}"
        )

    # RabbitMQ
    RABBITMQ_URL: str

    # DigitalOcean Spaces (S3-compatible)
    DO_SPACES_ACCESS_KEY: str | None = None
    DO_SPACES_SECRET_KEY: str | None = None
    DO_SPACES_ENDPOINT: str | None = None
    DO_SPACES_BUCKET: str | None = None
    DO_SPACES_REGION: str = "sgp1"

    # Frontend
    FRONTEND_URL: str | None = None
    USER_FRONTEND_URL: str | None = None

    # Encryption
    # Fernet key used to encrypt sensitive fields at rest.
    ENCRYPTION_KEY: str | None = None

    # Payslip admin access
    # Comma-separated email addresses.
    PAYSLIP_ADMIN_EMAILS: str = ""

    @property
    def payslip_admin_email_set(self) -> set[str]:
        return {
            e.strip().lower()
            for e in self.PAYSLIP_ADMIN_EMAILS.split(",")
            if e.strip()
        }

    # Central Logging Service
    LOGGING_SERVICE_URL: str = "http://localhost:8002"
    LOGGING_SERVICE_API_KEY: str = "my-api-key-1"

    # Maximum number of upstream rows fetched per query.
    LOGGING_SERVICE_FETCH_CAP: int = 2000

    # Neo4j
    NEO4J_HOST: str | None = None
    NEO4J_PORT: int = 7687
    NEO4J_USER: str | None = None
    NEO4J_PASSWORD: str | None = None
    NEO4J_DATABASE: str = "neo4j"

    @computed_field
    @property
    def NEO4J_URI(self) -> str:
        host = self.NEO4J_HOST or "localhost"
        return f"bolt://{host}:{self.NEO4J_PORT}"

    # Attendance
    ATTENDANCE_EXCEL_DIR: str | None = None
    ATTENDANCE_ORG_ID: str | None = None


settings = GlobalConfig()