"""Beanie documents for the payslip domain.

Collections (mirrors ``schemaScript.js``):

* ``payslips``          -> :class:`PayslipDocument`        (earnings/deductions encrypted)
* ``payslips_uploaded`` -> :class:`UploadedPayslipDocument`

The employee PIN (``employee_pin``) is owned by IAM now — this service reads PINs
over RPC (see ``src.payslips.pin_service``), so no PIN document lives here.

Per the ``CLAUDE.md`` invariant, sensitive salary components are persisted as a
single Fernet-encrypted JSON blob and only decrypted in the service layer — they
are never written to the database in clear text.
"""

from __future__ import annotations

from datetime import datetime

from beanie import Document, PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, IndexModel

from src.payslips.schemas import Deductions, Earnings, PayslipCreate, PayslipRead
from src.security.crypto import decrypt_json, decrypt_str, encrypt_json, encrypt_str

__all__ = ["UploadedPayslipDocument", "PayslipDocument"]


class UploadedPayslipDocument(Document):
    """A payslip file uploaded to object storage (``payslips_uploaded``)."""

    organisation_id: PydanticObjectId
    business_unit_id: PydanticObjectId
    file_name: str
    path: str
    month: int
    year: int
    version: int = 1
    reason: str | None = None
    # Processing lifecycle: "uploaded" -> "processed" (or "failed"). Set after the
    # synchronous populate; see src.payslips.constants.UPLOAD_STATUSES.
    status: str = "uploaded"
    # schemaScript.js types `uploaded_by` as `date` (a typo) — it holds the id of
    # the uploading user.
    uploaded_by: PydanticObjectId | None = None
    uploaded_on: datetime | None = None

    class Settings:
        name = "payslips_uploaded"
        indexes = [
            # One row per (tenant, period, version). Scoping the uniqueness to
            # org + business unit lets each tenant version independently, and
            # guards against duplicate versions racing in on concurrent PUTs.
            IndexModel(
                [
                    ("organisation_id", ASCENDING),
                    ("business_unit_id", ASCENDING),
                    ("year", ASCENDING),
                    ("month", ASCENDING),
                    ("version", ASCENDING),
                ],
                unique=True,
            ),
        ]


