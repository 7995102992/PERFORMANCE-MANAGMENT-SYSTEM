from datetime import date
from typing import Optional

from pydantic import Field, model_validator

from src.holiday_plans.schemas import ReminderSettings
from src.models import AuditMixin, CustomModel


class ClassificationRef(CustomModel):
    id: str
    name: str
    color: str


class PaginatedHolidayResponse(CustomModel):
    items: list["HolidayResponse"]
    total: int
    page: int
    page_size: int


class HolidayCreate(CustomModel):
    plan_id: str
    name: str
    date: date
    classification_id: str
    applicable_department_ids: list[str] = Field(default_factory=list)
    business_unit_ids: list[str] = Field(default_factory=list)
    reminder: ReminderSettings = Field(default_factory=ReminderSettings)
    description: Optional[str] = None
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None

    @model_validator(mode="after")
    def _require_scope(self) -> "HolidayCreate":
        # Both axes are mandatory — mirrors the FE (HolidayForm requires a BU and a
        # department) and the plan-level rule. An empty department list would be read
        # downstream as "applies to ALL departments"; we forbid that ambiguous state
        # so every holiday is explicitly scoped.
        if len(self.business_unit_ids) < 1:
            raise ValueError("At least one business unit ID is required")
        if len(self.applicable_department_ids) < 1:
            raise ValueError("At least one department ID is required")
        return self


class BulkHolidayItem(CustomModel):
    name: str
    date: date
    classification_id: str
    applicable_department_ids: list[str] = Field(default_factory=list)
    business_unit_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_scope(self) -> "BulkHolidayItem":
        # Both axes mandatory (see HolidayCreate._require_scope). The file-based
        # importer back-fills the plan's full department list before constructing
        # these items, so a non-empty list is always present on that path.
        if len(self.business_unit_ids) < 1:
            raise ValueError("At least one business unit ID is required")
        if len(self.applicable_department_ids) < 1:
            raise ValueError("At least one department ID is required")
        return self


class BulkHolidayImport(CustomModel):
    plan_id: str
    holidays: list[BulkHolidayItem]


class BulkHolidayImportResponse(CustomModel):
    imported: int
    skipped: int
    skipped_dates: list[str] = Field(default_factory=list)


class SyncHolidaysScopeRequest(CustomModel):
    """Bulk-update the dept and/or BU scope of every holiday inside a plan.

    ``extend`` adds the listed dept IDs to each holiday's
    ``applicable_department_ids`` (dedup, idempotent).
    ``trim`` removes the listed dept IDs.
    ``bu_extend`` adds the listed BU IDs to each holiday's
    ``business_unit_ids`` (dedup, idempotent).
    ``bu_trim`` removes the listed BU IDs.
    If both extend and trim are supplied for the same axis, extend is applied
    first, then trim.
    """

    extend: list[str] = Field(default_factory=list)
    trim: list[str] = Field(default_factory=list)
    bu_extend: list[str] = Field(default_factory=list)
    bu_trim: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _at_least_one(self) -> "SyncHolidaysScopeRequest":
        if not self.extend and not self.trim and not self.bu_extend and not self.bu_trim:
            raise ValueError(
                "At least one of 'extend', 'trim', 'bu_extend', 'bu_trim' must be a non-empty list"
            )
        return self


class SyncHolidaysScopeResponse(CustomModel):
    extended: int
    trimmed: int
    orphaned: int
    bu_extended: int
    bu_trimmed: int
    bu_orphaned: int


class BulkHolidayFileRowResponse(CustomModel):
    """A single row result from bulk holiday file validation."""
    row_num: int
    name: Optional[str] = None
    year: Optional[str] = None
    date: Optional[str] = None
    classification: Optional[str] = None
    classification_id: Optional[str] = None
    description: Optional[str] = None
    status: str  # "valid" | "error" | "duplicate" | "year_mismatch"
    errors: list[str] = Field(default_factory=list)
    # When status == "year_mismatch", the date with the year shifted to the
    # plan year. The FE shows a confirm prompt; on confirm it imports using
    # this date.
    suggested_date: Optional[str] = None


class BulkHolidayFileSummary(CustomModel):
    total: int
    valid: int
    errors: int
    duplicates: int
    year_mismatches: int = 0


class BulkHolidayFileValidateResponse(CustomModel):
    rows: list[BulkHolidayFileRowResponse]
    summary: BulkHolidayFileSummary


class BulkHolidayFileImportItem(CustomModel):
    name: str
    date: date
    classification_id: str
    description: Optional[str] = None


class BulkHolidayFileImportRequest(CustomModel):
    holidays: list[BulkHolidayFileImportItem]


class HolidayUpdate(CustomModel):
    name: Optional[str] = None
    date: Optional[date] = None
    classification_id: Optional[str] = None
    applicable_department_ids: Optional[list[str]] = None
    business_unit_ids: Optional[list[str]] = None
    reminder: Optional[ReminderSettings] = None
    description: Optional[str] = None
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None


class HolidayResponse(AuditMixin):
    id: str = Field(alias="_id")
    plan_id: str
    org_id: str
    name: str
    date: date
    classification: Optional[ClassificationRef] = None
    applicable_department_ids: list[str] = Field(default_factory=list)
    business_unit_ids: list[str] = Field(default_factory=list)
    reminder: ReminderSettings = Field(default_factory=ReminderSettings)
    description: Optional[str] = None
    notify_employees: Optional[bool] = None
    reprocess_leaves: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "plan_id", "org_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        if "applicable_department_ids" in data:
            data["applicable_department_ids"] = [str(v) for v in data["applicable_department_ids"]]
        # Backward-compat: if a legacy doc only has the singular field, lift it.
        bu_ids = data.get("business_unit_ids")
        if not bu_ids and data.get("business_unit_id") is not None:
            data["business_unit_ids"] = [str(data["business_unit_id"])]
        elif bu_ids:
            data["business_unit_ids"] = [str(v) for v in bu_ids]
        cl = data.get("classification")
        if isinstance(cl, dict) and "_id" in cl:
            data["classification"] = {
                "id": str(cl["_id"]),
                "name": cl.get("name", ""),
                "color": cl.get("color", "#6b7280"),
            }
        return data
