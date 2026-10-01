import re
from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from src.modules.organisation.models import AddressDocument
from src.modules.organisation.addresses.schema import AddressCreate, AddressUpdate

NOT_DELETED = {"deleted_on": None}


class AddressTools:
    async def create(self, data: AddressCreate) -> AddressDocument:
        address = AddressDocument(**data.model_dump())
        await address.insert()
        return address

    async def get(self, address_id: PydanticObjectId) -> Optional[AddressDocument]:
        return await AddressDocument.find_one(AddressDocument.id == address_id, NOT_DELETED)

    async def get_all(self, organisation_id: Optional[PydanticObjectId] = None, skip: int = 0, limit: int = 20, search: str = "") -> List[AddressDocument]:
        filters: dict = {**NOT_DELETED}
        if organisation_id:
            filters["organisation_id"] = organisation_id
        if search:
            filters["city"] = {"$regex": re.escape(search), "$options": "i"}
        return await AddressDocument.find(filters).skip(skip).limit(limit).to_list()

    async def update(self, address_id: PydanticObjectId, data: AddressUpdate) -> Optional[AddressDocument]:
        address = await self.get(address_id)
        if not address:
            return None
        update_data = data.model_dump(exclude_unset=True)
        if update_data:
            for key, value in update_data.items():
                setattr(address, key, value)
            await address.save()
        return address

    async def delete(self, address_id: PydanticObjectId, actor_id: str = "system") -> bool:
        address = await self.get(address_id)
        if not address:
            return False
        address.deleted_on = datetime.now(timezone.utc)
        address.deleted_by = actor_id
        await address.save()
        return True
