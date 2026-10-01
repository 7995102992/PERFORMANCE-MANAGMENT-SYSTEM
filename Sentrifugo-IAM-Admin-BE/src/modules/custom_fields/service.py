"""Custom Fields service — orchestration layer between router and tools."""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.custom_fields.models import (
    CustomFieldDefinitionDocument,
    CustomFieldOptionDocument,
    EntityType,
    SectionType,
)
from src.modules.custom_fields.schema import (
    DefinitionCreate,
    DefinitionUpdate,
    OptionCreate,
    OptionUpdate,
    ReorderRequest,
    ValueUpsert,
)
from src.modules.custom_fields.utils.tools import DefinitionTools, OptionTools, ValueTools
from src.rabbitmq import DebugLevel, outbox

_def_tools = DefinitionTools()
_opt_tools = OptionTools()
_val_tools = ValueTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def _verify_option_org(option_id: PydanticObjectId, org_id: PydanticObjectId) -> None:
    option = await CustomFieldOptionDocument.find_one(
        CustomFieldOptionDocument.id == option_id, {"deleted_on": None}
    )
    if not option:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field option not found")
    defn = await CustomFieldDefinitionDocument.find_one(
        CustomFieldDefinitionDocument.id == option.field_definition_id, {"deleted_on": None}
    )
    if not defn or defn.organisation_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field option not found")


# ---------------------------------------------------------------------------
# Definition service
# ---------------------------------------------------------------------------

async def create_definition(data: DefinitionCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    created = await _def_tools.create(data, organisation_id=org_id)
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        action="definition_created",
        resource=f"custom_field_definition:{created.get('id')}",
        debug_level=DebugLevel.ADMIN,
    )
    return created


async def list_definitions(
    caller: UserBase,
    entity_type: Optional[EntityType] = None,
    section: Optional[SectionType] = None,
    is_active: Optional[bool] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _def_tools.get_all(
        organisation_id=org_id, entity_type=entity_type, section=section, is_active=is_active,
    )


async def get_definition(def_id: PydanticObjectId, caller: UserBase) -> dict:
    defn = await _def_tools.get(def_id)
    if not defn:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field definition not found")
    check_org_access(defn["organisation_id"], caller)
    return defn


async def update_definition(def_id: PydanticObjectId, data: DefinitionUpdate, caller: UserBase) -> dict:
    await get_definition(def_id, caller)
    updated = await _def_tools.update(def_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field definition not found")
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        action="definition_updated",
        resource=f"custom_field_definition:{def_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def delete_definition(def_id: PydanticObjectId, caller: UserBase) -> None:
    await get_definition(def_id, caller)
    await _def_tools.delete(def_id, actor_id=str(caller.id))
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        action="definition_deleted",
        resource=f"custom_field_definition:{def_id}",
        debug_level=DebugLevel.ADMIN,
    )


async def reorder_definitions(data: ReorderRequest, caller: UserBase) -> None:
    org_id = _resolve_org(caller)
    await _def_tools.reorder([{"id": i.id, "sort_order": i.sort_order} for i in data.items], org_id)
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="definitions_reordered",
        resource=f"organisation:{org_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"count": len(data.items)},
    )


# ---------------------------------------------------------------------------
# Option service
# ---------------------------------------------------------------------------

async def create_option(def_id: PydanticObjectId, data: OptionCreate, caller: UserBase) -> dict:
    await get_definition(def_id, caller)
    created = await _opt_tools.create(data, field_definition_id=def_id)
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        action="option_created",
        resource=f"custom_field_option:{created.get('id')}",
        debug_level=DebugLevel.ADMIN,
        metadata={"field_definition_id": str(def_id)},
    )
    return created


async def list_options(def_id: PydanticObjectId, caller: UserBase) -> list[dict]:
    await get_definition(def_id, caller)
    return await _opt_tools.get_all(field_definition_id=def_id, is_active=True)


async def update_option(option_id: PydanticObjectId, data: OptionUpdate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    await _verify_option_org(option_id, org_id)
    updated = await _opt_tools.update(option_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field option not found")
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="option_updated",
        resource=f"custom_field_option:{option_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def delete_option(option_id: PydanticObjectId, caller: UserBase) -> None:
    org_id = _resolve_org(caller)
    await _verify_option_org(option_id, org_id)
    deleted = await _opt_tools.delete(option_id, actor_id=str(caller.id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field option not found")
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="option_deleted",
        resource=f"custom_field_option:{option_id}",
        debug_level=DebugLevel.ADMIN,
    )


async def reorder_options(def_id: PydanticObjectId, data: ReorderRequest, caller: UserBase) -> None:
    await get_definition(def_id, caller)
    await _opt_tools.reorder([{"id": i.id, "sort_order": i.sort_order} for i in data.items], def_id)
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        action="options_reordered",
        resource=f"custom_field_definition:{def_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"count": len(data.items)},
    )


# ---------------------------------------------------------------------------
# Value service
# ---------------------------------------------------------------------------

async def get_entity_values(
    entity_type: EntityType,
    entity_id: PydanticObjectId,
    caller: UserBase,
) -> dict:
    org_id = _resolve_org(caller)
    return await _val_tools.get_entity_values(org_id, entity_type, entity_id)


async def upsert_entity_values(
    entity_type: EntityType,
    entity_id: PydanticObjectId,
    items: list[ValueUpsert],
    caller: UserBase,
) -> list[dict]:
    org_id = _resolve_org(caller)
    result = await _val_tools.bulk_upsert(
        organisation_id=org_id,
        entity_type=entity_type,
        entity_id=entity_id,
        items=items,
        actor_id=str(caller.id),
    )
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="values_upserted",
        resource=f"{entity_type.value}:{entity_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"count": len(items)},
    )
    return result


async def delete_entity_values(
    entity_type: EntityType,
    entity_id: PydanticObjectId,
    caller: UserBase,
) -> int:
    org_id = _resolve_org(caller)
    count = await _val_tools.delete_entity_values(
        entity_id,
        actor_id=str(caller.id),
        organisation_id=org_id,
        entity_type=entity_type,
    )
    await outbox.publish_audit_log(
        module="custom_fields",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="values_deleted",
        resource=f"{entity_type.value}:{entity_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"count": count},
    )
    return count
