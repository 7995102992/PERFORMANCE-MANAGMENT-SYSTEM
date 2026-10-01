"""Business logic for payslip-file uploads (the ``payslips_uploaded`` collection).

Files (CSV/XLS/XLSX) are streamed to DigitalOcean Spaces; only metadata —
filename, object key, period, version, tenant, audit — is persisted to Mongo.

Everything is tenant-scoped: reads are filtered by ``organisation_id`` +
``business_unit_id`` and writes are stamped with them, so one business unit never
sees or collides with another's uploads. Within a tenant, uploads for a given
month/year are versioned: ``create_upload`` writes v1, ``update_upload`` appends
v(n+1) and keeps prior versions for history/audit.
"""

from __future__ import annotations

import csv
import io
import os
import re
import zipfile
from datetime import UTC, datetime
from uuid import uuid4

import openpyxl
from beanie import PydanticObjectId
from beanie.operators import And, In, Or, RegEx
from fastapi import UploadFile, status
from pymongo.errors import DuplicateKeyError

from src import storage
from src.auth.schemas import UserBase
from src.config import settings
from src.security import crypto
from src.correlation import get_actor_id
from src.exceptions import DomainException, NotFound
from src.logger import logger
from src.payslips import constants, importer, pdf, pin_service
from src.payslips.models import PayslipDocument, UploadedPayslipDocument
from src.payslips.schemas import (
    Deductions,
    Earnings,
    MyPayslipListItem,
    MyPayslipListResponse,
    PayslipImportResult,
    PayslipListItem,
    PayslipListResponse,
    PayrollSummary,
    PayslipSummaryChart,
    PayslipSummaryPoint,
    PayslipValidationResult,
    UploadedPayslipListItem,
    UploadedPayslipListResponse,
    UploadedPayslipRead,
)

__all__ = [
    "build_template_xlsx",
    "validate_upload",
    "create_upload",
    "update_upload",
    "get_upload",
    "download_upload_file",
    "list_uploads",
    "list_uploads_page",
    "backfill_upload_statuses",
    "list_payslips",
    "export_payslips_csv",
    "export_payslips_pdf",
    "get_my_payslip",
    "view_my_payslip_html",
    "export_my_payslip_pdf",
    "export_my_payslips_bulk",
    "payroll_summary",
    "my_payroll_summary",
    "payslip_summary_chart",
    "my_payslip_summary_chart",
    "my_payslip_list",
    "to_read",
]

# Top-right dropdown -> number of trailing months in the summary chart window.
_CHART_RANGE_MONTHS = {"1y": 12, "6m": 6, "3m": 3}

# Per-component YTD keys in the encrypted `extra` snapshot. Gross YTD = sum of the
# earning YTDs; Net YTD = earning YTDs minus deduction YTDs (there is no single
# gross/net YTD column in the sheet). Absent entirely on legacy (no-YTD) uploads.
_EARNING_YTD_KEYS = ("basic_ytd", "hra_ytd", "arrears_ytd", "lta_ytd", "incentive_projects_allowance_ytd")
_DEDUCTION_YTD_KEYS = (
    "income_tax_ytd",
    "professional_tax_ytd",
    "provident_fund_ytd",
    "health_insurance_premium_ytd",
    "gmc_premium_ytd",
    "salary_advance_ytd",
)

