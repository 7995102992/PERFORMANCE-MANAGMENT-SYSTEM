"""RPC server — employee lookup by emp_code.

Listens on:  {ENVIRONMENT}.iam.rpc.employee_lookup.queue

Request payload:
    {
        "emp_codes": ["SIL-F001", "SIL-F002"],
        "organisation_id": "<oid>",
        "business_unit_id": "<oid>"   # optional filter
    }

Reply payload:
    {
        "correlation_id": "<from request>",
        "data": {
            "SIL-F001": {
                "user_id", "organisation_id", "business_unit_id",
                "employment_status", "full_name",
                "pan_no", "uan_number", "pf_no",
                "bank_name", "account_no", "ifsc_code"
            } | null,
            ...
        }
    }

Unknown / not-found emp_codes are returned as null. A lookup that FAILS is
reported via the envelope's ``error`` field with ``data: null`` — it must never
be flattened into all-null rows, or a transient database blip during a payroll
upload reads as "these employees do not exist" and the rows get rejected.

Delivery is at-least-once; the handler is stateless and idempotent.
"""
import asyncio
from typing import Optional

from beanie import PydanticObjectId
from pydantic import BaseModel, Field

from src.auth.models import UserDocument
from src.config import settings
from src.master_data.models import MasterDataDocument
from src.modules.organisation.models import BankDetails, EmployeeDocument, IdentityField
from src.rpc.server import RpcServer


class _EmpLookupView(BaseModel):
    emp_code: Optional[str] = None
    alias: Optional[str] = None
    user_id: Optional[PydanticObjectId] = None
    organisation_id: Optional[PydanticObjectId] = None
    business_unit_id: Optional[PydanticObjectId] = None
    employment_status: Optional[PydanticObjectId] = None
    identity_fields: list[IdentityField] = Field(default_factory=list)
    bank_details: Optional[BankDetails] = None

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.employee_lookup.queue"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_oid(val) -> Optional[PydanticObjectId]:
    try:
        return PydanticObjectId(val) if val else None
    except Exception:
        return None


def _identity_field(identity_fields: list, *labels: str) -> Optional[str]:
    """Extract value from identity_fields by label (case-insensitive)."""
    lower_labels = {lbl.lower() for lbl in labels}
    for field in identity_fields:
        if (field.label or "").lower() in lower_labels:
            return field.value or None
    return None


# ── Core lookup ───────────────────────────────────────────────────────────────

async def _lookup(emp_codes: list[str], organisation_id: str, business_unit_id: Optional[str]) -> dict:
    org_oid = _to_oid(organisation_id)
    bu_oid = _to_oid(business_unit_id)

    if not org_oid or not emp_codes:
        return {code: None for code in emp_codes}

    # Match on the primary emp_code OR the optional alias code — a requested code
    # that is actually an employee's alias still resolves.
    query: dict = {
        "$or": [{"emp_code": {"$in": emp_codes}}, {"alias": {"$in": emp_codes}}],
        "organisation_id": org_oid,
        "deleted_on": None,
    }
    if bu_oid:
        query["business_unit_id"] = bu_oid

    employees = await EmployeeDocument.find(query).project(_EmpLookupView).to_list()
    if not employees:
        return {code: None for code in emp_codes}

    # Bulk-fetch linked users and employment status master data
    user_ids = [e.user_id for e in employees if e.user_id]
    status_ids = [e.employment_status for e in employees if e.employment_status]

    users, statuses = await asyncio.gather(
        UserDocument.find({"_id": {"$in": user_ids}}).to_list(),
        MasterDataDocument.find({"_id": {"$in": status_ids}}).to_list(),
    )

    user_map = {u.id: u for u in users}
    status_map = {s.id: s for s in statuses}

    result = {code: None for code in emp_codes}
    for emp in employees:
        user = user_map.get(emp.user_id) if emp.user_id else None
        status_doc = status_map.get(emp.employment_status) if emp.employment_status else None
        bank = emp.bank_details

        full_name = None
        if user:
            full_name = f"{(user.first_name or '').strip()} {(user.last_name or '').strip()}".strip() or None

        entry = {
            "user_id": str(emp.user_id) if emp.user_id else None,
            "organisation_id": str(emp.organisation_id),
            "business_unit_id": str(emp.business_unit_id) if emp.business_unit_id else None,
            "employment_status": status_doc.value if status_doc else None,
            "full_name": full_name,
            "pan_no": _identity_field(emp.identity_fields, "PAN", "pan no", "pan number"),
            "uan_number": _identity_field(emp.identity_fields, "UAN", "uan number", "uan no"),
            "pf_no": _identity_field(emp.identity_fields, "PF", "pf no", "pf number", "provident fund no"),
            "bank_name": bank.bank_name if bank else None,
            "account_no": bank.account_number if bank else None,
            "ifsc_code": bank.ifsc_code if bank else None,
        }
        # Key by whichever requested code matched — the primary emp_code and/or
        # the alias (only codes actually asked for are ever set).
        if emp.emp_code in result:
            result[emp.emp_code] = entry
        if emp.alias and emp.alias in result:
            result[emp.alias] = entry

    return result


# ── Message handler ───────────────────────────────────────────────────────────

async def _handle(payload: dict) -> dict:
    """Resolve the requested emp_codes.

    Deliberately does NOT catch lookup failures: ``RpcServer`` turns an exception
    into an ``error`` envelope, which is what lets the caller distinguish a
    database failure from "none of these emp_codes exist".
    """
    return await _lookup(
        payload.get("emp_codes") or [],
        payload.get("organisation_id") or "",
        payload.get("business_unit_id"),
    )


# ── Lifecycle ─────────────────────────────────────────────────────────────────

_server = RpcServer(_QUEUE_NAME, _handle, log_name="employee_lookup")


def start_employee_lookup_rpc() -> None:
    _server.start()


async def stop_employee_lookup_rpc() -> None:
    await _server.stop()
