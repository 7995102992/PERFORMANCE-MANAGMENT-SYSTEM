import asyncio

from fastapi import APIRouter, status

from src.attendance import cron
from src.attendance.config import attendance_settings
from src.attendance.schemas import CrawlStatusResponse, CrawlTriggerResponse

router = APIRouter(prefix="/attendance", tags=["attendance"])


@router.post("/crawl", response_model=CrawlTriggerResponse, status_code=status.HTTP_202_ACCEPTED)
async def trigger_crawl() -> CrawlTriggerResponse:
    """Manually kick off a crawl outside the 6-hour schedule."""
    if cron.is_running():
        return CrawlTriggerResponse(triggered=False, detail="A crawl is already in progress")
    asyncio.create_task(cron.run_crawl_guarded())
    return CrawlTriggerResponse(triggered=True, detail="Crawl started")


@router.get("/crawl/status", response_model=CrawlStatusResponse)
async def get_crawl_status() -> CrawlStatusResponse:
    return CrawlStatusResponse(
        is_running=cron.is_running(),
        interval_hours=attendance_settings.CRAWL_INTERVAL_HOURS,
        last_run=cron.last_run,
    )
