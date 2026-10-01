"""Read-only catalog services for acl / modules / permissions."""

from src.lookups.schemas import AclItem, ModuleCatalogItem, PermissionItem
from src.lookups.utils import tools as repo
from src.logger import logger
from src.models import AclRoleEnum, ModuleEnum, PermissionCodeEnum
from src.rabbitmq import DebugLevel, outbox


async def _get_enabled_modules(organisation_id: str | None) -> list[ModuleEnum] | None:
    """Return only active module codes for an org, or None if unscoped."""
    if not organisation_id:
        return None
    from src.modules.organisation.models import OrganisationDocument
    from beanie import PydanticObjectId
    org = await OrganisationDocument.get(PydanticObjectId(organisation_id))
    if not org:
        return []
    return [m.code for m in org.enabled_modules if m.is_active]


async def list_acl() -> list[AclItem]:
    rows = await repo.list_acl()
    return [
        AclItem(
            id=r["id"],
            role=AclRoleEnum(r["role"]),
            label=r["label"],
            rank=r["rank"],
        )
        for r in rows
    ]


async def list_modules(*, organisation_id: str | None = None) -> list[ModuleCatalogItem]:
    enabled = await _get_enabled_modules(organisation_id)
    rows = await repo.list_modules()
    items = [
        ModuleCatalogItem(
            id=r["id"],
            code=ModuleEnum(r["code"]),
            label=r["label"],
            description=r["description"],
            mandatory=r.get("mandatory", False),
        )
        for r in rows
    ]
    if enabled is not None:
        items = [i for i in items if i.code in enabled]
    return items


async def list_permissions(
    module: ModuleEnum | None = None,
    *,
    organisation_id: str | None = None,
    actor_id: str | None = None,
) -> list[PermissionItem]:
    enabled = await _get_enabled_modules(organisation_id)
    rows = await repo.list_permissions(module.value if module else None)
    items = []
    unrecognized = []
    for r in rows:
        try:
            item = PermissionItem(
                id=r["id"],
                module=ModuleEnum(r["module"]),
                code=PermissionCodeEnum(r["code"]),
                label=r["label"],
            )
        except ValueError:
            # Unknown module/code (e.g. newly added, not yet in the enum) — skip silently.
            unrecognized.append({"id": r.get("id"), "module": r.get("module"), "code": r.get("code")})
            continue
        items.append(item)
    if enabled is not None:
        items = [i for i in items if i.module in enabled]

    if unrecognized:
        logger.warning("Unrecognized permission rows filtered", filtered=unrecognized)
        await outbox.publish_audit_log(
            module="lookups",
            actor_id=actor_id or "system",
            action="permissions.unrecognized_filtered",
            resource="permissions",
            debug_level=DebugLevel.ADMIN,
            organisation_id=organisation_id,
            metadata={"filtered_permissions": unrecognized},
        )

    return items
