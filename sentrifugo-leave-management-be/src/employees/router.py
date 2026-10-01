from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.employees.schemas import ScopedEmployeeList
from src.employees.service import list_scoped_employees

router = APIRouter(tags=["employees"])


def _csv(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


@router.get("/employees", response_model=ScopedEmployeeList)
async def get_scoped_employees(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    business_unit_ids: str | None = Query(default=None, description="Comma-separated BU ids"),
    department_ids: str | None = Query(default=None, description="Comma-separated department ids"),
    designation_ids: str | None = Query(default=None, description="Comma-separated designation ids"),
    employment_type_id: str | None = Query(default=None),
    search: str = Query(default=""),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: Any = Depends(get_db_session),
) -> ScopedEmployeeList:
    """Paged pool of assignable employees for the assignment pickers, served
    from the LMS mirror (name/dept/BU/designation already resolved) so the FE
    no longer fetches the org from IAM and joins client-side."""
    result = await list_scoped_employees(
        db,
        current_user.org_id,
        business_unit_ids=_csv(business_unit_ids),
        department_ids=_csv(department_ids),
        designation_ids=_csv(designation_ids),
        employment_type_id=employment_type_id,
        search=search,
        skip=skip,
        limit=limit,
    )
    return ScopedEmployeeList(**result)
