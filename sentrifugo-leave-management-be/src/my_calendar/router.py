from datetime import date
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.my_calendar.service import get_my_calendar, get_my_holidays

router = APIRouter(tags=["my-calendar"])


@router.get("/my-holidays")
async def my_holidays(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    year: Annotated[int, Query(ge=1970, le=2100, description="Calendar year")],
    db: Any = Depends(get_db_session),
):
    """The signed-in employee's holiday plan and the holidays it grants them.

    Backs the Holidays page, which renders the same payload as either a list or
    a month calendar.
    """
    return await get_my_holidays(
        db,
        user_id=current_user.user_id,
        org_id=current_user.org_id or "",
        year=year,
    )


@router.get("/calendar")
async def my_calendar(
    from_date: Annotated[date, Query(alias="from", description="Range start date (YYYY-MM-DD)")],
    to_date: Annotated[date, Query(alias="to", description="Range end date (YYYY-MM-DD)")],
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
):
    return await get_my_calendar(
        db,
        user_id=current_user.user_id,
        org_id=current_user.org_id or "",
        from_date=from_date,
        to_date=to_date,
    )
