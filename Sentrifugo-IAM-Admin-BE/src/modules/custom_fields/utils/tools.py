import math
import re
from datetime import datetime, timezone
from typing import Optional

TEXT_MAX_LENGTH = 500
TEXTAREA_MAX_LENGTH = 5000

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.correlation import get_correlation_id
from src.modules.custom_fields.models import (
    MULTI_OPTION_TYPES,
    OPTION_FIELD_TYPES,
    SINGLE_OPTION_TYPES,
    CustomFieldDefinitionDocument,
    CustomFieldOptionDocument,
    CustomFieldValueDocument,
    EntityType,
    FieldType,
    SectionType,
)
from src.modules.custom_fields.schema import (
    DefinitionCreate,
    DefinitionUpdate,
    OptionCreate,
    OptionUpdate,
    ValueUpsert,
)

NOT_DELETED = {"deleted_on": None}


def _slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "_", slug)
    slug = slug.strip("_")
    return slug


# ---------------------------------------------------------------------------
# Definition Tools
# ---------------------------------------------------------------------------

class DefinitionTools:

    async def create(self, data: DefinitionCreate, organisation_id: PydanticObjectId) -> dict:
        key = _slugify(data.name)
        if not key:
            raise HTTPException(status_code=400, detail="Name must contain at least one alphanumeric character.")

        existing = await CustomFieldDefinitionDocument.find_one(
            {
                "organisation_id": organisation_id,
                "entity_type": data.entity_type.value,
                "key": key,
                "is_active": True,
                **NOT_DELETED,
            }
        )
        if existing:
            raise HTTPException(status_code=409, detail=f"Custom field with key '{key}' already exists for this entity type.")

        doc = CustomFieldDefinitionDocument(
            organisation_id=organisation_id,
            entity_type=data.entity_type,
            section=data.section,
            name=data.name.strip(),
            key=key,
            field_type=data.field_type,
            file_settings=data.file_settings,
            placeholder=data.placeholder,
            help_text=data.help_text,
            is_required=data.is_required,
            sort_order=data.sort_order,
            is_active=True,
            correlation_id=get_correlation_id(),
        )
        await doc.insert()
        return self._normalize(doc)

    async def get(self, def_id: PydanticObjectId) -> Optional[dict]:
        doc = await CustomFieldDefinitionDocument.find_one(
            CustomFieldDefinitionDocument.id == def_id, NOT_DELETED
        )
        if not doc:
            return None
        return self._normalize(doc)

    async def get_all(
        self,
        organisation_id: PydanticObjectId,
        entity_type: Optional[EntityType] = None,
        section: Optional[SectionType] = None,
        is_active: Optional[bool] = None,
    ) -> list[dict]:
        filters: dict = {"organisation_id": organisation_id, **NOT_DELETED}
        if entity_type:
            filters["entity_type"] = entity_type.value
        if section:
            filters["section"] = section.value
        if is_active is not None:
            filters["is_active"] = is_active

        docs = await CustomFieldDefinitionDocument.find(filters).sort("+sort_order").to_list()
        return [self._normalize(d) for d in docs]

    async def update(self, def_id: PydanticObjectId, data: DefinitionUpdate) -> Optional[dict]:
        doc = await CustomFieldDefinitionDocument.find_one(
            CustomFieldDefinitionDocument.id == def_id, NOT_DELETED
        )
        if not doc:
            return None

        update_data = data.model_dump(exclude_unset=True)

        new_section = update_data.get("section")
        if new_section is not None and doc.entity_type != EntityType.EMPLOYEE and new_section != SectionType.DEFAULT:
            raise HTTPException(
                status_code=400,
                detail="section must be 'default' for non-employee entity types",
            )

        new_field_type = update_data.get("field_type")
        if new_field_type is not None and new_field_type != doc.field_type:
            has_values = await CustomFieldValueDocument.find_one(
                {"field_definition_id": def_id, **NOT_DELETED}
            )
            if has_values:
                raise HTTPException(
                    status_code=409,
                    detail="Cannot change field type once values have been recorded. Delete the field or clear its values first.",
                )
            has_options = await CustomFieldOptionDocument.find_one(
                {"field_definition_id": def_id, "is_active": True, **NOT_DELETED}
            )
            if has_options:
                raise HTTPException(
                    status_code=409,
                    detail="Cannot change field type while options exist. Delete the options first.",
                )

        # file_settings must stay consistent with the effective field_type
        effective_ft = new_field_type if new_field_type is not None else doc.field_type
        fs_in_payload = "file_settings" in update_data
        new_fs = update_data.get("file_settings") if fs_in_payload else None
        if effective_ft == FieldType.FILE:
            if fs_in_payload and new_fs is None:
                raise HTTPException(
                    status_code=400,
                    detail="file_settings cannot be cleared for file field type",
                )
            if not fs_in_payload and doc.file_settings is None:
                raise HTTPException(
                    status_code=400,
                    detail="file_settings is required for file field type",
                )
        else:
            if fs_in_payload and new_fs is not None:
                raise HTTPException(
                    status_code=400,
                    detail="file_settings is only allowed for file field type",
                )
            if not fs_in_payload and doc.file_settings is not None:
                update_data["file_settings"] = None

        if "name" in update_data and update_data["name"]:
            new_key = _slugify(update_data["name"])
            existing = await CustomFieldDefinitionDocument.find_one(
                {
                    "organisation_id": doc.organisation_id,
                    "entity_type": doc.entity_type.value,
                    "key": new_key,
                    "is_active": True,
                    "_id": {"$ne": def_id},
                    **NOT_DELETED,
                }
            )
            if existing:
                raise HTTPException(status_code=409, detail=f"Custom field with key '{new_key}' already exists for this entity type.")
            update_data["key"] = new_key

        for k, v in update_data.items():
            setattr(doc, k, v)
        doc.correlation_id = get_correlation_id()
        await doc.save()
        return self._normalize(doc)

    async def delete(self, def_id: PydanticObjectId, actor_id: str) -> bool:
        doc = await CustomFieldDefinitionDocument.find_one(
            CustomFieldDefinitionDocument.id == def_id, NOT_DELETED
        )
        if not doc:
            return False

        now = datetime.now(timezone.utc)
        doc.deleted_on = now
        doc.deleted_by = actor_id
        doc.is_active = False
        doc.correlation_id = get_correlation_id()
        await doc.save()

        # Soft-delete all options for this definition
        options = await CustomFieldOptionDocument.find(
            {"field_definition_id": def_id, **NOT_DELETED}
        ).to_list()
        for opt in options:
            opt.deleted_on = now
            opt.deleted_by = actor_id
            opt.is_active = False
            await opt.save()

        # Soft-delete all values for this definition
        values = await CustomFieldValueDocument.find(
            {"field_definition_id": def_id, **NOT_DELETED}
        ).to_list()
        for val in values:
            val.deleted_on = now
            val.deleted_by = actor_id
            await val.save()

        return True

    async def reorder(self, items: list[dict], organisation_id: PydanticObjectId) -> bool:
        for item in items:
            doc = await CustomFieldDefinitionDocument.find_one(
                {
                    "_id": item["id"],
                    "organisation_id": organisation_id,
                    **NOT_DELETED,
                }
            )
            if doc:
                doc.sort_order = item["sort_order"]
                doc.correlation_id = get_correlation_id()
                await doc.save()
        return True

    @staticmethod
    def _normalize(doc: CustomFieldDefinitionDocument) -> dict:
        data = doc.model_dump()
        data["id"] = data.pop("_id", doc.id)
        return data


