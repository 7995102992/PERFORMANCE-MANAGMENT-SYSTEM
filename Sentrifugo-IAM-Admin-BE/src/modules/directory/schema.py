"""Employee directory — PUBLIC, colleague-visible employee details only.

Deliberately excludes anything sensitive (CTC/salary, bank, identity numbers, DOB,
personal email/phone, addresses). Any authenticated employee can read this, scoped
to their own organisation.
"""
from datetime import date
from typing import Optional

from beanie import PydanticObjectId
from pydantic import Field

from src.models import CustomModel


class DirectoryEmployee(CustomModel):
    # Unique per row — use this as the list key, not userId (a rehire has
    # multiple employee records sharing one user account).
    id: Optional[str] = None
    user_id: PydanticObjectId = Field(alias="userId")
    emp_code: Optional[str] = Field(None, alias="empCode")
    first_name: Optional[str] = Field(None, alias="firstName")
    middle_name: Optional[str] = Field(None, alias="middleName")
    last_name: Optional[str] = Field(None, alias="lastName")
    full_name: Optional[str] = Field(None, alias="fullName")
    email: Optional[str] = None                                  # work email
    work_phone: Optional[str] = Field(None, alias="workPhone")
    work_phone_extension: Optional[str] = Field(None, alias="workPhoneExtension")
    avatar_url: Optional[str] = Field(None, alias="avatarUrl")
    avatar_asset_id: Optional[PydanticObjectId] = Field(None, alias="avatarAssetId")
    business_unit_name: Optional[str] = Field(None, alias="businessUnit")
    department_name: Optional[str] = Field(None, alias="department")
    designation_name: Optional[str] = Field(None, alias="designation")
    l1_manager_name: Optional[str] = Field(None, alias="l1Manager")
    l2_manager_name: Optional[str] = Field(None, alias="l2Manager")
    employment_type: Optional[str] = Field(None, alias="employmentType")
    employment_status: Optional[str] = Field(None, alias="employmentStatus")
    date_of_joining: Optional[date] = Field(None, alias="dateOfJoining")
    seat_location: Optional[str] = Field(None, alias="seatLocation")


class DirectoryListResponse(CustomModel):
    items: list[DirectoryEmployee] = Field(default_factory=list)
    total: int = 0
    skip: int = 0
    limit: int = 0
