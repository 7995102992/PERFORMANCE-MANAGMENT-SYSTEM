from __future__ import annotations

from pydantic import BaseModel, Field


class UserBase(BaseModel):
    """Authenticated user resolved from the IAM-written Valkey session.

    Shape mirrors the sibling services (Timesheet / SRM) so payroll routes can
    depend on the same identity contract.
    """

    id: str
    organisation_id: str
    business_unit_id: str | None = None
    email: str | None = None
    display_name: str | None = None
    full_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    # Grants access to the admin payroll routers (uploads + payslip records).
    payslip_admin: bool = False
    auth_method: str | None = None
    permissions: dict = Field(default_factory=dict)
    roles: list[str] = Field(default_factory=list)
    access_token: str | None = None

    def has_permission(self, module: str, action: str) -> bool:
        entry = self.permissions.get(module)
        if not entry:
            return False
        return bool(entry.get("actions", {}).get(action))
