from typing import Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


class ReminderSettings(CustomModel):
    enabled: bool = False
    days_before: int = 2


class HolidayPlanCreate(CustomModel):
    name: str
    year: int
    business_unit_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)
    reminder_settings: ReminderSettings = Field(default_factory=ReminderSettings)
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None


class HolidayPlanUpdate(CustomModel):
    name: Optional[str] = None
    year: Optional[int] = None
    business_unit_ids: Optional[list[str]] = None
    department_ids: Optional[list[str]] = None
    reminder_settings: Optional[ReminderSettings] = None
    is_active: Optional[bool] = None
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None


class HolidayPlanScopeUpdate(CustomModel):
    """Single atomic BU/dept scope edit: the plan fields + the FE-confirmed cascade
    (holiday re-scope + final employee membership) applied in ONE transaction.

    The FE still drives the confirmation/choices (which depts to drop, who to keep/
    add) and sends the resolved result here so plan + holidays + employees can never
    end up half-updated. extend/trim ids are dept/BU ids; member_user_ids is the
    FINAL desired membership (the BE diffs it against the current assignments)."""
    name: Optional[str] = None
    is_active: Optional[bool] = None
    business_unit_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)
    reminder_settings: Optional[ReminderSettings] = None
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None
    # Holiday re-scope (per the plan's BU/dept change)
    holiday_extend_dept_ids: list[str] = Field(default_factory=list)
    holiday_trim_dept_ids: list[str] = Field(default_factory=list)
    holiday_extend_bu_ids: list[str] = Field(default_factory=list)
    holiday_trim_bu_ids: list[str] = Field(default_factory=list)
    # Final desired employee membership after the scope change. ``None`` means
    # "leave assignments untouched" (e.g. a pure rename, or added depts the admin
    # chose NOT to auto-assign); an explicit list reconciles membership to exactly
    # that set. An empty list therefore intentionally clears all members.
    member_user_ids: Optional[list[str]] = None


class HolidayPlanScopeUpdateResult(CustomModel):
    extended: int = 0
    trimmed: int = 0
    orphaned: int = 0
    bu_extended: int = 0
    bu_trimmed: int = 0
    bu_orphaned: int = 0
    employees_added: int = 0
    employees_removed: int = 0
    employees_skipped: int = 0
    transactional: bool = True


class HolidayPlanSummary(CustomModel):
    id: str = Field(alias="_id")
    name: str
    is_active: bool = True

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if isinstance(data, dict) and data.get("_id") is not None:
            data["_id"] = str(data["_id"])
        return data


class EntityRef(CustomModel):
    id: str
    name: str


class DepartmentRef(CustomModel):
    id: str
    name: str
    # Primary BU the dept rolls up to in the IAM. ``business_unit_ids`` is the
    # full set of BUs the dept is linked to (primary may also appear there).
    # ``business_unit_name`` is the denormalised name of the primary BU so the
    # FE can render the canonical "<Primary BU> - <Dept>" label without a
    # secondary join to ``business_units``.
    business_unit_id: Optional[str] = None
    business_unit_name: Optional[str] = None
    business_unit_ids: list[str] = Field(default_factory=list)


class HolidayPlanResponse(AuditMixin):
    id: str = Field(alias="_id")
    org_id: str
    name: str
    year: int
    business_units: list[EntityRef] = Field(default_factory=list)
    departments: list[DepartmentRef] = Field(default_factory=list)
    reminder_settings: ReminderSettings = Field(default_factory=ReminderSettings)
    is_active: bool = True
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        # Aggregation already $toString-coerces nested ids in the happy path,
        # but a raw insert/find_one fallback could leak ObjectId — defend.
        bus = data.get("business_units")
        if isinstance(bus, list):
            for ref in bus:
                if isinstance(ref, dict) and ref.get("id") is not None and not isinstance(ref["id"], str):
                    ref["id"] = str(ref["id"])
        depts = data.get("departments")
        if isinstance(depts, list):
            for ref in depts:
                if not isinstance(ref, dict):
                    continue
                if ref.get("id") is not None and not isinstance(ref["id"], str):
                    ref["id"] = str(ref["id"])
                if ref.get("business_unit_id") is not None and not isinstance(ref["business_unit_id"], str):
                    ref["business_unit_id"] = str(ref["business_unit_id"])
                if ref.get("business_unit_name") is not None and not isinstance(ref["business_unit_name"], str):
                    ref["business_unit_name"] = str(ref["business_unit_name"])
                bu_ids = ref.get("business_unit_ids")
                if isinstance(bu_ids, list):
                    ref["business_unit_ids"] = [str(v) for v in bu_ids]
        return data