# Month index -> display name, for the pay-period label and period search.
_MONTH_NAMES = (
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
# Full and 3-letter month names -> month number, for "pay period" search.
_MONTH_LOOKUP = {name.lower(): i for i, name in enumerate(_MONTH_NAMES) if name}
_MONTH_LOOKUP.update({name[:3].lower(): i for i, name in enumerate(_MONTH_NAMES) if name})


def build_template_xlsx(month: int | None = None, year: int | None = None) -> bytes:
    """Render the blank fill-in xlsx template (one sheet, header row only).

    For a period at or before the legacy cutoff (``month``/``year`` <= May 2026)
    the old salary-register columns are emitted; otherwise the current template.
    When the period is omitted the current template is returned.
    """
    old = month is not None and year is not None and constants.uses_old_template(year, month)
    headers = constants.TEMPLATE_HEADERS_OLD if old else constants.TEMPLATE_HEADERS
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = constants.TEMPLATE_SHEET_NAME
    sheet.append(headers)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _bad_request(message: str, code: str = "INVALID_UPLOAD") -> DomainException:
    return DomainException(message, code, status.HTTP_400_BAD_REQUEST)


def _conflict(message: str) -> DomainException:
    return DomainException(message, "PAYSLIP_UPLOAD_CONFLICT", status.HTTP_409_CONFLICT)


def _actor_oid() -> PydanticObjectId | None:
    """The acting user's id as an ObjectId (None for the 'system' sentinel)."""
    actor = get_actor_id()
    return PydanticObjectId(actor) if PydanticObjectId.is_valid(actor) else None


async def _read_and_validate(file: UploadFile) -> bytes:
    """Read the upload into memory after checking extension, emptiness, and size."""
    name = (file.filename or "").strip()
    if not name:
        raise _bad_request("A file must be provided")
    ext = os.path.splitext(name)[1].lower()
    if ext not in constants.ALLOWED_EXTENSIONS:
        raise _bad_request(
            f"Unsupported file type '{ext or 'unknown'}'. Allowed: {', '.join(sorted(constants.ALLOWED_EXTENSIONS))}",
            "UNSUPPORTED_FILE_TYPE",
        )
    body = await file.read()
    if not body:
        raise _bad_request("Uploaded file is empty")
    if len(body) > constants.MAX_UPLOAD_BYTES:
        raise _bad_request(
            f"File exceeds the {constants.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
            "FILE_TOO_LARGE",
        )
    return body


def _object_key(
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    year: int,
    month: int,
    version: int,
    filename: str,
) -> str:
    safe = os.path.basename(filename or "upload").replace(" ", "_")
    folder = settings.DO_SPACES_FOLDER.strip("/")
    return (
        f"{folder}/payslips_uploaded/{organisation_id}/{business_unit_id}"
        f"/{year}/{month:02d}/v{version}/{uuid4().hex}_{safe}"
    )


async def _latest(
    organisation_id: PydanticObjectId, business_unit_id: PydanticObjectId, month: int, year: int
) -> UploadedPayslipDocument | None:
    return (
        await UploadedPayslipDocument.find(
            UploadedPayslipDocument.organisation_id == organisation_id,
            UploadedPayslipDocument.business_unit_id == business_unit_id,
            UploadedPayslipDocument.month == month,
            UploadedPayslipDocument.year == year,
        )
        .sort(-UploadedPayslipDocument.version)
        .first_or_none()
    )


async def _store(
    file: UploadFile,
    body: bytes,
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int,
    year: int,
    version: int,
    reason: str | None,
) -> UploadedPayslipDocument:
    key = _object_key(organisation_id, business_unit_id, year, month, version, file.filename or "upload")
    # Encrypt the file at rest; the object is opaque ciphertext in storage and is
    # decrypted only when downloaded back through the API.
    await storage.upload_bytes(key, crypto.encrypt_bytes(body), "application/octet-stream")
    doc = UploadedPayslipDocument(
        organisation_id=organisation_id,
        business_unit_id=business_unit_id,
        file_name=os.path.basename(file.filename or "upload"),
        path=key,
        month=month,
        year=year,
        version=version,
        reason=reason,
        uploaded_by=_actor_oid(),
        uploaded_on=datetime.now(UTC),
    )
    try:
        await doc.insert()
    except DuplicateKeyError as exc:
        # Lost a version race — drop the just-uploaded object so we don't orphan it.
        await storage.delete_object(key)
        raise _conflict(f"Version {version} already exists for {month:02d}/{year}; please retry.") from exc
    logger.info(
        "payslip_upload.stored",
        organisation_id=str(organisation_id),
        business_unit_id=str(business_unit_id),
        month=month,
        year=year,
        version=version,
        key=key,
    )
    return doc


def _status_from_result(result: PayslipImportResult) -> str:
    """Map an import outcome to the stored upload status.

    ``skipped`` (file unreadable) -> failed; a ``completed`` run that populated at
    least one row -> processed; everything else (``deferred`` while IAM was down,
    or completed-but-nothing-populated) stays ``uploaded`` for a later retry.
    """
    if result.status == "skipped":
        return constants.UPLOAD_STATUS_FAILED
    if result.status == "completed" and (result.created + result.updated) > 0:
        return constants.UPLOAD_STATUS_PROCESSED
    return constants.UPLOAD_STATUS_UPLOADED


async def _apply_status(doc: UploadedPayslipDocument, result: PayslipImportResult) -> None:
    """Persist the populate outcome as the upload's status."""
    doc.status = _status_from_result(result)
    await doc.save()


async def create_upload(
    file: UploadFile,
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int,
    year: int,
    reason: str | None,
) -> tuple[UploadedPayslipDocument, PayslipImportResult]:
    """POST — create the first upload (version 1) and populate the payslips."""
    body = await _read_and_validate(file)
    if await _latest(organisation_id, business_unit_id, month, year) is not None:
        raise _conflict(f"An upload already exists for {month:02d}/{year}. Use PUT to add a new version.")
    doc = await _store(file, body, organisation_id, business_unit_id, month, year, 1, reason)
    result = await importer.populate_from_upload(doc, body, organisation_id, business_unit_id)
    await _apply_status(doc, result)
    return doc, result


async def update_upload(
    file: UploadFile,
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int,
    year: int,
    reason: str,
) -> tuple[UploadedPayslipDocument, PayslipImportResult]:
    """PUT — append a new version (previous + 1) and re-populate the payslips.

    A non-empty ``reason`` is mandatory.
    """
    reason = (reason or "").strip()
    if not reason:
        raise _bad_request("A reason is required when updating a payslip upload", "REASON_REQUIRED")
    body = await _read_and_validate(file)
    latest = await _latest(organisation_id, business_unit_id, month, year)
    if latest is None:
        raise NotFound(f"No existing upload for {month:02d}/{year}. Use POST to create the first version.")
    doc = await _store(file, body, organisation_id, business_unit_id, month, year, latest.version + 1, reason)
    result = await importer.populate_from_upload(doc, body, organisation_id, business_unit_id)
    await _apply_status(doc, result)
    return doc, result


async def validate_upload(
    file: UploadFile,
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None = None,
    year: int | None = None,
) -> PayslipValidationResult:
    """Dry-run validate a salary workbook (per-row status/issues); nothing is stored.

    When ``month``/``year`` fall at or before May 2026 the file is validated
    against the legacy column set, so its ``missing_columns`` reflect that template.
    """
    body = await _read_and_validate(file)
    old_template = month is not None and year is not None and constants.uses_old_template(year, month)
    return await importer.validate_workbook(body, organisation_id, business_unit_id, old_template=old_template)


async def get_upload(
    upload_id: str, organisation_id: PydanticObjectId, business_unit_id: PydanticObjectId
) -> UploadedPayslipDocument:
    """GET one upload by id, scoped to the caller's tenant.

    A record owned by another org/business unit is reported as ``404`` (not
    ``403``) so existence never leaks across tenants.
    """
    try:
        oid = PydanticObjectId(upload_id)
    except (ValueError, TypeError) as exc:
        raise _bad_request("Invalid upload id", "INVALID_ID") from exc
    doc = await UploadedPayslipDocument.get(oid)
    if doc is None or doc.organisation_id != organisation_id or doc.business_unit_id != business_unit_id:
        raise NotFound("Payslip upload not found")
    return doc


async def list_uploads(
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None,
    year: int | None,
    latest_only: bool,
    limit: int,
) -> list[UploadedPayslipDocument]:
    """GET many for the caller's tenant — newest first, optionally by period.

    ``latest_only`` returns just the highest version and requires both
    ``month`` and ``year``.
    """
    if latest_only:
        if month is None or year is None:
            raise _bad_request("latest_only requires both month and year", "MISSING_PERIOD")
        latest = await _latest(organisation_id, business_unit_id, month, year)
        return [latest] if latest else []

    conditions = [
        UploadedPayslipDocument.organisation_id == organisation_id,
        UploadedPayslipDocument.business_unit_id == business_unit_id,
    ]
    if month is not None:
        conditions.append(UploadedPayslipDocument.month == month)
    if year is not None:
        conditions.append(UploadedPayslipDocument.year == year)
    return (
        await UploadedPayslipDocument.find(*conditions)
        .sort(
            -UploadedPayslipDocument.year,
            -UploadedPayslipDocument.month,
            -UploadedPayslipDocument.version,
        )
        .limit(limit)
        .to_list()
    )


def to_read(doc: UploadedPayslipDocument) -> UploadedPayslipRead:
    """Project a document to its API shape with a presigned download URL."""
    return UploadedPayslipRead(
        id=str(doc.id),
        organisation_id=str(doc.organisation_id),
        business_unit_id=str(doc.business_unit_id),
        file_name=doc.file_name,
        path=doc.path,
        month=doc.month,
        year=doc.year,
        version=doc.version,
        reason=doc.reason,
        uploaded_by=str(doc.uploaded_by) if doc.uploaded_by else None,
        uploaded_on=doc.uploaded_on,
        download_url=f"{settings.API_PREFIX}/payslips/uploads/{doc.id}/download",
    )


async def download_upload_file(
    upload_id: str, organisation_id: PydanticObjectId, business_unit_id: PydanticObjectId
) -> tuple[bytes, str]:
    """Fetch a stored upload, decrypt it, and return ``(plaintext_bytes, file_name)``.

    Tenant-scoped via :func:`get_upload` (404 for another tenant's file). Objects
    stored before encryption pass through unchanged (see ``crypto.decrypt_bytes``).
    """
    doc = await get_upload(upload_id, organisation_id, business_unit_id)
    encrypted = await storage.download_bytes(doc.path)
    return crypto.decrypt_bytes(encrypted), doc.file_name


# ── Payslip-uploads management list (the upload-history screen) ───────────────


async def _upload_aggregates(file_ids: list[PydanticObjectId]) -> dict[str, tuple[int, float]]:
    """Count + net-pay total of the payslips each upload populated.

    One batch query over ``payslips`` keyed by ``payslip_file_id``; net pay lives
    in the encrypted ``extra`` snapshot, so it's decrypted per row here. Returns
    ``{upload_id: (record_count, net_total)}`` (absent uploads imply 0/0.0).
    """
    if not file_ids:
        return {}
    docs = await PayslipDocument.find(In(PayslipDocument.payslip_file_id, file_ids)).to_list()
    agg: dict[str, tuple[int, float]] = {}
    for doc in docs:
        key = str(doc.payslip_file_id)
        count, net = agg.get(key, (0, 0.0))
        value = doc.decrypt_extra().get("net_salary")
        agg[key] = (count + 1, net + (float(value) if isinstance(value, (int, float)) else 0.0))
    return agg


def _to_upload_list_item(doc: UploadedPayslipDocument, agg: tuple[int, float] | None) -> UploadedPayslipListItem:
    """Project an upload + its aggregates to a management-list row."""
    count, net_total = agg or (0, 0.0)
    # Legacy rows predate the stored status; treat any with populated payslips as
    # processed so the screen isn't stuck showing "uploaded".
    status = doc.status
    if status == constants.UPLOAD_STATUS_UPLOADED and count > 0:
        status = constants.UPLOAD_STATUS_PROCESSED
    month_label = _MONTH_NAMES[doc.month] if 1 <= doc.month <= 12 else str(doc.month)
    return UploadedPayslipListItem(
        id=str(doc.id),
        file_name=doc.file_name,
        month=doc.month,
        year=doc.year,
        period_label=f"{month_label} {doc.year}",
        version=doc.version,
        no_of_records=count,
        net_total=round(net_total, 2),
        avg_net=round(net_total / count, 2) if count else 0.0,
        status=status,
        reason=doc.reason,
        uploaded_by=str(doc.uploaded_by) if doc.uploaded_by else None,
        uploaded_on=doc.uploaded_on,
        download_url=f"{settings.API_PREFIX}/payslips/uploads/{doc.id}/download",
    )


def _period_search_branch(search: str):
    """A Mongo OR-branch matching ``search`` as a pay period, or ``None``.

    Recognises a 4-digit year and/or a month name/number so "May 2026", "may",
    or "2026" narrow by period alongside the file-name match.
    """
    tokens = re.findall(r"[A-Za-z]+|\d+", search.lower())
    month = year = None
    for token in tokens:
        if token.isdigit():
            if len(token) == 4:
                year = int(token)
            elif month is None and 1 <= int(token) <= 12:
                month = int(token)
        elif token in _MONTH_LOOKUP:
            month = _MONTH_LOOKUP[token]
    if month and year:
        return And(UploadedPayslipDocument.month == month, UploadedPayslipDocument.year == year)
    if year:
        return UploadedPayslipDocument.year == year
    if month:
        return UploadedPayslipDocument.month == month
    return None


async def list_uploads_page(
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None,
    year: int | None,
    status: str | None,
    search: str | None,
    page: int,
    page_size: int,
) -> UploadedPayslipListResponse:
    """Paginated upload-history list for the management screen.

    Tenant-scoped and newest-first. ``year``/``month``/``status`` filter exactly;
    ``search`` matches the file name or the pay period (e.g. "May 2026"). Each row
    carries live aggregates (record count, net total, average net) over the
    payslips the upload populated.
    """
    if status is not None and status not in constants.UPLOAD_STATUSES:
        raise _bad_request(f"Unknown status '{status}'. Allowed: {', '.join(constants.UPLOAD_STATUSES)}", "INVALID_STATUS")

    conditions = [
        UploadedPayslipDocument.organisation_id == organisation_id,
        UploadedPayslipDocument.business_unit_id == business_unit_id,
    ]
    if month is not None:
        conditions.append(UploadedPayslipDocument.month == month)
    if year is not None:
        conditions.append(UploadedPayslipDocument.year == year)
    if status is not None:
        conditions.append(UploadedPayslipDocument.status == status)
    if search and search.strip():
        term = search.strip()
        name_match = RegEx(UploadedPayslipDocument.file_name, re.escape(term), options="i")
        period = _period_search_branch(term)
        conditions.append(Or(name_match, period) if period is not None else name_match)

    query = UploadedPayslipDocument.find(*conditions)
    total = await query.count()
    docs = (
        await query.sort(
            -UploadedPayslipDocument.year,
            -UploadedPayslipDocument.month,
            -UploadedPayslipDocument.version,
        )
        .skip((page - 1) * page_size)
        .limit(page_size)
        .to_list()
    )
    agg = await _upload_aggregates([doc.id for doc in docs])
    return UploadedPayslipListResponse(
        items=[_to_upload_list_item(doc, agg.get(str(doc.id))) for doc in docs],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=(total + page_size - 1) // page_size if page_size else 0,
    )


async def backfill_upload_statuses() -> dict[str, int]:
    """Set ``status`` on uploads created before the field existed (run once).

    Those documents load with the default ``"uploaded"`` because Mongo has no
    ``status`` field, so a ``status=processed`` filter never matches them. This
    walks every upload and stamps ``processed`` when it populated payslips, else
    ``uploaded``; documents already marked ``processed``/``failed`` are left as-is.
    Returns a small tally of the outcome.
    """
    tally = {"processed": 0, "uploaded": 0, "unchanged": 0}
    async for doc in UploadedPayslipDocument.find_all():
        if doc.status in (constants.UPLOAD_STATUS_PROCESSED, constants.UPLOAD_STATUS_FAILED):
            tally["unchanged"] += 1
            continue
        count = await PayslipDocument.find(PayslipDocument.payslip_file_id == doc.id).count()
        new_status = constants.UPLOAD_STATUS_PROCESSED if count else constants.UPLOAD_STATUS_UPLOADED
        doc.status = new_status
        await doc.save()
        tally[new_status] += 1
    logger.info("payslip_upload.status_backfill", **tally)
    return tally


def _sum_keys(extra: dict, keys: tuple[str, ...]) -> float:
    """Sum the given amount keys from a decrypted ``extra`` snapshot (missing -> 0)."""
    return sum(float(v) for k in keys if isinstance(v := extra.get(k), (int, float)))


async def _payroll_summary(scope: list) -> PayrollSummary:
    """Summary card for the latest payroll period within ``scope`` (find filters).

    ``scope`` selects the population — an organisation for the admin card, or a
    single ``user_id`` for self-service. Picks the latest ``(year, month)`` present
    and sums gross/net across its payslips; YTD comes from the sheet's per-component
    YTD columns (``null`` for legacy no-YTD periods). Empty card when nothing matches.
    """
    latest = (
        await PayslipDocument.find(*scope)
        .sort(-PayslipDocument.year, -PayslipDocument.month)
        .first_or_none()
    )
    if latest is None:
        return PayrollSummary()

    year, month = latest.year, latest.month
    docs = await PayslipDocument.find(
        *scope,
        PayslipDocument.year == year,
        PayslipDocument.month == month,
    ).to_list()

    has_ytd = not constants.uses_old_template(year, month)
    gross = net = earn_ytd = ded_ytd = 0.0
    for doc in docs:
        earnings = doc.decrypt_earnings()
        extra = doc.decrypt_extra()
        if earnings is not None:
            gross += earnings.total
        net_value = extra.get("net_salary")
        if isinstance(net_value, (int, float)):
            net += float(net_value)
        if has_ytd:
            earn_ytd += _sum_keys(extra, _EARNING_YTD_KEYS)
            ded_ytd += _sum_keys(extra, _DEDUCTION_YTD_KEYS)

    month_label = _MONTH_NAMES[month] if 1 <= month <= 12 else str(month)
    return PayrollSummary(
        month=month,
        year=year,
        period_label=f"{month_label} {year}",
        total_gross_pay=round(gross, 2),
        total_gross_pay_ytd=round(earn_ytd, 2) if has_ytd else None,
        total_net_pay=round(net, 2),
        total_net_pay_ytd=round(earn_ytd - ded_ytd, 2) if has_ytd else None,
        no_of_employees=len(docs),
    )


async def payroll_summary(organisation_id: PydanticObjectId) -> PayrollSummary:
    """Org-wide summary card for the organisation's latest payroll period."""
    return await _payroll_summary([PayslipDocument.organisation_id == organisation_id])


async def my_payroll_summary(user_id: str) -> PayrollSummary:
    """Summary card for the logged-in employee's own latest payslip.

    Same shape as :func:`payroll_summary`, scoped to the caller's ``user_id``.
    ``no_of_payslips`` is the user's total payslip count across all periods (what
    the self-service card shows); ``no_of_employees`` is just 1 here.
    """
    if not PydanticObjectId.is_valid(user_id):
        return PayrollSummary()
    uid = PydanticObjectId(user_id)
    summary = await _payroll_summary([PayslipDocument.user_id == uid])
    summary.no_of_payslips = await PayslipDocument.find(PayslipDocument.user_id == uid).count()
    return summary


def _month_window(n: int, end_year: int, end_month: int) -> list[tuple[int, int]]:
    """The ``n`` ``(year, month)`` buckets ending at ``end_year``/``end_month``, oldest first."""
    buckets: list[tuple[int, int]] = []
    year, month = end_year, end_month
    for _ in range(n):
        buckets.append((year, month))
        month -= 1
        if month == 0:
            month, year = 12, year - 1
    buckets.reverse()
    return buckets


async def _payslip_summary_chart(scope: list, range_: str) -> PayslipSummaryChart:
    """Monthly totals for the payslip-summary chart within ``scope`` (find filters).

    ``range_`` is the dropdown window: ``1y`` (12 months), ``6m`` or ``3m``, ending
    at the current month. Each bucket sums total earnings, deductions and net pay
    over the matching payslips; months with none come back zeroed with
    ``has_data=False`` so the frontend can grey them. ``scope`` selects an
    organisation (admin) or a single ``user_id`` (self-service).
    """
    months = _CHART_RANGE_MONTHS.get(range_)
    if months is None:
        raise _bad_request(f"Unknown range '{range_}'. Allowed: {', '.join(_CHART_RANGE_MONTHS)}", "INVALID_RANGE")

    now = datetime.now(UTC)
    buckets = _month_window(months, now.year, now.month)
    period_filter = Or(
        *(And(PayslipDocument.year == y, PayslipDocument.month == m) for y, m in buckets)
    )
    docs = await PayslipDocument.find(*scope, period_filter).to_list()

    agg: dict[tuple[int, int], list[float]] = {}
    for doc in docs:
        key = (doc.year, doc.month)
        earnings = doc.decrypt_earnings()
        deductions = doc.decrypt_deductions()
        net_value = doc.decrypt_extra().get("net_salary")
        bucket = agg.setdefault(key, [0.0, 0.0, 0.0])
        if earnings is not None:
            bucket[0] += earnings.total
        if deductions is not None:
            bucket[1] += deductions.total
        if isinstance(net_value, (int, float)):
            bucket[2] += float(net_value)

    points = []
    for year, month in buckets:
        total_earnings, deductions, net_amount = agg.get((year, month), (0.0, 0.0, 0.0))
        label = _MONTH_NAMES[month] if 1 <= month <= 12 else str(month)
        points.append(
            PayslipSummaryPoint(
                year=year,
                month=month,
                month_label=label,
                period_label=f"{label[:3]} {year}",
                total_earnings=round(total_earnings, 2),
                deductions=round(deductions, 2),
                net_amount=round(net_amount, 2),
                has_data=(year, month) in agg,
            )
        )
    return PayslipSummaryChart(range=range_, points=points)


async def payslip_summary_chart(organisation_id: PydanticObjectId, range_: str) -> PayslipSummaryChart:
    """Org-wide payslip-summary chart over the rolling ``range_`` window."""
    return await _payslip_summary_chart([PayslipDocument.organisation_id == organisation_id], range_)


async def my_payslip_summary_chart(user_id: str, range_: str) -> PayslipSummaryChart:
    """Payslip-summary chart for the logged-in employee's own payslips."""
    return await _payslip_summary_chart([PayslipDocument.user_id == PydanticObjectId(user_id)], range_)


# ── Payslip records (employee list) ──────────────────────────────────────────


def _mask(value: object, visible: int = 4) -> str | None:
    """Mask all but the last ``visible`` chars, e.g. ``xxxxxx8901``."""
    if value is None or value == "":
        return None
    text = str(value)
    return "x" * 6 + text[-visible:] if len(text) > visible else text


def _show(value: object, unmasked: bool) -> str | None:
    """Full value (as string) when ``unmasked``, otherwise masked."""
    if value is None or value == "":
        return None
    return str(value) if unmasked else _mask(value)


def _to_list_item(doc: PayslipDocument, *, unmasked: bool = False) -> PayslipListItem:
    """Decrypt a payslip and project it to a list row.

    PF/UAN/account are masked unless ``unmasked`` (self-service: the employee
    viewing their own payslip). PAN is always shown in full.
    """
    try:
        read = doc.to_read()
        earnings, deductions, net, extra = read.earnings, read.deductions, read.total, read.extra
        pf_no, uan, pan, bank, account = read.pf_no, read.uan_number, read.pan_no, read.bank_name, read.account_no
    except RuntimeError:
        logger.error("payslip.decrypt_failed", payslip_id=str(doc.id))
        earnings, deductions, net, extra = Earnings(), Deductions(), None, {}
        pf_no = uan = pan = bank = account = None
    return PayslipListItem(
        id=str(doc.id),
        user_id=str(doc.user_id),
        emp_code=doc.emp_code,
        full_name=doc.full_name,
        designation=doc.designation,
        date_of_joining=doc.date_of_joining,
        gender=doc.gender,
        month=doc.month,
        year=doc.year,
        uploaded_by=doc.modified_by or doc.created_by,
        uploaded_on=doc.modified_on or doc.created_on,
        earnings=earnings,
        deductions=deductions,
        extra=extra,
        net_amount=net,
        standard_days=doc.standard_days,
        days_worked=doc.days_worked,
        pf_no=_show(pf_no, unmasked),
        uan_number=_show(uan, unmasked),
        pan_no=pan,
        bank_name=bank,
        account_no=_show(account, unmasked),
    )


def _payslip_conditions(
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None,
    year: int | None,
    search: str | None,
) -> list:
    """Shared find() filters for the payslip list + export (tenant + period + search)."""
    conditions = [
        PayslipDocument.organisation_id == organisation_id,
        PayslipDocument.business_unit_id == business_unit_id,
    ]
    if month is not None:
        conditions.append(PayslipDocument.month == month)
    if year is not None:
        conditions.append(PayslipDocument.year == year)
    if search and search.strip():
        term = re.escape(search.strip())
        conditions.append(
            Or(
                RegEx(PayslipDocument.emp_code, term, options="i"),
                RegEx(PayslipDocument.full_name, term, options="i"),
            )
        )
    return conditions


async def list_payslips(
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None,
    year: int | None,
    search: str | None,
    page: int,
    page_size: int,
) -> PayslipListResponse:
    """Paginated payslip list for the caller's tenant, newest period first.

    ``search`` matches the employee id (``emp_code``) or name (``full_name``),
    case-insensitive substring.
    """
    query = PayslipDocument.find(*_payslip_conditions(organisation_id, business_unit_id, month, year, search))
    total = await query.count()
    docs = (
        await query.sort(-PayslipDocument.year, -PayslipDocument.month, +PayslipDocument.emp_code)
        .skip((page - 1) * page_size)
        .limit(page_size)
        .to_list()
    )
    return PayslipListResponse(
        items=[_to_list_item(doc) for doc in docs],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=(total + page_size - 1) // page_size if page_size else 0,
    )


def _export_row(item: PayslipListItem) -> list:
    """Flatten a list item to a CSV row (order must match constants.EXPORT_COLUMNS)."""
    e, d = item.earnings, item.deductions
    return [
        item.emp_code,
        item.full_name,
        item.designation,
        item.date_of_joining,
        item.gender,
        item.month,
        item.year,
        item.uploaded_by,
        item.uploaded_on.isoformat() if item.uploaded_on else "",
        e.basic_salary,
        e.hra,
        e.uniform_allowance,
        e.telephone_or_mobile,
        e.magazines,
        e.LTA,
        e.retention_incentive,
        e.arrears,
        e.incentive_or_project_allowwance,
        e.total,
        d.income_tax,
        d.provident_fund,
        d.professional_tax,
        d.esi,
        d.other_deductions,
        d.salary_advance,
        d.health_insurance_premium,
        d.gmc_premium,
        d.total,
        item.net_amount,
        item.standard_days,
        item.days_worked,
        item.pan_no,
        item.pf_no,
        item.uan_number,
        item.bank_name,
        item.account_no,
    ]


def _valid_object_ids(values: list[str] | None) -> list[PydanticObjectId]:
    """Coerce id strings to ObjectIds, silently dropping any malformed ones."""
    out: list[PydanticObjectId] = []
    for value in values or []:
        try:
            out.append(PydanticObjectId(value))
        except (ValueError, TypeError):
            continue
    return out


async def export_payslips_csv(
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None,
    year: int | None,
    search: str | None,
    user_ids: list[str] | None = None,
) -> bytes:
    """Export the payslip list to CSV.

    When ``user_ids`` are given, the export is narrowed to those employees — still
    within the ``month``/``year``/``search`` filters — which backs the "export
    selected employees" action.

    Sensitive ids (PF/UAN/account) are masked exactly as in the list; amounts and
    PAN are in full. Encoded UTF-8 with a BOM for Excel.
    """
    conditions = _payslip_conditions(organisation_id, business_unit_id, month, year, search)
    if user_ids:
        conditions.append(In(PayslipDocument.user_id, _valid_object_ids(user_ids)))
    docs = (
        await PayslipDocument.find(*conditions)
        .sort(-PayslipDocument.year, -PayslipDocument.month, +PayslipDocument.emp_code)
        .limit(constants.EXPORT_MAX_ROWS)
        .to_list()
    )
    if len(docs) >= constants.EXPORT_MAX_ROWS:
        logger.warning("payslip_export.truncated", rows=len(docs), cap=constants.EXPORT_MAX_ROWS)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(constants.EXPORT_COLUMNS)
    for doc in docs:
        writer.writerow(_export_row(_to_list_item(doc)))
    return buffer.getvalue().encode("utf-8-sig")


def _safe_name(value: str | None) -> str:
    """Filename-safe token from an id/code (``SIL-0954`` stays, odd chars -> ``_``)."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(value or "payslip"))


async def export_payslips_pdf(
    user: UserBase,
    organisation_id: PydanticObjectId,
    business_unit_id: PydanticObjectId,
    month: int | None,
    year: int | None,
    search: str | None,
    user_ids: list[str] | None = None,
) -> tuple[bytes, str, str, bool] | None:
    """Export the selected employees' payslips as PIN-protected PDFs.

    Same tenant/period/search/``user_ids`` filters as the CSV export. One matched
    payslip returns a single PDF; multiple return a ZIP of per-employee PDFs.

    Every PDF is locked with the **acting (login) user's** PIN — an admin can't
    know each employee's PIN, so their own PIN is the open-password (created and
    emailed to them once if absent). Returns ``(content, media_type, filename,
    pin_emailed)`` or ``None`` when nothing matches.
    """
    conditions = _payslip_conditions(organisation_id, business_unit_id, month, year, search)
    if user_ids:
        conditions.append(In(PayslipDocument.user_id, _valid_object_ids(user_ids)))
    docs = (
        await PayslipDocument.find(*conditions)
        .sort(-PayslipDocument.year, -PayslipDocument.month, +PayslipDocument.emp_code)
        .limit(constants.EXPORT_MAX_ROWS)
        .to_list()
    )
    if not docs:
        return None

    pin_code, pin_emailed = await pin_service.get_or_create_pin(user)
    if len(docs) == 1:
        doc = docs[0]
        content = _render_payslip_pdf(doc, pin_code, doc.full_name)
        return content, "application/pdf", f"payslip_{_safe_name(doc.emp_code)}_{doc.year}_{doc.month:02d}.pdf", pin_emailed

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for doc in docs:
            name = f"payslip_{_safe_name(doc.emp_code)}_{doc.year}_{doc.month:02d}.pdf"
            archive.writestr(name, _render_payslip_pdf(doc, pin_code, doc.full_name))
    period = f"{year}_{month:02d}" if (year and month) else (str(year) if year else "selected")
    return buffer.getvalue(), "application/zip", f"payslips_{period}.zip", pin_emailed


# ── My payroll (employee self-service) ───────────────────────────────────────


async def _find_my_payslip(user_id: str, month: int | None, year: int | None) -> PayslipDocument | None:
    """The caller's payslip doc for a period (latest if month/year omitted).

    Scoped solely by ``user_id`` (a user's payslips belong only to them), so it
    works for any authenticated user regardless of business-unit context.
    """
    try:
        uid = PydanticObjectId(user_id)
    except (ValueError, TypeError):
        return None
    conditions = [PayslipDocument.user_id == uid]
    if month is not None:
        conditions.append(PayslipDocument.month == month)
    if year is not None:
        conditions.append(PayslipDocument.year == year)
    return await PayslipDocument.find(*conditions).sort(-PayslipDocument.year, -PayslipDocument.month).first_or_none()


async def get_my_payslip(
    user_id: str, month: int | None, year: int | None, unmasked: bool = False
) -> PayslipListItem | None:
    """The caller's own payslip for a period, or ``None`` if none.

    ``unmasked`` reveals the employee's own PF/UAN/account in full (self-service).
    """
    doc = await _find_my_payslip(user_id, month, year)
    return _to_list_item(doc, unmasked=unmasked) if doc is not None else None


async def my_payslip_list(
    user_id: str,
    year: int | None,
    month: int | None,
    search: str | None,
    page: int,
    page_size: int,
) -> MyPayslipListResponse:
    """Paginated payslip history for the logged-in employee (newest first).

    One row per payslip with gross / deductions / net and the populating file's
    name + status. ``year``/``month`` filter by pay period; ``search`` matches the
    pay period (e.g. "May 2026"). An employee has few payslips, so the set is
    loaded, enriched from the linked uploads, then filtered and paged in memory.
    """
    if not PydanticObjectId.is_valid(user_id):
        return MyPayslipListResponse(items=[], page=page, page_size=page_size, total=0, total_pages=0)

    conditions = [PayslipDocument.user_id == PydanticObjectId(user_id)]
    if year is not None:
        conditions.append(PayslipDocument.year == year)
    if month is not None:
        conditions.append(PayslipDocument.month == month)
    docs = (
        await PayslipDocument.find(*conditions)
        .sort(-PayslipDocument.year, -PayslipDocument.month)
        .to_list()
    )

    # Enrich with the upload that populated each payslip (file name + status).
    file_ids = list({doc.payslip_file_id for doc in docs})
    uploads = await UploadedPayslipDocument.find(In(UploadedPayslipDocument.id, file_ids)).to_list()
    upload_by_id = {upload.id: upload for upload in uploads}

    rows: list[MyPayslipListItem] = []
    for doc in docs:
        upload = upload_by_id.get(doc.payslip_file_id)
        # A populated payslip is processed; bump legacy uploads that predate `status`.
        status = upload.status if upload else constants.UPLOAD_STATUS_PROCESSED
        if status == constants.UPLOAD_STATUS_UPLOADED:
            status = constants.UPLOAD_STATUS_PROCESSED
        earnings = doc.decrypt_earnings()
        deductions = doc.decrypt_deductions()
        net_value = doc.decrypt_extra().get("net_salary")
        label = _MONTH_NAMES[doc.month] if 1 <= doc.month <= 12 else str(doc.month)
        rows.append(
            MyPayslipListItem(
                id=str(doc.id),
                month=doc.month,
                year=doc.year,
                period_label=f"{label} {doc.year}",
                file_name=upload.file_name if upload else None,
                gross=round(earnings.total, 2) if earnings else 0.0,
                deductions=round(deductions.total, 2) if deductions else 0.0,
                net_pay=round(float(net_value), 2) if isinstance(net_value, (int, float)) else 0.0,
                status=status,
            )
        )

    if search and search.strip():
        term = search.strip().lower()
        rows = [r for r in rows if term in r.period_label.lower()]

    total = len(rows)
    start = (page - 1) * page_size
    return MyPayslipListResponse(
        items=rows[start : start + page_size],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=(total + page_size - 1) // page_size if page_size else 0,
    )


def _render_payslip_pdf(doc: PayslipDocument, pin_code: str, display_name: str | None) -> bytes:
    """Render one payslip to a PIN-encrypted PDF (legacy layout for <= May 2026)."""
    render = pdf.build_payslip_pdf_old if constants.uses_old_template(doc.year, doc.month) else pdf.build_payslip_pdf
    return render(doc.to_read(), password=pin_code, display_name=display_name)


async def view_my_payslip_html(user_id: str, month: int, year: int, display_name: str | None = None) -> str | None:
    """Render the caller's payslip for a period as HTML (unencrypted on-screen view).

    Returns the HTML string, or ``None`` if the user has no payslip for the period.
    Uses the legacy layout for periods at or before May 2026, matching the PDF.
    """
    doc = await _find_my_payslip(user_id, month, year)
    if doc is None:
        return None
    show_ytd = not constants.uses_old_template(doc.year, doc.month)
    return pdf.build_payslip_html(doc.to_read(), display_name=display_name, show_ytd=show_ytd)


async def export_my_payslip_pdf(user: UserBase, month: int, year: int) -> tuple[bytes, bool] | None:
    """Build the caller's payslip for a period as a PIN-protected PDF.

    Returns ``(pdf_bytes, pin_emailed)``, or ``None`` if the user has no payslip
    for the period. The PDF open-password is the employee's 6-digit PIN; when no
    PIN existed one is generated and emailed (``pin_emailed=True``). The PDF
    carries the employee's full (unmasked) details — it's their own document.
    """
    doc = await _find_my_payslip(user.id, month, year)
    if doc is None:
        return None
    pin_code, pin_emailed = await pin_service.get_or_create_pin(user)
    return _render_payslip_pdf(doc, pin_code, user.display_name), pin_emailed


async def export_my_payslips_bulk(
    user: UserBase, periods: list[tuple[int, int]]
) -> tuple[bytes, str, str, bool, list[str]] | None:
    """Export several of the caller's payslips at once.

    ``periods`` is a list of ``(year, month)``. A single matched period returns the
    PDF exactly like :func:`export_my_payslip_pdf`; multiple matches return a ZIP of
    the per-period PDFs (each individually PIN-encrypted — the zip itself is plain).
    Periods with no payslip are skipped and reported.

    Returns ``(content, media_type, filename, pin_emailed, missing)`` or ``None``
    when none of the requested periods have a payslip.
    """
    seen: set[tuple[int, int]] = set()
    found: list[tuple[int, int, PayslipDocument]] = []
    missing: list[str] = []
    for year, month in periods:
        if (year, month) in seen:
            continue
        seen.add((year, month))
        doc = await _find_my_payslip(user.id, month, year)
        if doc is None:
            missing.append(f"{year}-{month:02d}")
        else:
            found.append((year, month, doc))

    if not found:
        return None

    # One PIN for every PDF; created + emailed once if the user had none.
    pin_code, pin_emailed = await pin_service.get_or_create_pin(user)

    if len(found) == 1:
        year, month, doc = found[0]
        content = _render_payslip_pdf(doc, pin_code, user.display_name)
        return content, "application/pdf", f"payslip_{year}_{month:02d}.pdf", pin_emailed, missing

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for year, month, doc in found:
            archive.writestr(f"payslip_{year}_{month:02d}.pdf", _render_payslip_pdf(doc, pin_code, user.display_name))
    return buffer.getvalue(), "application/zip", "my_payslips.zip", pin_emailed, missing
