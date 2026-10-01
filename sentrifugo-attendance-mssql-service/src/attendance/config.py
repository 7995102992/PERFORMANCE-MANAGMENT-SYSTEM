from pydantic_settings import BaseSettings, SettingsConfigDict


class AttendanceConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Crawl scheduling
    CRAWL_INTERVAL_HOURS: float = 6
    CRAWL_ON_STARTUP: bool = True

    # Query that pulls attendance rows from the MS SQL source.
    # Placeholder until the real table/columns are confirmed — adjust per environment.
    CRAWL_QUERY: str = "SELECT * FROM attendance_logs"
    CRAWL_BATCH_SIZE: int = 500

    # Target API the crawled data is pushed to
    TARGET_API_URL: str = "http://localhost:8000/api/v1/attendance/ingest"
    TARGET_API_KEY: str | None = None
    TARGET_API_TIMEOUT_SECONDS: float = 30


attendance_settings = AttendanceConfig()
