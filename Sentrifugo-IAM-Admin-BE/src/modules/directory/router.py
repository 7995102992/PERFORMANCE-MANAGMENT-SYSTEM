"""Employee directory — separate router. Any authenticated employee may browse the
public directory of their organisation (no HR permission required)."""
from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query

from src.auth.schemas import UserBase
from src.auth.utils.dependencies import get_current_user
from src.modules.directory import service
from src.modules.directory.schema import DirectoryListResponse

router = APIRouter(prefix="/directory", tags=["directory"])


def _ids(csv: Optional[str]) -> Optional[list[PydanticObjectId]]:
    if not csv:
        return None
    out = []
    for part in csv.split(","):
        part = part.strip()
        if part:
            try:
                out.append(PydanticObjectId(part))
            except Exception:
                pass
    return out or None


@router.get("", response_model=DirectoryListResponse)
async def list_directory(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    search: str = Query(default="", description="Match on name / emp code / email"),
    business_unit_ids: Optional[str] = Query(default=None, alias="businessUnitIds", description="Comma-separated BU ids"),
    department_ids: Optional[str] = Query(default=None, alias="departmentIds", description="Comma-separated Department ids"),
    include_inactive: bool = Query(default=False, alias="includeInactive", description="Include inactive employees (default: active only)"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
):
    """Public employee directory for the caller's organisation — colleague-visible
    fields only (name, emp code, work email/phone, BU/dept/designation, L1/L2
    managers, employment type/status, DOJ, photo). No sensitive data. Active
    employees only unless includeInactive=true.

    Scoped to the caller's own business unit(s); super and org admins see the
    whole organisation. `businessUnitIds` narrows that scope, never widens it.
    """
    return await service.list_directory(
        caller=current_user,
        business_unit_ids=_ids(business_unit_ids),
        department_ids=_ids(department_ids),
        include_inactive=include_inactive,
        search=search,
        skip=skip,
        limit=limit,
    )
