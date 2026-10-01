"""Policy-domain Beanie ODM documents."""

from typing import Optional

from beanie import Document, PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, IndexModel

from src.models import AuditMixin


class PolicyDocument(Document, AuditMixin):
    """A named permission set. Grants live on ModuleAclPermissionDocument rows."""

    name: str
    is_role: bool = False
    is_active: bool = True
    organisation_id: Optional[PydanticObjectId] = None
    seed_module_codes: list[str] = Field(default_factory=list)

    class Settings:
        name = "policies"
        indexes = [
            IndexModel(
                [("name", ASCENDING), ("organisation_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("is_active", ASCENDING)]),
        ]


class ModuleAclPermissionDocument(Document, AuditMixin):
    """Junction: one row = (policy grants role-X the action-Y on module-Z).

    FKs use business codes (ModuleEnum / AclRoleEnum / PermissionCodeEnum
    values) since the lookup collections use those as their ids.
    """

    policy_id: PydanticObjectId
    module_id: str
    acl_id: str
    permission_id: str

    class Settings:
        name = "module_acl_permissions"
        indexes = [
            IndexModel([("policy_id", ASCENDING)]),
            IndexModel(
                [
                    ("policy_id", ASCENDING),
                    ("module_id", ASCENDING),
                    ("acl_id", ASCENDING),
                    ("permission_id", ASCENDING),
                ],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]
