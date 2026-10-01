"""Response schemas for the seeded lookup catalogs (acl / modules / permissions)."""

from src.models import AclRoleEnum, CustomModel, ModuleEnum, PermissionCodeEnum


class AclItem(CustomModel):
    """A top-level ACL role (admin / editor / viewer)."""
    id: str
    role: AclRoleEnum
    label: str
    rank: int


class ModuleCatalogItem(CustomModel):
    """A product module surfaced on the 'Add Organization' picker + policy UI.

    The `mandatory` flag drives the 'Core HR is mandatory' rule on the Add
    and Edit Organization screens — Core HR is shipped with mandatory=True.
    """
    id: str
    code: ModuleEnum
    label: str
    description: str
    mandatory: bool = False


class PermissionItem(CustomModel):
    """A module-scoped permission. id is "{module}:{code}"."""
    id: str
    module: ModuleEnum
    code: PermissionCodeEnum
    label: str
