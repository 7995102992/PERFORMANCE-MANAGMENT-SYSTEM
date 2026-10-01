"""Payslip-file upload API: CSV/XLS to DigitalOcean Spaces + ``payslips_uploaded``.

Every route depends on :func:`require_tenant_scope`, which authenticates the IAM
bearer token (via the Valkey session store) and resolves the caller's
organisation + business unit. Requests are therefore tenant-scoped: reads are
filtered to the caller's scope and writes are stamped with it. The acting user
is recorded on each upload via the correlation context (``uploaded_by``).
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status

from src.auth.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.exceptions import NotFound
from src.payslips import constants, pin_service, service
from src.payslips.dependencies import (
    TenantScope,
    require_my_payroll,
    require_payslip_admin,
    require_tenant_scope,
)
from src.payslips.schemas import (
    BulkPayslipExportRequest,
    MyPayslipListResponse,
    PinVerifyRequest,
    PinVerifyResponse,
    PayslipListItem,
    PayslipListResponse,
    PayrollSummary,
    PayslipSummaryChart,
    PayslipUploadResponse,
    PayslipValidationResult,
    UploadedPayslipListResponse,
    UploadedPayslipRead,
)

router = APIRouter(prefix="/payslips/uploads", tags=["payslips"], dependencies=[Depends(require_payslip_admin)])


@router.post("", response_model=PayslipUploadResponse, status_code=status.HTTP_201_CREATED)
async def create_payslip_upload(
    file: UploadFile = File(..., description="Payslip batch file (.csv, .xls, .xlsx)"),
    month: int = Form(..., ge=1, le=12),
    year: int = Form(..., ge=2000, le=2100),
    reason: str | None = Form(default=None, description="Optional note for the initial upload"),
    scope: TenantScope = Depends(require_tenant_scope),
) -> PayslipUploadResponse:
    """Upload the first payslip file for a month/year (stored as version 1).

    Stores the file, then populates the ``payslips`` collection from its rows
    (resolving ``user_id`` per employee from IAM). Returns ``409`` if an upload
    already exists for that period (within the caller's org + business unit) —
    use ``PUT`` to add a new version instead.
    """
    doc, result = await service.create_upload(file, scope.organisation_id, scope.business_unit_id, month, year, reason)
    return PayslipUploadResponse(upload=service.to_read(doc), import_result=result)


@router.put("", response_model=PayslipUploadResponse, status_code=status.HTTP_201_CREATED)
async def update_payslip_upload(
    file: UploadFile = File(..., description="Replacement payslip file (.csv, .xls, .xlsx)"),
    month: int = Form(..., ge=1, le=12),
    year: int = Form(..., ge=2000, le=2100),
    reason: str = Form(..., min_length=1, description="Reason for the new version (required)"),
    scope: TenantScope = Depends(require_tenant_scope),
) -> PayslipUploadResponse:
    """Upload a new version for an existing month/year (previous version + 1).

    Stores the new file and re-populates the ``payslips`` rows for the period.
    ``reason`` is mandatory. Returns ``404`` if there is no prior upload for the
    period — use ``POST`` to create version 1 first.
    """
    doc, result = await service.update_upload(file, scope.organisation_id, scope.business_unit_id, month, year, reason)
    return PayslipUploadResponse(upload=service.to_read(doc), import_result=result)


@router.post("/validate", response_model=PayslipValidationResult)
async def validate_payslip_upload(
    file: UploadFile = File(..., description="Payslip CSV to validate (not stored)"),
    month: int | None = Form(default=None, ge=1, le=12),
    year: int | None = Form(default=None, ge=2000, le=2100),
    scope: TenantScope = Depends(require_tenant_scope),
) -> PayslipValidationResult:
    """Dry-run validate a payslip CSV before uploading — nothing is stored.

    Returns per-row ``status``/``issues``. A missing template column is **not** an
    error: it's listed in ``missing_columns`` and those fields default to 0/null,
    so the file stays ``valid``. Pass the target ``month``/``year`` so a legacy
    period (<= May 2026) is checked against the old column set. Employee existence
    is checked against IAM when reachable (``employees_checked: false`` if it
    couldn't be verified).
    """
    return await service.validate_upload(file, scope.organisation_id, scope.business_unit_id, month, year)


@router.get("", response_model=UploadedPayslipListResponse)
async def list_payslip_uploads(
    scope: TenantScope = Depends(require_tenant_scope),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    status: str | None = Query(default=None, description="Filter by upload status: uploaded | processed | failed"),
    search: str | None = Query(default=None, description="Match the file name or pay period (e.g. 'May 2026')"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
) -> UploadedPayslipListResponse:
    """Paginated upload history for the management screen (newest first).

    Backs the uploads table: each row carries the pay period, file name, record
    count, net total / average net, uploader id + date, and processing status.
    Filter by ``year``/``month``/``status`` and ``search`` (file name or pay
    period). Tenant-scoped to the caller's org + business unit.
    """
    return await service.list_uploads_page(
        scope.organisation_id, scope.business_unit_id, month, year, status, search, page, page_size
    )


_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get(
    "/template",
    dependencies=[Depends(get_current_user)],
    responses={200: {"content": {_XLSX_MEDIA_TYPE: {}}, "description": "Blank xlsx template"}},
)
async def download_payslip_template(
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None, ge=2000, le=2100),
) -> Response:
    """Download the blank .xlsx template to fill in and upload via POST/PUT.

    One header row, one row per employee. Columns may be reshuffled — the parser
    matches by header name. Pass the target ``month``/``year``: periods at or
    before May 2026 get the legacy column set, June 2026 onward the current one
    (omit the period for the current template). Authentication is required, but
    no tenant scope (static content).
    """
    old = month is not None and year is not None and constants.uses_old_template(year, month)
    filename = constants.TEMPLATE_FILENAME_OLD if old else constants.TEMPLATE_FILENAME
    return Response(
        content=service.build_template_xlsx(month, year),
        media_type=_XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/summary", response_model=PayrollSummary)
async def payroll_summary(scope: TenantScope = Depends(require_tenant_scope)) -> PayrollSummary:
    """Org-wide payroll summary card for the most recent payroll period.

    No filters: totals (gross/net + YTD) and headcount are computed across the
    caller's organisation for its latest payroll period. YTD is ``null`` for
    legacy (<= May 2026) periods that carried no YTD columns.
    """
    return await service.payroll_summary(scope.organisation_id)


@router.get("/summary-chart", response_model=PayslipSummaryChart)
async def payslip_summary_chart(
    range_: str = Query(default="1y", alias="range", description="Rolling window: 1y | 6m | 3m"),
    scope: TenantScope = Depends(require_tenant_scope),
) -> PayslipSummaryChart:
    """Org-wide monthly payslip-summary chart over a rolling window (ends this month).

    Returns one bucket per month (oldest first) with total earnings, deductions and
    net amount summed across the organisation. ``total_earnings == net_amount +
    deductions``; months without payslips come back zeroed with ``has_data=false``.
    """
    return await service.payslip_summary_chart(scope.organisation_id, range_)


@router.get(
    "/{upload_id}/download",
    responses={200: {"content": {_XLSX_MEDIA_TYPE: {}}, "description": "Decrypted uploaded file"}},
)
async def download_payslip_upload(
    upload_id: str,
    scope: TenantScope = Depends(require_tenant_scope),
) -> Response:
    """Download the original uploaded file, decrypted on the way out.

    Files are stored encrypted at rest, so this proxies the object through the API
    (decrypting it) rather than handing out a direct storage URL. Tenant-scoped:
    another tenant's file is ``404``.
    """
    body, file_name = await service.download_upload_file(upload_id, scope.organisation_id, scope.business_unit_id)
    safe_name = os.path.basename(file_name or "payslip_upload.xlsx").replace('"', "")
    return Response(
        content=body,
        media_type=_XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


@router.get("/{upload_id}", response_model=UploadedPayslipRead)
async def get_payslip_upload(
    upload_id: str,
    scope: TenantScope = Depends(require_tenant_scope),
) -> UploadedPayslipRead:
    """Fetch a single uploaded payslip record (within the caller's scope) + URL."""
    doc = await service.get_upload(upload_id, scope.organisation_id, scope.business_unit_id)
    return service.to_read(doc)


# Payslip records (the employee list view) — distinct resource from the file
# uploads above, hence its own router at /payslips.
records_router = APIRouter(prefix="/payslips", tags=["payslips"], dependencies=[Depends(require_payslip_admin)])


@records_router.get("", response_model=PayslipListResponse)
async def list_payslips(
    scope: TenantScope = Depends(require_tenant_scope),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    search: str | None = Query(default=None, description="Search by employee id (emp_code) or name (full_name)"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> PayslipListResponse:
    """Paginated payslip list for the caller's org + business unit (newest first).

    Filter by ``month``/``year``; ``search`` matches the employee id (emp_code) or
    name (full_name). Each item carries the full decrypted payslip (earnings,
    deductions, totals, attendance) with PF/UAN/account masked and PAN in full.
    """
    return await service.list_payslips(
        scope.organisation_id, scope.business_unit_id, month, year, search, page, page_size
    )


@records_router.get(
    "/export",
    responses={
        200: {
            "content": {"text/csv": {}, "application/pdf": {}, "application/zip": {}},
            "description": "CSV list, or (format=pdf) a single payslip PDF / ZIP of PDFs",
        }
    },
)
async def export_payslips(
    scope: TenantScope = Depends(require_tenant_scope),
    user: UserBase = Depends(get_current_user),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    search: str | None = Query(default=None, description="Filter by employee id (emp_code) or name (full_name)"),
    user_ids: list[str] | None = Query(
        default=None,
        description="User ids of selected employees. When given, the export is limited to "
        "these employees within the month/year filters.",
    ),
    export_format: str = Query(default="csv", alias="format", pattern="^(csv|pdf)$", description="csv | pdf"),
) -> Response:
    """Export the selected payslips — CSV list, or payslip PDFs.

    Pass ``user_ids`` to export only the selected employees (within the same
    ``month``/``year``/``search`` filters as ``GET /payslips``).

    - ``format=csv`` (default): the list as CSV; PF/UAN/account masked, amounts/PAN in full.
    - ``format=pdf``: a single payslip PDF when one row matches, else a ZIP of
      per-employee PDFs. Each PDF is locked with the **acting user's** PIN (an admin
      can't know each employee's PIN) — created and emailed once if absent, signalled
      by ``X-Payslip-Pin-Emailed: true``.
    """
    if export_format == "pdf":
        result = await service.export_payslips_pdf(
            user, scope.organisation_id, scope.business_unit_id, month, year, search, user_ids
        )
        if result is None:
            raise NotFound("No payslips match the selected filters")
        content, media_type, filename, pin_emailed = result
        return Response(
            content=content,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Payslip-Pin-Emailed": "true" if pin_emailed else "false",
            },
        )

    csv_bytes = await service.export_payslips_csv(
        scope.organisation_id, scope.business_unit_id, month, year, search, user_ids
    )
    period = f"{year}_{month:02d}" if (year and month) else (str(year) if year else "all")
    filename = f"payslips_{period}_selected.csv" if user_ids else f"payslips_{period}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# My payroll (employee self-service) — only the caller's own payslip. Auth only
# (no tenant scope) since it's filtered to the session user's id.
my_payroll_router = APIRouter(prefix="/my-payroll", tags=["my-payroll"], dependencies=[Depends(require_my_payroll)])


@my_payroll_router.get("")
async def get_my_payroll(
    user: UserBase = Depends(get_current_user),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    unmasked: bool = Query(default=False, description="Reveal this employee's own PF/UAN/account in full"),
) -> PayslipListItem | None:
    """The logged-in employee's own payslip for a month/year.

    Returns the single payslip for the given period, or the most recent one when
    ``month``/``year`` are omitted. ``null`` if the user has no payslip yet. Pass
    ``unmasked=true`` to reveal the employee's own PF/UAN/account in full (PAN is
    always full).
    """
    return await service.get_my_payslip(user.id, month, year, unmasked)


@my_payroll_router.get("/list", response_model=MyPayslipListResponse)
async def list_my_payslips(
    user: UserBase = Depends(get_current_user),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    search: str | None = Query(default=None, description="Search by pay period (e.g. 'May 2026')"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
) -> MyPayslipListResponse:
    """Paginated payslip history for the logged-in employee (newest first).

    Each row carries the pay period, gross / deductions / net pay and the
    populating file's name + status. Filter by ``year``/``month``; ``search``
    matches the pay period.
    """
    return await service.my_payslip_list(user.id, year, month, search, page, page_size)


@my_payroll_router.get("/summary", response_model=PayrollSummary)
async def get_my_payroll_summary(user: UserBase = Depends(get_current_user)) -> PayrollSummary:
    """Summary card for the logged-in employee's own latest payslip.

    Same shape as the org card (gross/net + YTD), scoped to the caller; YTD is
    ``null`` for legacy (<= May 2026) periods. ``no_of_payslips`` is the caller's
    total payslip count across all periods (``no_of_employees`` is 1 here).
    """
    return await service.my_payroll_summary(user.id)


@my_payroll_router.get("/summary-chart", response_model=PayslipSummaryChart)
async def get_my_payslip_summary_chart(
    range_: str = Query(default="1y", alias="range", description="Rolling window: 1y | 6m | 3m"),
    user: UserBase = Depends(get_current_user),
) -> PayslipSummaryChart:
    """Payslip-summary chart for the logged-in employee's own payslips.

    One bucket per month (oldest first) over the rolling window, with the
    employee's total earnings, deductions and net amount; ``total_earnings ==
    net_amount + deductions``. Months without a payslip return zeroed/``has_data=false``.
    """
    return await service.my_payslip_summary_chart(user.id, range_)


@my_payroll_router.get(
    "/view",
    responses={200: {"content": {"text/html": {}}, "description": "Payslip rendered as HTML for on-screen view"}},
)
async def view_my_payslip(
    user: UserBase = Depends(get_current_user),
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
) -> Response:
    """Render the caller's payslip for a month/year as HTML (for an on-screen view).

    Same selection as ``/export`` but returns an unencrypted, self-contained HTML
    document (no PIN) — the caller is already authenticated to their own payslip.
    404 if no payslip exists for the period.
    """
    payslip_html = await service.view_my_payslip_html(user.id, month, year, display_name=user.display_name)
    if payslip_html is None:
        raise NotFound("No payslip available for this period")
    return Response(content=payslip_html, media_type="text/html")


@my_payroll_router.get(
    "/export",
    responses={200: {"content": {"application/pdf": {}}, "description": "PIN-protected payslip PDF"}},
)
async def export_my_payslip(
    user: UserBase = Depends(get_current_user),
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
) -> Response:
    """Download the caller's payslip for a month/year as a PIN-protected PDF.

    The PDF open-password is the employee's 6-digit PIN. If no PIN exists yet, one
    is generated and emailed — signalled by ``X-Payslip-Pin-Emailed: true``.
    """
    result = await service.export_my_payslip_pdf(user, month, year)
    if result is None:
        raise NotFound("No payslip available for this period")
    pdf_bytes, pin_emailed = result
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="payslip_{year}_{month:02d}.pdf"',
            "X-Payslip-Pin-Emailed": "true" if pin_emailed else "false",
        },
    )


@my_payroll_router.post(
    "/export-bulk",
    responses={
        200: {
            "content": {"application/pdf": {}, "application/zip": {}},
            "description": "Single PIN-protected PDF, or a ZIP of per-period PIN-protected PDFs",
        }
    },
)
async def export_my_payslips_bulk(
    payload: BulkPayslipExportRequest,
    user: UserBase = Depends(get_current_user),
) -> Response:
    """Download several of the caller's payslips at once.

    Body: ``{"periods": [{"year": 2026, "month": 5}, ...]}``. A single matched
    period downloads that PDF (same as ``/export``); multiple matches download a
    ZIP of the per-period PDFs, each individually PIN-encrypted. Periods with no
    payslip are skipped and listed in ``X-Payslip-Missing-Periods``. The PIN is the
    employee's 6-digit code; if none existed one is generated and emailed
    (``X-Payslip-Pin-Emailed: true``). 404 if none of the periods have a payslip.
    """
    result = await service.export_my_payslips_bulk(user, [(p.year, p.month) for p in payload.periods])
    if result is None:
        raise NotFound("No payslips available for the requested periods")
    content, media_type, filename, pin_emailed, missing = result
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Payslip-Pin-Emailed": "true" if pin_emailed else "false",
    }
    if missing:
        headers["X-Payslip-Missing-Periods"] = ",".join(missing)
    return Response(content=content, media_type=media_type, headers=headers)


@my_payroll_router.post("/pin/verify", response_model=PinVerifyResponse)
async def verify_my_pin(
    payload: PinVerifyRequest,
    user: UserBase = Depends(get_current_user),
) -> PinVerifyResponse:
    """Check the caller's PIN — backs the payroll screen-lock unlock.

    Returns ``valid`` (PIN matches) and ``pin_set`` (False when the caller has no
    PIN yet, so the UI can offer setup). Always ``200``; a wrong PIN is
    ``{"valid": false}``, not an auth error.
    """
    valid, pin_set = await pin_service.verify_pin(user, payload.pin)
    return PinVerifyResponse(valid=valid, pin_set=pin_set)


@my_payroll_router.post("/pin/regenerate")
async def regenerate_my_pin(user: UserBase = Depends(get_current_user)) -> dict:
    """Generate a new payslip PIN for the caller and email it (PIN not returned)."""
    await pin_service.regenerate_pin(user)
    return {"code": "PIN_REGENERATED", "detail": "A new PIN has been generated and emailed to you."}
