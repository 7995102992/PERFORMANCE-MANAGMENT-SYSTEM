"""Request / response schemas for the policy + grants model.

Shape recap:
  - A `PolicyDocument` is a named permission set; it doesn't embed any
    module or role data.
  - `ModuleAclPermissionDocument` rows are the atomic grants — one per
    (policy, module, acl_role, permission) combination that is granted.
  - The frontend sees and edits a 3D grid: module x role x permission.

Two editing flows are supported:
  - `POST /policies` — creates a policy with `name` + optional `seed_module_codes`.
    Each seed module populates a default grid (admin gets everything, editor
    gets read+update, viewer gets read). Without seeds, the policy starts
    with zero grants.
  - `PUT /policies/{id}/permissions` — takes the full grid back and diffs
    against current grants (inserts new, soft-deletes removed).
"""

from datetime import datetime
from typing import Optional

from pydantic import Field, field_validator

from src.models import CustomModel, ModuleEnum


# ---------------------------------------------------------------------------
# Grid read / write shapes
# ---------------------------------------------------------------------------
# role -> action -> bool
PermissionRoleMatrix = dict[str, dict[str, bool]]
# module -> role -> action -> bool
PermissionGrid = dict[str, PermissionRoleMatrix]


# ---------------------------------------------------------------------------
# Policy CRUD shapes
# ---------------------------------------------------------------------------
class PolicyCreate(CustomModel):
    """Create a new policy. Optionally seed its initial grant grid from one or more modules."""
    name: str = Field(min_length=1, max_length=200)
    is_role: bool = False
    is_active: bool = True
    organisation_id: str | None = None
    seed_module_codes: list[ModuleEnum] = Field(default_factory=list)
    permissions: PermissionGrid | None = None

    @field_validator("seed_module_codes", mode="before")
    @classmethod
    def _coerce_seeds(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            return [ModuleEnum(v)]
        return [ModuleEnum(item) if isinstance(item, str) else item for item in v]


class PolicyCopy(CustomModel):
    """Copy an existing policy's permission grid into a new policy."""
    name: str = Field(min_length=1, max_length=200)


class PolicyCopyModulePermissions(CustomModel):
    """Copy specific module permissions from a source policy into the target."""
    source_policy_id: str
    modules: list[str] = Field(min_length=1)


class PolicyUpdate(CustomModel):
    """Partial update of policy metadata. Grants are edited via the grid endpoint."""
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_active: Optional[bool] = None
    is_role: Optional[bool] = None


class PolicyResponse(CustomModel):
    """Full policy — metadata only. Use /policies/{id}/permissions for the grid."""
    id: str
    name: str
    is_role: bool = False
    is_active: bool = True
    organisation_id: str | None = None
    seed_module_codes: list[ModuleEnum] = Field(default_factory=list)
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None


class PolicyListItem(CustomModel):
    """Summary for list views."""
    id: str
    name: str
    is_role: bool = False
    is_active: bool = True
    organisation_id: str | None = None
    seed_module_codes: list[ModuleEnum] = Field(default_factory=list)
    created_on: datetime | None = None
    modified_on: datetime | None = None


class PolicyGridResponse(CustomModel):
    """Full (or partial) grant grid for a policy."""
    policy_id: str
    permissions: PermissionGrid


class PolicyGridUpdate(CustomModel):
    """Replace the policy's grant grid with the submitted one."""
    permissions: PermissionGrid
