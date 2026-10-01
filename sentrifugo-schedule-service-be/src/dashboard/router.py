from fastapi import APIRouter, Depends
from typing import Annotated

from src.auth.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.dashboard.schemas import DashboardStats
from src.dashboard.service import get_dashboard_stats

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

@router.get("/stats", response_model=DashboardStats)
async def fetch_stats(current_user: Annotated[UserBase, Depends(get_current_user)]) -> DashboardStats:
    """Protected endpoint requiring valid JWT authorization."""
    return await get_dashboard_stats()
