from fastapi import APIRouter

from src.health.schemas import HealthResponse
from src.health.service import check_health

router = APIRouter(prefix="/health", tags=["health"])


@router.get("", response_model=HealthResponse)
async def get_health_status() -> HealthResponse:
    """Liveness + dependency readiness probe.

    Returns ``200`` with ``status: "ok"`` when every configured dependency is
    reachable, or ``status: "degraded"`` when one is down. The endpoint itself
    always responds so orchestrators can distinguish "process up" from
    "dependency down".
    """
    result = await check_health()
    return HealthResponse(**result)
