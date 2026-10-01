from typing import Optional
from beanie import PydanticObjectId
from pydantic import Field
from src.models import CustomModel

class AddressBase(CustomModel):
    organisation_id: Optional[PydanticObjectId] = None
    country: str = Field(min_length=1)
    state: str = Field(min_length=1)
    city: str = Field(min_length=1)
    zip_code: Optional[str] = None
    address_line_1: str = Field(min_length=1)
    address_line_2: Optional[str] = None

class AddressCreate(AddressBase):
    pass

class AddressResponse(AddressBase):
    id: PydanticObjectId

class AddressUpdate(CustomModel):
    country: Optional[str] = Field(None, min_length=1)
    state: Optional[str] = Field(None, min_length=1)
    city: Optional[str] = Field(None, min_length=1)
    zip_code: Optional[str] = None
    address_line_1: Optional[str] = Field(None, min_length=1)
    address_line_2: Optional[str] = None
