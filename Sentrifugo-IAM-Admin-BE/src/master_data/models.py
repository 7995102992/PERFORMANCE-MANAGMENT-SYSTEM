from typing import Optional
from beanie import Document, PydanticObjectId
from pymongo import ASCENDING, IndexModel


class MasterDataDocument(Document):
    category: str
    key: str
    value: str
    organisation_id: Optional[PydanticObjectId] = None
    is_active: bool = True
    is_custom: bool = False

    class Settings:
        name = "master_data"
        indexes = [
            IndexModel([("category", ASCENDING), ("organisation_id", ASCENDING)]),
            IndexModel(
                [("category", ASCENDING), ("key", ASCENDING), ("organisation_id", ASCENDING)],
                unique=True,
            ),
        ]