class PayslipDocument(Document):
    """A structured payslip (``payslips``) with encrypted salary components.

    ``earnings`` and ``deductions`` hold Fernet-encrypted JSON. Use the typed
    accessors (:meth:`set_earnings`, :meth:`decrypt_earnings`, ...) rather than
    touching the raw ciphertext strings.
    """

    organisation_id: PydanticObjectId
    business_unit_id: PydanticObjectId
    payslip_file_id: PydanticObjectId
    user_id: PydanticObjectId
    emp_code: str
    month: int
    year: int
    standard_days: int | None = None
    days_worked: int | None = None
    # Display fields (clear) — taken from the sheet (or IAM).
    full_name: str | None = None
    designation: str | None = None
    date_of_joining: str | None = None
    gender: str | None = None
    correlation_id: str | None = None
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None

    # ── Sensitive fields: Fernet-encrypted at rest, decrypted only in to_read() ──
    # These hold ciphertext, not the natural value. Build via `from_create` and
    # read via `to_read`; do not assign or query them directly.
    earnings: str = Field(description="Fernet-encrypted JSON of Earnings (display subset)")
    deductions: str = Field(description="Fernet-encrypted JSON of Deductions (display subset)")
    # The full row of every amount column (CTC, Per Month, all *_YTD, net_salary,
    # LOP, ...) keyed by canonical name — the complete, lossless salary snapshot.
    extra: str = Field(default="", description="Fernet-encrypted JSON of all amount columns")
    uan_number: str | None = None
    pf_no: str | None = None
    pan_no: str | None = None
    bank_name: str | None = None
    account_no: str | None = None

    class Settings:
        name = "payslips"
        indexes = [
            IndexModel(
                [("user_id", ASCENDING), ("year", ASCENDING), ("month", ASCENDING)],
                unique=True,
            ),
            IndexModel([("payslip_file_id", ASCENDING)]),
            # Scoped listing of payslips by tenant + period.
            IndexModel(
                [
                    ("organisation_id", ASCENDING),
                    ("business_unit_id", ASCENDING),
                    ("year", ASCENDING),
                    ("month", ASCENDING),
                ]
            ),
        ]

    # ── Encrypted-component accessors ────────────────────────────────────────
    def set_earnings(self, value: Earnings) -> None:
        """Encrypt ``value`` and store it on the document."""
        self.earnings = encrypt_json(value.model_dump()) or ""

    def set_deductions(self, value: Deductions) -> None:
        """Encrypt ``value`` and store it on the document."""
        self.deductions = encrypt_json(value.model_dump()) or ""

    def decrypt_earnings(self) -> Earnings | None:
        """Decrypt the stored earnings, or ``None`` if unset/undecryptable."""
        data = decrypt_json(self.earnings)
        return Earnings(**data) if data is not None else None

    def decrypt_deductions(self) -> Deductions | None:
        """Decrypt the stored deductions, or ``None`` if unset/undecryptable."""
        data = decrypt_json(self.deductions)
        return Deductions(**data) if data is not None else None

    def set_extra(self, value: dict) -> None:
        """Encrypt and store the full amount-snapshot dict."""
        self.extra = encrypt_json(value) or ""

    def decrypt_extra(self) -> dict:
        """Decrypt the amount-snapshot dict (empty dict if unset/undecryptable)."""
        return decrypt_json(self.extra) or {}

    def apply_payload(self, data: PayslipCreate) -> None:
        """Set/refresh the value-bearing fields from a payload, encrypting the
        sensitive ones.

        Identity fields (``organisation_id``/``business_unit_id``/``user_id``/
        ``emp_code``/``month``/``year``) are intentionally NOT touched — they are
        fixed for a payslip and form the upsert key, so this can be reused to
        re-populate an existing row from a corrected file version.
        """
        self.payslip_file_id = PydanticObjectId(data.payslip_file_id)
        self.standard_days = data.standard_days
        self.days_worked = data.days_worked
        self.full_name = data.full_name
        self.designation = data.designation
        self.date_of_joining = data.date_of_joining
        self.gender = data.gender
        self.set_earnings(data.earnings)
        self.set_deductions(data.deductions)
        self.set_extra(data.extra)
        self.uan_number = encrypt_str(data.uan_number)
        self.pf_no = encrypt_str(data.pf_no)
        self.pan_no = encrypt_str(data.pan_no)
        self.bank_name = encrypt_str(data.bank_name)
        self.account_no = encrypt_str(data.account_no)

    @classmethod
    def from_create(
        cls,
        data: PayslipCreate,
        *,
        organisation_id: PydanticObjectId,
        business_unit_id: PydanticObjectId,
        **audit,
    ) -> PayslipDocument:
        """Build a new persistable payslip, encrypting every sensitive field.

        Args:
            data: Plaintext inbound payload.
            organisation_id: Owning organisation (from the caller's session).
            business_unit_id: Owning business unit (from the caller's session).
            **audit: Audit/metadata fields to stamp (e.g. ``created_by``,
                ``created_on``, ``correlation_id``).
        """
        doc = cls(
            organisation_id=organisation_id,
            business_unit_id=business_unit_id,
            payslip_file_id=data.payslip_file_id,
            user_id=data.user_id,
            emp_code=data.emp_code,
            month=data.month,
            year=data.year,
            earnings="",
            deductions="",
            **audit,
        )
        doc.apply_payload(data)
        return doc

    def to_read(self) -> PayslipRead:
        """Project to the API response shape with salary components decrypted.

        Raises:
            RuntimeError: If the encrypted components cannot be decrypted (e.g.
                ``ENCRYPTION_KEY`` mismatch or corrupt ciphertext) — surfaced
                rather than silently returning zeroed salary figures.
        """
        earnings = self.decrypt_earnings()
        deductions = self.decrypt_deductions()
        if earnings is None or deductions is None:
            raise RuntimeError(
                f"Failed to decrypt salary components for payslip {self.id} "
                "(ENCRYPTION_KEY mismatch or corrupt ciphertext)"
            )
        extra = self.decrypt_extra()
        return PayslipRead(
            id=str(self.id),
            payslip_file_id=str(self.payslip_file_id),
            user_id=str(self.user_id),
            emp_code=self.emp_code,
            month=self.month,
            year=self.year,
            full_name=self.full_name,
            designation=self.designation,
            date_of_joining=self.date_of_joining,
            gender=self.gender,
            earnings=earnings,
            deductions=deductions,
            extra=extra,
            total=extra.get("net_salary"),
            standard_days=self.standard_days,
            days_worked=self.days_worked,
            uan_number=decrypt_str(self.uan_number),
            pf_no=decrypt_str(self.pf_no),
            pan_no=decrypt_str(self.pan_no),
            bank_name=decrypt_str(self.bank_name),
            account_no=decrypt_str(self.account_no),
        )
