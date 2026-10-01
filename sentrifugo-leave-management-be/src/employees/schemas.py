from typing import Optional

from pydantic import Field

from src.models import CustomModel


class ScopedEmployee(CustomModel):
    """An assignable employee, resolved entirely from the LMS mirror so the FE
    pickers no longer need to fetch the org from IAM and join client-side."""

    user_id: str
    name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    emp_code: Optional[str] = None
    work_email: Optional[str] = None
    department_id: Optional[str] = None
    department_name: Optional[str] = None
    business_unit_id: Optional[str] = None
    business_unit_name: Optional[str] = None
    designation_id: Optional[str] = None
    designation_name: Optional[str] = None
    employment_type_id: Optional[str] = None
    employment_type: Optional[str] = None
    employment_status_id: Optional[str] = None
    employment_status: Optional[str] = None


class ScopedEmployeeList(CustomModel):
    """Paged employee pool for the assignment pickers."""

    items: list[ScopedEmployee] = Field(default_factory=list)
    total: int = 0
    skip: int = 0
    limit: int = 0


class CrossAssignmentEntry(CustomModel):
    """One (user, other-scope-name) pairing — the FE groups these into a
    'also assigned to: X, Y' warning."""

    user_id: str
    scope_name: Optional[str] = None


class CrossAssignmentList(CustomModel):
    items: list[CrossAssignmentEntry] = Field(default_factory=list)