# ---------------------------------------------------------------------------
# Option Tools
# ---------------------------------------------------------------------------

class OptionTools:

    async def create(self, data: OptionCreate, field_definition_id: PydanticObjectId) -> dict:
        definition = await CustomFieldDefinitionDocument.find_one(
            CustomFieldDefinitionDocument.id == field_definition_id, NOT_DELETED
        )
        if not definition:
            raise HTTPException(status_code=404, detail="Custom field definition not found.")
        if definition.field_type not in OPTION_FIELD_TYPES:
            raise HTTPException(status_code=400, detail=f"Field type '{definition.field_type.value}' does not support options.")

        existing = await CustomFieldOptionDocument.find_one(
            {
                "field_definition_id": field_definition_id,
                "value": data.value,
                "is_active": True,
                **NOT_DELETED,
            }
        )
        if existing:
            raise HTTPException(status_code=409, detail=f"Option with value '{data.value}' already exists.")

        doc = CustomFieldOptionDocument(
            field_definition_id=field_definition_id,
            label=data.label.strip(),
            value=data.value.strip(),
            sort_order=data.sort_order,
            is_active=True,
            correlation_id=get_correlation_id(),
        )
        await doc.insert()
        return self._normalize(doc)

    async def get_all(self, field_definition_id: PydanticObjectId, is_active: Optional[bool] = None) -> list[dict]:
        filters: dict = {"field_definition_id": field_definition_id, **NOT_DELETED}
        if is_active is not None:
            filters["is_active"] = is_active

        docs = await CustomFieldOptionDocument.find(filters).sort("+sort_order").to_list()
        return [self._normalize(d) for d in docs]

    async def update(self, option_id: PydanticObjectId, data: OptionUpdate) -> Optional[dict]:
        doc = await CustomFieldOptionDocument.find_one(
            CustomFieldOptionDocument.id == option_id, NOT_DELETED
        )
        if not doc:
            return None

        update_data = data.model_dump(exclude_unset=True)

        if "value" in update_data and update_data["value"]:
            existing = await CustomFieldOptionDocument.find_one(
                {
                    "field_definition_id": doc.field_definition_id,
                    "value": update_data["value"],
                    "is_active": True,
                    "_id": {"$ne": option_id},
                    **NOT_DELETED,
                }
            )
            if existing:
                raise HTTPException(status_code=409, detail=f"Option with value '{update_data['value']}' already exists.")

        for k, v in update_data.items():
            setattr(doc, k, v)
        doc.correlation_id = get_correlation_id()
        await doc.save()
        return self._normalize(doc)

    async def delete(self, option_id: PydanticObjectId, actor_id: str) -> bool:
        doc = await CustomFieldOptionDocument.find_one(
            CustomFieldOptionDocument.id == option_id, NOT_DELETED
        )
        if not doc:
            return False

        doc.deleted_on = datetime.now(timezone.utc)
        doc.deleted_by = actor_id
        doc.is_active = False
        doc.correlation_id = get_correlation_id()
        await doc.save()
        return True

    async def reorder(self, items: list[dict], field_definition_id: PydanticObjectId) -> bool:
        for item in items:
            doc = await CustomFieldOptionDocument.find_one(
                {
                    "_id": item["id"],
                    "field_definition_id": field_definition_id,
                    **NOT_DELETED,
                }
            )
            if doc:
                doc.sort_order = item["sort_order"]
                doc.correlation_id = get_correlation_id()
                await doc.save()
        return True

    @staticmethod
    def _normalize(doc: CustomFieldOptionDocument) -> dict:
        data = doc.model_dump()
        data["id"] = data.pop("_id", doc.id)
        return data


