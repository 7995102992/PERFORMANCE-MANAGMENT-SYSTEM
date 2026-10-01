from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PastSubmissionOverrideCreate(BaseModel):
    """Reopen one closed month for one employee."""

    model_config = ConfigDict(extra="forbid")
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    reason: str | None = Field(None, max_length=500)


class PastSubmissionOverrideOut(BaseModel):
    id: str
    organisation_id: str
    user_id: str
    user_name: str | None = None
    year: int
    month: int
    # Projects this grant covers — the granting manager's own. Empty means
    # unrestricted, which only an admin's grant carries.
    project_ids: list[str] = []
    # The grant closes itself here, a week after it was made. Reopening again
    # refreshes it.
    expires_at: datetime | None = None
    reason: str | None = None
    created_by: str | None = None
    created_by_name: str | None = None
    created_on: datetime | None = None
