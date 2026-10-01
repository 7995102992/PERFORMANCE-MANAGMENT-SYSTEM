from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from src.database import get_db_session
from src.dependencies import UserBase, require_permission
from src.leave_analytics.employee_dashboard import get_employee_dashboard
from src.leave_analytics.manager_dashboard import get_manager_dashboard
from src.leave_analytics.hr_dashboard import get_hr_dashboard
from src.leave_analytics.md_dashboard import get_md_dashboard
from src.leave_analytics.cfo_dashboard import get_cfo_dashboard
from src.leave_analytics.quarterly_scores import backfill_quarterly_scores, compute_quarter_score

router = APIRouter(prefix="/leave-analytics", tags=["leave-analytics"])


@router.get("/employee-dashboard")
async def employee_dashboard(
    current_user: Annotated[UserBase, Depends(require_permission("employee_leave_analytics"))],
    db: Any = Depends(get_db_session),
) -> dict:
    # Self-scoped: aggregates only the caller's own requests / balances.
    return await get_employee_dashboard(db, current_user.user_id)


@router.get("/manager-dashboard")
async def manager_dashboard(
    current_user: Annotated[UserBase, Depends(require_permission("manager_leave_analytics"))],
    from_date: date | None = Query(
        default=None,
        description="Start of the reporting window (YYYY-MM-DD). Defaults to the current financial year start (1 Apr).",
    ),
    to_date: date | None = Query(
        default=None,
        description="End of the reporting window, inclusive (YYYY-MM-DD). Defaults to today.",
    ),
    db: Any = Depends(get_db_session),
) -> dict:
    # Scoped to the caller's own reporting line by _get_managed_user_ids.
    return await get_manager_dashboard(
        db, current_user.user_id, from_date=from_date, to_date=to_date,
        org_id=current_user.org_id,
    )


@router.get("/hr-dashboard")
async def hr_dashboard(
    current_user: Annotated[UserBase, Depends(require_permission("hr_leave_analytics"))],
    db: Any = Depends(get_db_session),
) -> dict:
    return await get_hr_dashboard(db, organisation_id=current_user.org_id)


@router.get("/md-dashboard")
async def md_dashboard(
    current_user: Annotated[UserBase, Depends(require_permission("md_leave_analytics"))],
    db: Any = Depends(get_db_session),
) -> dict:
    return await get_md_dashboard(db, organisation_id=current_user.org_id)


@router.get("/cfo-dashboard")
async def cfo_dashboard(
    current_user: Annotated[UserBase, Depends(require_permission("cfo_leave_analytics"))],
    db: Any = Depends(get_db_session),
) -> dict:
    return await get_cfo_dashboard(db, organisation_id=current_user.org_id)


@router.post("/quarterly-scores/backfill")
async def backfill_scores(
    current_user: Annotated[UserBase, Depends(require_permission("workforce_analytics"))],
    db: Any = Depends(get_db_session),
    quarters: int = 12,
) -> dict:
    """Compute and store culture scores for the last N quarters."""
    results = await backfill_quarterly_scores(db, quarters)
    return {"computed": len(results), "scores": results}


@router.post("/quarterly-scores/compute")
async def compute_score(
    current_user: Annotated[UserBase, Depends(require_permission("workforce_analytics"))],
    db: Any = Depends(get_db_session),
    fy_year: int = 0,
    quarter: int = 0,
) -> dict:
    """Compute and store the culture score for a specific quarter."""
    if fy_year == 0 or quarter == 0:
        from src.leave_analytics.quarterly_scores import _current_quarter
        from datetime import datetime, timezone
        fy_year, quarter = _current_quarter(datetime.now(timezone.utc))
    return await compute_quarter_score(db, fy_year, quarter)
