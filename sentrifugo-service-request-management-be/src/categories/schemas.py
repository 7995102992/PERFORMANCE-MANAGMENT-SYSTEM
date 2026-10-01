"""Category schemas — Chapters 1 + 2."""
from __future__ import annotations

from datetime import datetime

from beanie import PydanticObjectId
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..common.validators import OptionalObjectId

from ..models import ExecutorRoleEnum, StatusEnum

# One document holds the whole roster, so it needs a ceiling. 200 is far above
# any real department and well under anything that would bloat the category doc.
MAX_EXECUTORS = 200


class CategoryExecutorIn(BaseModel):
    """One roster entry as sent by the client.

    Only the id and the tag are accepted — name/email are resolved server-side
    from IAM at save time and never trusted from the client.
    """

    user_id: PydanticObjectId
    role: ExecutorRoleEnum = ExecutorRoleEnum.SECONDARY


class CategoryExecutorOut(BaseModel):
    user_id: str
    role: ExecutorRoleEnum
    employee_id: str | None = None
    emp_code: str = ""
    name: str = ""
    email: str = ""
    department_id: str | None = None
    department_code: str = ""
    department_name: str = ""
    # True for a department head of one of the category's departments. They hold
    # the primary powers implicitly, so the UI renders them locked rather than
    # as a normal removable row. Derived, never stored.
    is_department_head: bool = False


def _validate_executors(
    v: list[CategoryExecutorIn] | None,
) -> list[CategoryExecutorIn] | None:
    """Reject a roster that is oversized, names someone twice, or has no primary.

    A user is primary *or* secondary, never both — deduping silently would pick
    a winner arbitrarily and hand someone powers the admin didn't intend.

    The primary rule is deliberately conditional on the roster being non-empty.
    An empty roster is not an incomplete one: it means nobody has been named and
    the category's departments staff it, which is what every category did before
    rosters existed (D4) and what most of them still do. Requiring a primary
    unconditionally would make those categories unsaveable — an admin correcting
    a typo in the description would first have to build a roster.

    Once someone *has* been named, though, the roster is a claim about who runs
    this category, and a claim with no primary is incoherent: primaries are who
    assign, reassign and escalate, so an all-secondary roster lists people to do
    the work and nobody to hand it out. Today a department head still covers
    that implicitly, which is exactly the problem — the screen would show no
    primary while the head quietly holds the powers.
    """
    if v is None:
        return v
    if len(v) > MAX_EXECUTORS:
        raise ValueError(f"At most {MAX_EXECUTORS} executors may be assigned to a category")
    seen: set[str] = set()
    for entry in v:
        uid = str(entry.user_id)
        if uid in seen:
            raise ValueError("An executor may appear only once — primary or secondary, not both")
        seen.add(uid)
    if v and not any(e.role == ExecutorRoleEnum.PRIMARY for e in v):
        raise ValueError(
            "A roster needs at least one primary executor — primaries are who "
            "assign, reassign and escalate. Leave the roster empty to let the "
            "whole department handle this category."
        )
    return v