# ---------------------------------------------------------------------------
# Value Tools
# ---------------------------------------------------------------------------

class ValueTools:

    async def get_entity_values(
        self,
        organisation_id: PydanticObjectId,
        entity_type: EntityType,
        entity_id: PydanticObjectId,
    ) -> dict:
        """Returns definitions + options + values for a single entity."""
        definitions = await CustomFieldDefinitionDocument.find(
            {
                "organisation_id": organisation_id,
                "entity_type": entity_type.value,
                "is_active": True,
                **NOT_DELETED,
            }
        ).sort("+sort_order").to_list()

        values = await CustomFieldValueDocument.find(
            {
                "organisation_id": organisation_id,
                "entity_id": entity_id,
                "entity_type": entity_type.value,
                **NOT_DELETED,
            }
        ).to_list()
        value_map = {str(v.field_definition_id): v for v in values}

        fields = []
        for defn in definitions:
            options = []
            if defn.field_type in OPTION_FIELD_TYPES:
                option_docs = await CustomFieldOptionDocument.find(
                    {"field_definition_id": defn.id, "is_active": True, **NOT_DELETED}
                ).sort("+sort_order").to_list()
                options = [OptionTools._normalize(o) for o in option_docs]

            val = value_map.get(str(defn.id))
            value_data = None
            if val:
                value_data = {
                    "id": val.id,
                    "field_definition_id": val.field_definition_id,
                    "value": val.value,
                    "option_ids": val.option_ids,
                }

            fields.append({
                "definition": DefinitionTools._normalize(defn),
                "options": options,
                "value": value_data,
            })

        return {
            "entity_id": entity_id,
            "entity_type": entity_type.value,
            "fields": fields,
        }

    async def bulk_upsert(
        self,
        organisation_id: PydanticObjectId,
        entity_type: EntityType,
        entity_id: PydanticObjectId,
        items: list[ValueUpsert],
        actor_id: str,
    ) -> list[dict]:
        """Validate the whole batch first, then write — no partial writes on failure."""
        cid = get_correlation_id()

        # Reject duplicate field_definition_ids in the same batch
        seen: set[PydanticObjectId] = set()
        for item in items:
            if item.field_definition_id in seen:
                raise HTTPException(
                    status_code=400,
                    detail=f"Duplicate field_definition_id '{item.field_definition_id}' in items.",
                )
            seen.add(item.field_definition_id)

        # Load all definitions for this entity in one query
        def_ids = [item.field_definition_id for item in items]
        definitions = await CustomFieldDefinitionDocument.find(
            {"_id": {"$in": def_ids}, "organisation_id": organisation_id, **NOT_DELETED}
        ).to_list()
        def_map = {d.id: d for d in definitions}

        # Preload allowed option ids for any option-type definitions in the batch
        option_def_ids = [d.id for d in definitions if d.field_type in OPTION_FIELD_TYPES]
        allowed_options_by_def: dict[PydanticObjectId, set[PydanticObjectId]] = {}
        if option_def_ids:
            option_docs = await CustomFieldOptionDocument.find(
                {
                    "field_definition_id": {"$in": option_def_ids},
                    "is_active": True,
                    **NOT_DELETED,
                }
            ).to_list()
            for opt in option_docs:
                allowed_options_by_def.setdefault(opt.field_definition_id, set()).add(opt.id)

        # Pass 1: validate every item — no DB writes
        for item in items:
            defn = def_map.get(item.field_definition_id)
            if not defn:
                raise HTTPException(status_code=400, detail=f"Definition '{item.field_definition_id}' not found.")

            # Definition's entity_type must match the URL's entity_type
            if defn.entity_type != entity_type:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{defn.name}' is defined for '{defn.entity_type.value}', not '{entity_type.value}'.",
                )

            # Type validation
            self._validate_value(defn, item)

            # Option ids must reference real, active options of this definition
            if item.option_ids:
                allowed = allowed_options_by_def.get(defn.id, set())
                invalid = [oid for oid in item.option_ids if oid not in allowed]
                if invalid:
                    raise HTTPException(
                        status_code=400,
                        detail=f"'{defn.name}' has invalid option ids: {[str(o) for o in invalid]}",
                    )

        # Pass 2: persist after the whole batch is known-good
        results = []
        for item in items:
            existing = await CustomFieldValueDocument.find_one(
                {
                    "field_definition_id": item.field_definition_id,
                    "entity_id": entity_id,
                    **NOT_DELETED,
                }
            )

            if existing:
                existing.value = item.value
                existing.option_ids = item.option_ids
                existing.modified_by = actor_id
                existing.modified_on = datetime.now(timezone.utc)
                existing.correlation_id = cid
                await existing.save()
                results.append(self._normalize(existing))
            else:
                doc = CustomFieldValueDocument(
                    organisation_id=organisation_id,
                    field_definition_id=item.field_definition_id,
                    entity_id=entity_id,
                    entity_type=entity_type,
                    value=item.value,
                    option_ids=item.option_ids,
                    created_by=actor_id,
                    created_on=datetime.now(timezone.utc),
                    correlation_id=cid,
                )
                await doc.insert()
                results.append(self._normalize(doc))

        return results

    async def delete_entity_values(
        self,
        entity_id: PydanticObjectId,
        actor_id: str,
        organisation_id: PydanticObjectId,
        entity_type: EntityType,
    ) -> int:
        """Soft-delete all custom field values for an entity (used when entity is deleted)."""
        now = datetime.now(timezone.utc)
        filters: dict = {
            "organisation_id": organisation_id,
            "entity_id": entity_id,
            "entity_type": entity_type.value,
            **NOT_DELETED,
        }
        values = await CustomFieldValueDocument.find(filters).to_list()

        for val in values:
            val.deleted_on = now
            val.deleted_by = actor_id
            await val.save()

        return len(values)

    def _validate_value(self, defn: CustomFieldDefinitionDocument, item: ValueUpsert) -> None:
        ft = defn.field_type

        # Required check
        if defn.is_required:
            if ft in OPTION_FIELD_TYPES and not item.option_ids:
                raise HTTPException(status_code=400, detail=f"'{defn.name}' is required — select at least one option.")
            if ft not in OPTION_FIELD_TYPES and not item.value:
                raise HTTPException(status_code=400, detail=f"'{defn.name}' is required.")

        # Option-based fields must use option_ids, not value
        if ft in OPTION_FIELD_TYPES:
            if item.value:
                raise HTTPException(status_code=400, detail=f"'{defn.name}' is an option field — use option_ids, not value.")
            if ft in SINGLE_OPTION_TYPES and len(item.option_ids) > 1:
                raise HTTPException(status_code=400, detail=f"'{defn.name}' allows only one selection.")

        # Non-option fields must use value, not option_ids
        if ft not in OPTION_FIELD_TYPES:
            if item.option_ids:
                raise HTTPException(status_code=400, detail=f"'{defn.name}' does not support options — use value instead.")

        # Type-specific format validation
        if item.value:
            if ft == FieldType.TEXT and len(item.value) > TEXT_MAX_LENGTH:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{defn.name}' must be at most {TEXT_MAX_LENGTH} characters.",
                )
            if ft == FieldType.TEXTAREA and len(item.value) > TEXTAREA_MAX_LENGTH:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{defn.name}' must be at most {TEXTAREA_MAX_LENGTH} characters.",
                )
            if ft == FieldType.NUMBER:
                try:
                    parsed = float(item.value)
                except ValueError:
                    raise HTTPException(status_code=400, detail=f"'{defn.name}' must be a valid number.")
                if not math.isfinite(parsed):
                    raise HTTPException(status_code=400, detail=f"'{defn.name}' must be a finite number.")
            elif ft == FieldType.DATE:
                try:
                    datetime.strptime(item.value, "%Y-%m-%d")
                except ValueError:
                    raise HTTPException(status_code=400, detail=f"'{defn.name}' must be a valid date (YYYY-MM-DD).")
            elif ft == FieldType.EMAIL:
                if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", item.value):
                    raise HTTPException(status_code=400, detail=f"'{defn.name}' must be a valid email address.")
            elif ft == FieldType.URL:
                if not re.match(r"^https?://\S+", item.value):
                    raise HTTPException(status_code=400, detail=f"'{defn.name}' must be a valid URL (starting with http/https).")
            elif ft == FieldType.PHONE:
                if not re.match(r"^\+?\d{10,15}$", item.value):
                    raise HTTPException(status_code=400, detail=f"'{defn.name}' must be a valid phone number (10-15 digits).")

    @staticmethod
    def _normalize(doc: CustomFieldValueDocument) -> dict:
        data = doc.model_dump()
        data["id"] = data.pop("_id", doc.id)
        return data


