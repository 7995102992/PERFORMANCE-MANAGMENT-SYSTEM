from datetime import datetime, timezone
from urllib.parse import quote_plus

from pydantic import computed_field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Deployment environment. Defaults to (and reads a blank value as)
    # "production" so anything gated on development — notably the dev-session
    # auth escape hatch — fails closed when the env isn't declared.
    ENVIRONMENT: str = "production"
    LOG_LEVEL: str = "INFO"
    CORS_ORIGINS: list[str] = ["*"]
    API_PREFIX: str = ""

    # MongoDB (split fields → URL built automatically, mirrors IAM)
    MONGO_DB_HOST: str | None = None
    MONGO_DB_PORT: int = 27017
    MONGO_DB_USER: str | None = None
    MONGO_DB_PASSWORD: str | None = None
    MONGO_DB_NAME: str = "sentrifugo_srm"

    @field_validator("ENVIRONMENT", mode="before")
    @classmethod
    def _blank_env_is_production(cls, v):
        """``ENVIRONMENT=`` in a .env must not read as development."""
        if v is None or (isinstance(v, str) and not v.strip()):
            return "production"
        return v

    @property
    def IS_DEVELOPMENT(self) -> bool:
        """True only when ENVIRONMENT is explicitly "development".

        Gates development-only behaviour (see auth/utils/dependencies.py).
        Anything else — including unset / blank — counts as production.
        """
        return self.ENVIRONMENT.strip().lower() == "development"

    @computed_field
    @property
    def MONGODB_URL(self) -> str:
        if not self.MONGO_DB_HOST:
            return "mongodb://localhost:27017"
        if self.MONGO_DB_USER and self.MONGO_DB_PASSWORD:
            creds = f"{quote_plus(self.MONGO_DB_USER)}:{quote_plus(self.MONGO_DB_PASSWORD)}@"
        else:
            creds = ""
        params = "?authSource=admin" if creds else ""
        return f"mongodb://{creds}{self.MONGO_DB_HOST}:{self.MONGO_DB_PORT}{params}"

    # Valkey
    VALKEY_HOST: str | None = None
    VALKEY_PORT: int = 6379
    VALKEY_USER: str | None = None
    VALKEY_PASSWORD: str | None = None
    VALKEY_DB: int = 0

    @computed_field
    @property
    def VALKEY_URL(self) -> str:
        if not self.VALKEY_HOST:
            return "redis://localhost:6379/0"
        if self.VALKEY_USER and self.VALKEY_PASSWORD:
            creds = f"{quote_plus(self.VALKEY_USER)}:{quote_plus(self.VALKEY_PASSWORD)}@"
        elif self.VALKEY_PASSWORD:
            creds = f":{quote_plus(self.VALKEY_PASSWORD)}@"
        else:
            creds = ""
        return f"redis://{creds}{self.VALKEY_HOST}:{self.VALKEY_PORT}/{self.VALKEY_DB}"

    # RabbitMQ
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"
    RABBITMQ_EXCHANGE: str = "srm.events"

    # IAM (sibling microservice — empty = stub mode)
    IAM_BASE_URL: str = ""
    IAM_SERVICE_TOKEN: str = ""

    # Logging service (sibling — empty = stub mode)
    LOGGING_BASE_URL: str = ""
    LOGGING_SERVICE_TOKEN: str = ""

    # Internal job auth (shared secret for /_internal/jobs/*)
    INTERNAL_TOKEN: str = ""

    # SLA tick. Run in-process (see requests/sla_scheduler.py). Safe on multiple
    # replicas: deadlines are claimed atomically out of Mongo, so two loops
    # cannot pop the same entry. Set the interval to 0 to disable the in-process
    # ticker entirely and drive /_internal/jobs/sla-tick from an external cron.
    SLA_TICK_INTERVAL_SECONDS: int = 60
    # Act-from-email token housekeeping. Daily is ample — the sweep only deletes
    # rows already long past expiry. 0 disables the in-process loop, leaving
    # POST /_internal/jobs/purge-action-tokens for an external cron, exactly as
    # SLA_TICK_INTERVAL_SECONDS=0 does for the tick.
    ACTION_TOKEN_PURGE_INTERVAL_SECONDS: int = 86400

    # The workflow's own escalation timer (EscalationConfig.escalate_after_minutes)
    # and its pre-notify warning. Separate from the SLA rule's violation actions,
    # but they ride the same store and the same tick — so this gates them off
    # independently. The escalate path is complete — it writes a HandoffEvent,
    # an escalation reason and previous_executor_user_id, and emails the new
    # owner, matching the manual Escalate flow. Still defaulted off because
    # turning it on starts moving tickets between people on a timer for every
    # workflow that already has Escalation Rules switched on. Enable
    # deliberately, after checking which workflows those are.
    #
    # Caveat: the pre-notify warning (pre_notify_enabled) publishes an event no
    # service consumes, so it still warns nobody — see
    # requests/service_sla_tick._emit_pre_escalation_warning.
    SLA_AUTO_ESCALATE_ENABLED: bool = False

    # Cutoff for acting on a deadline. The tick discards any claimed entry whose
    # ``due_at`` falls before this instant — no email, no priority bump, no
    # reassignment. ``None`` (the default) enforces everything.
    #
    # This exists because the tick had never actually run before
    # `requests/sla_scheduler.py` was added, so every ticket ever raised carries
    # a long-past deadline. Anything that enrols those tickets in bulk —
    # `rebuild_sla_cursor` sweeping in-flight tickets, or `reenrol_workflow_timers`
    # sweeping a workflow's backlog after an EscalationConfig edit — would make
    # the whole backlog due at once and mail out a breach notice for each.
    #
    # Checked in the tick rather than at the four enrolment call sites on
    # purpose: the tick is the single point every deadline passes through and
    # the only place that sends mail, so one check covers the paths that exist
    # today and any added later.
    #
    # Set it to deploy time when switching the ticker on against an existing
    # database. Tickets raised afterwards have deadlines past the cutoff and are
    # unaffected; so is a pre-cutoff ticket whose deadline lands after it, which
    # is the intended behaviour — that ticket is live and genuinely breaching.
    #
    # Accepts anything pydantic parses as a datetime (e.g. "2026-07-21T00:00:00Z").
    # A value without a timezone is read as UTC.
    SLA_ENFORCE_FROM: datetime | None = None

    @field_validator("SLA_ENFORCE_FROM", mode="before")
    @classmethod
    def _blank_is_unset(cls, v):
        """``SLA_ENFORCE_FROM=`` in a .env means "no cutoff", not a parse error.

        Without this, declaring the key with an empty value — which is how
        .env.example and the DevOps env files list optional settings — fails
        validation at import, and `settings = GlobalConfig()` runs at module
        scope. The service would not start at all.
        """
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("SLA_ENFORCE_FROM")
    @classmethod
    def _utc(cls, v: datetime | None) -> datetime | None:
        """Naive input → UTC. `due_at` is always aware, and comparing the two
        raises TypeError — which inside the tick's per-entry try would look like
        a processing failure rather than a misconfigured cutoff."""
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v

    # Frontend URL (for building email links in notifications)
    FRONTEND_URL: str = "http://localhost:3000"
    # Landing page for act-from-email links. Owned by the FE, so it is settable
    # without a code change. The page reads ?token/&resource_id/&action, then
    # POSTs — the emailed URL must never be the action endpoint itself, or a
    # mail-client prefetcher would approve things nobody clicked.
    EMAIL_ACTION_PATH: str = "/service-request/approval-action"
    # How long an emailed action link stays usable. Long enough to survive a
    # weekend and a holiday; short enough that a link in an old mailbox stops.
    EMAIL_ACTION_TOKEN_DAYS: int = 7

    # Roster intimation on request raise. When on, every executor on the
    # category's roster — primary and secondary alike, and nobody else — gets
    # an email saying a ticket has landed in their category.
    #
    # Replaces DEPT_INTIMATION_ENABLED / DEPT_INTIMATION_RECIPIENT_CAP, which
    # mailed every employee of every department the category names. Those keys
    # are dead; `extra="ignore"` above means a deployment whose OpenBao still
    # carries them starts fine and simply ignores them. There is no cap here:
    # a roster is a hand-picked list, not a headcount.
    ROSTER_INTIMATION_ENABLED: bool = True

    # Storage backend.
    # Set STORAGE_BACKEND=s3 to use DigitalOcean Spaces (S3-compatible);
    # any other value (or unset) falls back to local-disk storage at
    # STORAGE_LOCAL_DIR.
    STORAGE_BACKEND: str = "local"
    STORAGE_LOCAL_DIR: str = "./.storage"

    # DigitalOcean Spaces credentials — only required when STORAGE_BACKEND=s3.
    # The same bucket as Sentrifugo-IAM-Admin-BE can be reused; SRM scopes
    # its uploads under the "service-request-attachments/" folder so the
    # two services don't collide.
    DO_SPACES_ACCESS_KEY: str = ""
    DO_SPACES_SECRET_KEY: str = ""
    DO_SPACES_ENDPOINT: str = ""    # e.g. https://sgp1.digitaloceanspaces.com
    DO_SPACES_REGION: str = "us-east-1"
    DO_SPACES_BUCKET: str = ""
    # Folder prefix inside the bucket for all SRM attachments.
    DO_SPACES_FOLDER: str = "service-request-attachments"
    # Pre-signed download URL TTL (seconds).
    DO_SPACES_PRESIGN_TTL: int = 300


settings = GlobalConfig()
