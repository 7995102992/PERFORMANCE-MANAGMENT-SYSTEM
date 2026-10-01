# Frontend Integration — My Payroll (employee self-service)

The **My Payroll** screen lets the logged-in employee view their own payslip,
download it as a PIN-protected PDF, and reset their PIN. These three endpoints
are pure self-service: **any authenticated user**, no admin role and no
business-unit required — everything is scoped to the caller's own `user_id`.

> Admin endpoints (uploading payslip files, listing/exporting **all** employees'
> payslips) are separate — see the admin integration notes / `GET /payslips*`.

## Base URL & auth
- **Base URL:** `{PAYROLL_BASE_URL}` (dev: `http://localhost:8000`)
- **OpenAPI (codegen):** `{PAYROLL_BASE_URL}/openapi.json` · **Swagger:** `/docs`
- **Every request:** `Authorization: Bearer <token>` — the same IAM session token used across the suite. The server resolves the employee from the session; the FE never sends a user id.
- **Errors** all share: `{ "detail": "...", "code": "...", "correlation_id": "..." }`. Handle `401 UNAUTHORIZED` (re-auth) and `404 NOT_FOUND`.

---

## 1) `GET /my-payroll` — my payslip (JSON)

The payslip detail for the My Payroll screen.

**Query params** (all optional):
| param | type | default | notes |
|---|---|---|---|
| `year` | int 2000–2100 | – | the selected year |
| `month` | int 1–12 | – | the selected month |
| `unmasked` | bool | `false` | `true` → show **this employee's own** `pf_no` / `uan_number` / `account_no` in **full**. `pan_no` is always full. |

- Omit `month`/`year` → returns the **most recent** payslip.
- **Response `200`:** a single `Payslip` object, or **`null`** when the employee has no payslip for that period (show an empty state — "No payslip available for this month").

**`Payslip` shape:**
```jsonc
{
  "id": "6a3bcd…", "user_id": "6a214ab8…", "emp_code": "CEN-F-1",
  // Employee display fields — IAM-owned, currently null (FE renders "—")
  "full_name": null, "designation": null, "date_of_joining": null, "gender": null,
  "month": 6, "year": 2026,
  "uploaded_by": "6a214ab8…", "uploaded_on": "2026-06-24T12:32:00Z",
  "earnings":  { "basic_salary": 45000, "hra": 22500, "uniform_allowance": 0,
                 "telephone_or_mobile": 1000, "magazines": 0, "LTA": 3750,
                 "retention_incentive": 0, "arrears": 0,
                 "incentive_or_project_allowwance": 8000, "total": 80250 },
  "deductions": { "income_tax": 4200, "provident_fund": 1800, "professional_tax": 200,
                  "esi": 0, "other_deductions": 0, "salary_advance": 0,
                  "health_insurance_premium": 600, "gmc_premium": 350, "total": 7150 },
  "net_amount": 73100, "standard_days": 30, "days_worked": 30,
  // masked by default ("xxxxxx1234"); full when unmasked=true
  "pf_no": "xxxxxx1234", "uan_number": "xxxxxx7812", "account_no": "xxxxxx8901",
  // always full
  "pan_no": "ABCPV1234R", "bank_name": "HDFC Bank"
}
```
Notes: `net_amount` = earnings.total − deductions.total. `earnings`/`deductions` always carry full amounts. Field name `incentive_or_project_allowwance` has the double-w (matches the data model).

```js
const qs = new URLSearchParams({ year, month });
if (showFull) qs.set("unmasked", "true");          // e.g. a "show full details" toggle
const res = await fetch(`${BASE_URL}/my-payroll?${qs}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const payslip = await res.json();                  // Payslip | null
if (!payslip) showEmptyState();
```

---

## 2) `GET /my-payroll/export` — download payslip PDF

Downloads the employee's payslip for a period as a **password-protected PDF**.

**Query params (required):** `year` (2000–2100), `month` (1–12).

**Response `200`:** a PDF file —
- `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="payslip_2026_06.pdf"`
- **The PDF open-password is the employee's 6-digit PIN** (see §4).
- Response header **`X-Payslip-Pin-Emailed: true`** when a PIN was just generated and emailed → prompt the user: *"We've emailed your PIN — use it to open the PDF."* (`false` = the employee already had a PIN.)
- **`404`** if there's no payslip for that period.

The PDF carries the employee's **full** details (it's their own document).

```js
const res = await fetch(`${BASE_URL}/my-payroll/export?year=${year}&month=${month}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (res.status === 404) return showEmptyState();
if (res.headers.get("X-Payslip-Pin-Emailed") === "true") {
  notify("We've emailed your PIN. Use it to open the downloaded PDF.");
}
const blob = await res.blob();
const url = URL.createObjectURL(blob);
Object.assign(document.createElement("a"), { href: url, download: `payslip_${year}_${month}.pdf` }).click();
URL.revokeObjectURL(url);
```

---

## 3) `POST /my-payroll/pin/regenerate` — reset PIN

Generates a **new** PIN for the employee and emails it. The PIN is **never** returned in the response.

**Response `200`:** `{ "code": "PIN_REGENERATED", "detail": "A new PIN has been generated and emailed to you." }`

```js
await fetch(`${BASE_URL}/my-payroll/pin/regenerate`, {
  method: "POST", headers: { Authorization: `Bearer ${token}` },
});
notify("A new PIN has been emailed to you. Re-download your payslip to open it with the new PIN.");
```

---

## 4) PIN + PDF flow (read this)

- Each employee has one **standing 6-digit PIN**. It is the **open-password** for their payslip PDFs and is stored encrypted server-side.
- The PIN is delivered **only by email** (template "Your new PIN for viewing payslips") — never in an API response.
- **First download:** the employee has no PIN yet → the export auto-generates one, emails it (`X-Payslip-Pin-Emailed: true`), and returns the PDF locked with that PIN. The user opens the PDF using the PIN from their inbox.
- **Subsequent downloads:** `X-Payslip-Pin-Emailed: false` — same PIN, no new email.
- **Reset:** `POST /my-payroll/pin/regenerate` emails a new PIN. The new PIN applies to **future** exports — after resetting, the user should **re-download** the payslip; a PDF downloaded earlier still opens with the *old* PIN it was encrypted with.

**Suggested UI**
- My Payroll screen: month/year selector → `GET /my-payroll`; render earnings/deductions/net + employee info ("—" for the IAM fields), with an optional "Show full PF/UAN/account" toggle → re-fetch with `unmasked=true`.
- "Download PDF" button → `GET /my-payroll/export`; on `X-Payslip-Pin-Emailed: true`, surface the "check your email for the PIN" hint.
- "Reset PIN" action → `POST /my-payroll/pin/regenerate`; on success, tell the user to re-download.