# ---------------------------------------------------------------------------
# Batch helper — attach custom fields to entity response dicts
# ---------------------------------------------------------------------------

async def attach_custom_fields(
    organisation_id: PydanticObjectId,
    entity_type: EntityType,
    entities: list[dict],
) -> None:
    """Attach custom_fields list to each entity dict in-place.

    All entities must belong to the same organisation. Uses exactly 3 queries
    regardless of list size (no N+1). Each entity dict must have an 'id' key.
    """
    if not entities:
        return

    definitions = await CustomFieldDefinitionDocument.find(
        {
            "organisation_id": organisation_id,
            "entity_type": entity_type.value,
            "is_active": True,
            **NOT_DELETED,
        }
    ).sort("+sort_order").to_list()

    if not definitions:
        for entity in entities:
            entity["custom_fields"] = []
        return

    def_ids = [d.id for d in definitions]

    all_options = await CustomFieldOptionDocument.find(
        {"field_definition_id": {"$in": def_ids}, "is_active": True, **NOT_DELETED}
    ).sort("+sort_order").to_list()

    options_by_def: dict[str, list] = {str(d.id): [] for d in definitions}
    for opt in all_options:
        key = str(opt.field_definition_id)
        if key in options_by_def:
            options_by_def[key].append(OptionTools._normalize(opt))

    entity_ids = [e["id"] for e in entities]
    all_values = await CustomFieldValueDocument.find(
        {
            "organisation_id": organisation_id,
            "entity_id": {"$in": entity_ids},
            "entity_type": entity_type.value,
            **NOT_DELETED,
        }
    ).to_list()

    values_map: dict[str, dict[str, dict]] = {}
    for val in all_values:
        eid = str(val.entity_id)
        did = str(val.field_definition_id)
        values_map.setdefault(eid, {})[did] = {
            "id": val.id,
            "field_definition_id": val.field_definition_id,
            "value": val.value,
            "option_ids": val.option_ids,
        }

    normalized_defs = [DefinitionTools._normalize(d) for d in definitions]

    for entity in entities:
        eid = str(entity["id"])
        entity_vals = values_map.get(eid, {})
        entity["custom_fields"] = [
            {
                "definition": nd,
                "options": options_by_def.get(str(nd["id"]), []),
                "value": entity_vals.get(str(nd["id"])),
            }
            for nd in normalized_defs
        ]
