from fastapi import APIRouter

from src.health.schemas import HealthResponse
from src.health.service import check_health

router = APIRouter(prefix="/health", tags=["health"])


@router.get("", response_model=HealthResponse)
async def get_health_status() -> HealthResponse:
    result = await check_health()
    return HealthResponse(**result)
