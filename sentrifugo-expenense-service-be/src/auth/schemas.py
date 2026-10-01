from __future__ import annotations

from pydantic import BaseModel, Field


class UserBase(BaseModel):
    """Authenticated user resolved from the IAM-written Valkey session.

    Shape mirrors the sibling services (Payroll / Timesheet / SRM) so expense
    routes can depend on the same identity contract. ``permissions`` carries
    IAM's nested policy grid and is read through :meth:`has_permission` by the
    gates in ``src.auth.utils.authorization``.
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
    auth_method: str | None = None
    permissions: dict = Field(default_factory=dict)
    roles: list[str] = Field(default_factory=list)
    access_token: str | None = None

    def has_permission(self, module: str, action: str) -> bool:
        """Check IAM's nested permission grid for ``permissions[module]["actions"][action]``.

        Args:
            module: The IAM permission module (e.g. ``"expense"``).
            action: The permission code within that module (e.g. ``"submit_expense"``).

        Returns:
            ``True`` when the session grants the action, otherwise ``False``.
        """
        entry = self.permissions.get(module)
        if not entry:
            return False
        return bool(entry.get("actions", {}).get(action))
