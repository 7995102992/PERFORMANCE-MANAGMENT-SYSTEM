from typing import Any

import httpx

from src.attendance.config import attendance_settings
from src.logger import logger


async def send_batch(batch: list[dict[str, Any]]) -> bool:
    """Push one batch of crawled rows to the target API.

    Returns True on 2xx, False otherwise. Failures are logged, never raised —
    the crawl loop decides how to aggregate them.
    """
    headers = {"Content-Type": "application/json"}
    if attendance_settings.TARGET_API_KEY:
        headers["Authorization"] = f"Bearer {attendance_settings.TARGET_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=attendance_settings.TARGET_API_TIMEOUT_SECONDS) as client:
            response = await client.post(
                attendance_settings.TARGET_API_URL,
                json={"records": batch},
                headers=headers,
            )
            response.raise_for_status()
            return True
    except httpx.HTTPStatusError as e:
        logger.error(
            "Target API rejected batch",
            status_code=e.response.status_code,
            batch_size=len(batch),
        )
    except httpx.HTTPError as e:
        logger.error("Target API unreachable", error=str(e), batch_size=len(batch))
    return False
