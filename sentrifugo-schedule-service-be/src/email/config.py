from pydantic_settings import BaseSettings, SettingsConfigDict


class EmailConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    RABBITMQ_EXCHANGE: str = "email_events"
    RABBITMQ_QUEUE: str = "email_events_queue"
    RABBITMQ_DLQ: str = "email_events_dlq"
    RABBITMQ_ROUTING_KEY: str = "email.#"
    RABBITMQ_PREFETCH_COUNT: int = 10
    RABBITMQ_MAX_RETRIES: int = 3

    ALERTS_EXCHANGE: str = "alerts"

    HEALTH_CHECK_INTERVAL_SECONDS: int = 300
    HEALTH_CHECK_CONSECUTIVE_FAILURES: int = 3

    IDEMPOTENCY_TTL_SECONDS: int = 86400
    DAILY_RATE_LIMIT_DEFAULT: int = 1000

    # "Raise a request in Sentrifugo" footer link, injected into every email
    # template. Points at the Raise Ticket sheet pre-filled with a fixed
    # support Category + Subtype (both must have an active workflow).
    FRONTEND_BASE_URL: str = "http://localhost:5173"
    SUPPORT_CATEGORY_ID: str = ""
    SUPPORT_SUBTYPE_ID: str = ""


email_settings = EmailConfig()
