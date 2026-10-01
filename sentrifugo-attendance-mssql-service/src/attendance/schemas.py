from datetime import datetime

from pydantic import BaseModel


class CrawlRunResult(BaseModel):
    status: str  # "success" | "partial" | "failed" | "skipped"
    rows_fetched: int = 0
    batches_sent: int = 0
    batches_failed: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


class CrawlStatusResponse(BaseModel):
    is_running: bool
    interval_hours: float
    last_run: CrawlRunResult | None = None


class CrawlTriggerResponse(BaseModel):
    triggered: bool
    detail: str
