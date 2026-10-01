from pydantic import Field, model_validator

from src.models import CustomModel


class ShiftAssignment(CustomModel):
    user_id: str = Field(min_length=1)
    shift_id: str = Field(min_length=1)


class ShiftAssignmentSyncPayload(CustomModel):
    assignments: list[ShiftAssignment]


class ShiftAssignmentResponse(CustomModel):
    user_id: str
    shift_id: str
    # Enriched from the LMS employee mirror so the shift board renders directly
    # from this response (no IAM employee fetch + client-side join).
    name: str | None = None
    emp_code: str | None = None
    work_email: str | None = None
    department_name: str | None = None
    business_unit_name: str | None = None
    designation_name: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _stringify_ids(cls, data: dict) -> dict:
        # Defense-in-depth: docs are stored with user_id as ObjectId and shift_id
        # as a 24-hex string. Pydantic v2 rejects raw ObjectId on a str field, so
        # coerce both here so callers can pass either form safely.
        if not isinstance(data, dict):
            return data
        for field in ("user_id", "shift_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        return data


class ShiftAssignmentSyncResult(CustomModel):
    updated: int


class ShiftAssignValidateRow(CustomModel):
    row_num: int
    status: str  # valid | error | duplicate | change
    user_id: str | None = None
    shift_id: str | None = None
    emp_code: str | None = None
    name: str | None = None
    shift_name: str | None = None
    current_shift_name: str | None = None  # set when status == "change"
    errors: list[str] = Field(default_factory=list)


class ShiftAssignValidateResult(CustomModel):
    total_rows: int
    valid_count: int
    change_count: int = 0
    error_count: int
    duplicate_count: int
    file_errors: list[str] = Field(default_factory=list)
    rows: list[ShiftAssignValidateRow]