class CategoryCreate(BaseModel):
    name: str = Field(min_length=3, max_length=100)
    description: str | None = Field(None, max_length=500)
    business_unit_id: PydanticObjectId
    # Departments whose employees staff this category. At least one; every one
    # must belong to business_unit_id.
    department_ids: list[PydanticObjectId] = Field(default_factory=list)
    # DEPRECATED — accepted for one release so older clients keep working. When
    # department_ids is absent this is promoted to [department_id]; see the
    # model validator below.
    department_id: OptionalObjectId = None
    # Restrict catalog visibility to the business unit(s) + department(s) below.
    restricted_visibility: bool = False
    # Multi-select visibility scope for restricted categories, ignored when
    # restricted_visibility is False. When restricted but left empty, the scope
    # falls back to the single home business_unit_id + department_id.
    visibility_business_unit_ids: list[PydanticObjectId] = Field(default_factory=list)
    visibility_department_ids: list[PydanticObjectId] = Field(default_factory=list)
    # Tagged executor roster. Omitted / empty keeps the category on legacy
    # behaviour (dept head holds the powers, whole department is the pool).
    executors: list[CategoryExecutorIn] = Field(default_factory=list)
    # DEPRECATED — accepted, stored, and never read. A category with a roster is
    # roster-only, full stop; see `resolve_workforce`. This used to decide
    # whether the departments counted as executors on top of the roster, and
    # defaulted to True-ish behaviour (False here = departments included), which
    # meant the default silently widened the pool past the people an admin
    # actually picked. Kept on the wire so existing clients don't 422.
    roster_is_exclusive: bool = False

    @field_validator("executors")
    @classmethod
    def _check_executors(cls, v: list[CategoryExecutorIn]) -> list[CategoryExecutorIn]:
        return _validate_executors(v) or []

    @model_validator(mode="after")
    def _normalise_departments(self) -> "CategoryCreate":
        """Accept either shape, always end up with a non-empty department_ids.

        Old clients send `department_id`; new ones send `department_ids`. A
        payload carrying neither is rejected here rather than at the database,
        because a category with no department has no executor pool, no
        escalation target and no queue.
        """
        if not self.department_ids and self.department_id:
            self.department_ids = [self.department_id]
        if not self.department_ids:
            raise ValueError("At least one department is required")
        seen: set[str] = set()
        deduped: list[PydanticObjectId] = []
        for d in self.department_ids:
            if str(d) not in seen:
                seen.add(str(d))
                deduped.append(d)
        self.department_ids = deduped
        self.department_id = deduped[0]
        return self

    @field_validator("name", mode="before")
    @classmethod
    def _strip_name(cls, v: str | None) -> str:
        return (v or "").strip()

    @field_validator("description", mode="before")
    @classmethod
    def _strip_desc(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


class CategoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=3, max_length=100)
    description: str | None = Field(None, max_length=500)
    business_unit_id: OptionalObjectId = None
    # Sent = replace the department list wholesale. Omit to leave it alone.
    department_ids: list[PydanticObjectId] | None = None
    # DEPRECATED — promoted to [department_id] when department_ids is absent.
    department_id: OptionalObjectId = None
    restricted_visibility: bool | None = None
    visibility_business_unit_ids: list[PydanticObjectId] | None = None
    visibility_department_ids: list[PydanticObjectId] | None = None
    # Fully replaces the stored roster when sent; omit to leave it untouched
    # (same contract as sla_rules on RequestTypeUpdate). Send [] to clear it.
    executors: list[CategoryExecutorIn] | None = None
    roster_is_exclusive: bool | None = None
    status: StatusEnum | None = None

    @field_validator("executors")
    @classmethod
    def _check_executors(
        cls, v: list[CategoryExecutorIn] | None
    ) -> list[CategoryExecutorIn] | None:
        return _validate_executors(v)

    @model_validator(mode="after")
    def _normalise_departments(self) -> "CategoryUpdate":
        """Promote a legacy scalar `department_id` and dedupe the list.

        An explicit empty list is rejected: clearing every department would
        leave the category with no executor pool and no escalation target.
        Omitting the field entirely (the common case) is untouched.
        """
        if self.department_ids is None and self.department_id is not None:
            self.department_ids = [self.department_id]
        if self.department_ids is not None:
            if not self.department_ids:
                raise ValueError("At least one department is required")
            seen: set[str] = set()
            deduped: list[PydanticObjectId] = []
            for d in self.department_ids:
                if str(d) not in seen:
                    seen.add(str(d))
                    deduped.append(d)
            self.department_ids = deduped
            self.department_id = deduped[0]
        return self

    @field_validator("name", mode="before")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    @field_validator("description", mode="before")
    @classmethod
    def _strip_desc(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


class CategoryOut(BaseModel):
    id: str
    organisation_id: PydanticObjectId
    name: str
    description: str | None = None
    department_ids: list[str] = Field(default_factory=list)
    department_names: list[str] = Field(default_factory=list)
    # DEPRECATED — department_ids[0]. Emitted so consumers that still read the
    # scalar (RequestTypeForm, WorkflowForm, other services) keep working while
    # they migrate. Nullable because an un-migrated document may lack it.
    department_id: PydanticObjectId | None = None
    department_name: str | None = None
    business_unit_id: PydanticObjectId
    business_unit_name: str | None = None
    restricted_visibility: bool = False
    visibility_business_unit_ids: list[str] = Field(default_factory=list)
    visibility_department_ids: list[str] = Field(default_factory=list)
    executors: list[CategoryExecutorOut] = Field(default_factory=list)
    roster_is_exclusive: bool = False
    status: StatusEnum
    created_by: PydanticObjectId | None = None
    created_on: datetime | None = None
    modified_by: PydanticObjectId | None = None
    modified_on: datetime | None = None


class CategoryListItem(CategoryOut):
    pass
