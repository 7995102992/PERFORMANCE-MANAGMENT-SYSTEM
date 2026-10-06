# PMS API – Frontend Guide

Written for: frontend developers integrating screens 1.1–1.6 (appraisal cycles), 2.1–2.4 (goal templates), 2.5–2.10 (KRA, KPI, competency and rating-scale masters).

This document lists **every** endpoint exposed by `pms-app`, what each one does, what to send, what comes back, and which errors to handle.

---

## 1. Basics

| Item | Value |
|---|---|
| Base path | `/api/v1/pms` |
| Full example | `https://<host>/api/v1/pms/get/cycles` |
| Format | JSON in and out (except CSV export) |
| Field naming | `snake_case` everywhere (`cycle_code`, `period_start`, `kra_id`) |
| IDs | PMS-owned ids (cycles, templates, KRAs, KPIs, competencies, rating scales) are UUID strings, e.g. `3f2504e0-4f89-11d3-9a0c-0305e82c3301`. Sentrifugo ids (organisation, plant, department, role) are 24-character hex strings, e.g. `6aae4eb6c67aad006ac331e0`. |
| Dates | `LocalDate` → `"YYYY-MM-DD"`; `LocalDateTime` → `"YYYY-MM-DDTHH:mm:ss"` |
| Decimals | JSON numbers, e.g. `40.00` (weightages, scores) |
| CSRF | Not used. Auth is by bearer token only. |
| Sessions | Stateless. No cookies are needed. |

### 1.1 Authentication

Every endpoint needs a bearer token obtained from IAM login (`POST /auth/login` on IAM):

```http
Authorization: Bearer <access_token>
```

Send the token **without** a `Bearer ` prefix in the Swagger UI "Authorize" box; Swagger adds the prefix itself. In your own code, add the prefix in the header as shown above.

The organisation is taken from the token, never from the request. Do not send `organisation_id` in any body or query.

### 1.2 Permissions

There are two kinds of endpoints:

| Kind | Who can call it |
|---|---|
| **Read** (`GET`) | Any authenticated user of the organisation |
| **Write** (`POST`, `PUT`, `DELETE`) | Users with `performance_management` → `create_resource` in IAM, or org/super admins |

If a write is attempted without the permission, the API returns `403 FORBIDDEN` (see §2.3). Hide or disable write buttons based on the user's permissions.

### 1.3 Success envelope

Every JSON success response uses this shape:

```json
{
  "success": true,
  "message": "PMS cycle retrieved successfully",
  "data": { }
}
```

- `message` is human-readable text you can show in a toast.
- `data` is the payload described under each endpoint. For delete endpoints, `data` is `null`.
- List endpoints add a count to the message, e.g. `"Found 3 KRAs"`.

Exception: the **CSV export** endpoint returns the raw file (see §3.2), not this envelope.

### 1.4 Error envelope

All errors use this shape:

```json
{
  "detail": "Cycle not found",
  "code": "PMS_CYCLE_NOT_FOUND"
}
```

- `detail` is a message you can show to the user (or log).
- `code` is a stable identifier you should branch on.

---

## 2. Error reference

### 2.1 HTTP status and codes

| HTTP | `code` | When | Example `detail` |
|---|---|---|---|
| 400 | `BAD_REQUEST` | Body is not valid JSON, or a path/query value has the wrong type (e.g. `cycleId=abc`, `skip=x`). | `Malformed request` |
| 401 | `UNAUTHORIZED` | Token missing, expired or unknown. | `Missing bearer token` or the session error message |
| 403 | `FORBIDDEN` | Token is valid but the user lacks the write permission. | `You do not have permission to perform this action` |
| 403 | `PMS_INVALID_ORGANISATION` | The session has no organisation id. | `The session has no organisation.` |
| 404 | `NOT_FOUND` | Unknown URL. | `Not found` |
| 404 | `PMS_CYCLE_NOT_FOUND` | Cycle id not in this organisation. | `Cycle not found` |
| 404 | `PMS_TEMPLATE_NOT_FOUND` | Goal template id not in this organisation. | `Goal template not found` |
| 404 | `PMS_KRA_NOT_FOUND` | KRA id not found. | `KRA not found` |
| 404 | `PMS_KPI_NOT_FOUND` | KPI id not found. | `KPI not found` |
| 404 | `PMS_COMPETENCY_NOT_FOUND` | Competency id not found. | `Competency not found` |
| 404 | `PMS_RATING_SCALE_NOT_FOUND` | Rating scale id not found. | `Rating scale not found` |
| 409 | `PMS_KRA_DUPLICATE` | KRA name already exists (case-insensitive). | `A KRA named '…' already exists.` |
| 409 | `PMS_KPI_DUPLICATE` | KPI name already exists under the same KRA (case-insensitive). | `A KPI named '…' already exists under this KRA.` |
| 409 | `PMS_COMPETENCY_DUPLICATE` | Competency name already exists (case-insensitive). | `A competency named '…' already exists.` |
| 409 | `PMS_KRA_IN_USE` | Deleting a KRA that has KPIs or is used by a template. | `Cannot delete a KRA that still has KPIs under it.` |
| 409 | `PMS_KPI_IN_USE` | Deleting a KPI used by a goal template. | `Cannot delete a KPI used in a goal template.` |
| 409 | `PMS_COMPETENCY_IN_USE` | Deleting a competency used by a goal template. | `Cannot delete a competency used in a goal template.` |
| 409 | `PMS_CYCLE_NOT_EDITABLE` | Editing a cycle that is CLOSED or CANCELLED. | `Only a draft or active cycle can be edited.` |
| 409 | `PMS_CYCLE_NOT_CANCELLABLE` | Cancelling a cycle that is CLOSED or CANCELLED. | `Only a draft or active cycle can be cancelled.` |
| 409 | `PMS_CYCLE_NOT_PUBLISHABLE` | Publishing a cycle that is not DRAFT. | `Only a draft cycle can be published.` |
| 409 | `PMS_CYCLE_NOT_PUBLISHED` | Asking for activation of a DRAFT cycle. | `This cycle has not been published yet.` |
| 422 | `VALIDATION_ERROR` | Bean validation failed (required field missing, too long, wrong range) **or** a business rule was broken with this generic code. | `name: must not be blank; period_end: must not be null` |
| 422 | `PMS_CYCLE_PUBLISH_VALIDATION_FAILED` | Cycle is not complete enough to publish. | `Cycle cannot be published: a rating scale must be selected; …` |
| 422 | `PMS_TEMPLATE_INCOMPLETE` | Template step saved as complete but is missing KRAs, KPIs or competencies, or weightages are wrong. | `KPI weightage must total 100 (got 90).` |
| 422 | (domain codes like `PMS_KRA_NOT_FOUND`, `PMS_RATING_SCALE_NOT_FOUND`) | A referenced id is inactive or not found inside a save body. | `kra_id 3f… does not refer to an active KRA` |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected server error. | `An unexpected error occurred.` |

Notes for the frontend:

- **422 is used for validation.** Read `code`: `VALIDATION_ERROR` means a field or generic rule; `PMS_*` codes are business rules you can map to specific UI messages.
- For `VALIDATION_ERROR` from bean validation, `detail` is `field: message` pairs joined by `; `. Parse it for inline field errors, or show it as a single banner.

### 2.2 Shared enums (send and receive as lowercase strings)

Input is case-insensitive, but **always send lowercase**. Responses are always lowercase.

| Field | Allowed values |
|---|---|
| Cycle `type` | `annual`, `mid_year`, `custom` |
| Cycle `status` | `draft`, `active`, `closed`, `cancelled` |
| Cycle stage `stage` | `goal_setting`, `employee_acknowledgement`, `hod_approval`, `progress_tracking`, `mid_year_review`, `self_appraisal`, `manager_appraisal`, `hod_review`, `calibration_final_approval` |
| Employment type | `permanent`, `contract`, `trainee` |
| Goal template `status` | `draft`, `active`, `inactive` |
| Master `status` (KRA, KPI, competency, rating scale) | `active`, `inactive` |
| KPI / target `target_type` | `individual`, `common` |

### 2.3 Auth failure handling

- On `401`, clear the stored token and send the user to login.
- On `403` with `FORBIDDEN`, keep the user on the page and show a "no permission" message. Do not retry.

---

## 3. Appraisal cycles — `/pms-cycle`

Covers screens 1.1 to 1.6. The cycle wizard has four steps: **Basic (1.2) → Stages (1.3) → Applicability (1.4) → Finalize (1.5)**, then **Publish**, then **Activation (1.6)**.

Shared types used below:

**`CycleBasic`** (screen 1.2)

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | 1–200 chars |
| `description` | string | no | max 2000 |
| `type` | string | yes | `annual`, `mid_year` or `custom` |
| `period_start` | date | yes | `YYYY-MM-DD` |
| `period_end` | date | yes | `YYYY-MM-DD`, must be after `period_start` |

**`CycleStage`** (screen 1.3)

| Field | Type | Required | Rules |
|---|---|---|---|
| `stage` | string | yes | One of the stage values in §2.2, unique per cycle |
| `start_date` | date | no | |
| `end_date` | date | no | Must not be before `start_date` |
| `notify` | boolean | no | Notify for this stage |

**`CycleApplicability`** (screen 1.4)

| Field | Type | Rules |
|---|---|---|
| `all_plants` | boolean | If `true`, `plant_ids` is ignored |
| `plant_ids` | string[] | Sentrifugo plant ids (24-character strings) |
| `all_departments` | boolean | If `false`, `department_ids` must have at least one id on publish |
| `department_ids` | string[] | Sentrifugo department ids (24-character strings) |
| `employment_types` | string[] | `permanent`, `contract`, `trainee` |
| `min_service_months` | integer | ≥ 0. Required on publish. |
| `service_as_on` | date | Date used to calculate service. Required on publish. |
| `exclude_probation` | boolean | |
| `exclude_notice_period` | boolean | |

**`CycleFinalize`** (screen 1.5)

| Field | Type | Rules |
|---|---|---|
| `rating_scale_id` | UUID | Must be an **active** rating scale. Required on publish. |
| `notify_managers` | boolean | |
| `notify_employees` | boolean | |
| `notify_hod` | boolean | |
| `notify_hr` | boolean | |

---

### 3.1 List cycles (screen 1.1)

`GET /api/v1/pms/pms-cycle/get/cycles`

Any authenticated user.

**Query parameters** (all optional)

| Name | Type | Default | Notes |
|---|---|---|---|
| `search` | string | | Matches cycle code or name |
| `year` | integer | | Financial year, e.g. `2026` |
| `type` | string | | `annual`, `mid_year`, `custom` |
| `plant_id` | string | | |
| `status` | string | | `draft`, `active`, `closed`, `cancelled`. Does **not** change `summary`. |
| `skip` | integer | `0` | Must be a multiple of `limit`. Otherwise `422 VALIDATION_ERROR`. |
| `limit` | integer | `20` | Max `100`. Values ≤ 0 use `20`. |

**Response `data`**

```json
{
  "items": [
    {
      "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "cycle_code": "PMS-2526-A",
      "name": "Annual Appraisal FY 2025-26",
      "type": "annual",
      "period_start": "2025-04-01",
      "period_end": "2026-03-31",
      "applicable_to": "All Plants",
      "status": "active",
      "created_on": "2026-01-10"
    }
  ],
  "total": 1,
  "summary": { "all": 4, "draft": 1, "active": 2, "closed": 1, "cancelled": 0 }
}
```

| Field | Notes |
|---|---|
| `items[].applicable_to` | `"All Plants"` when the cycle covers all plants, otherwise `null`. The UI should show plant names itself. PMS does not know them. |
| `total` | Count matching **all filters**, for pagination |
| `summary` | Counts by status. **Ignores** the `status` filter, so tabs keep their numbers. |

**Pagination:** `page = skip / limit`. Next page is `skip + limit` while `skip + limit < total`.

**Message:** `"Found N PMS cycles"`.

---

### 3.2 Export cycles as CSV (screen 1.1 "Export Data")

`GET /api/v1/pms/pms-cycle/get/cycles/export`

Same query parameters as §3.1, except `skip` and `limit` (all matching rows are exported).

**Response:** raw bytes, **not** the JSON envelope.

- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="pms-cycles.csv"`

Frontend: fetch as a blob with the `Authorization` header and trigger a download. A plain `<a href>` will not send the bearer token.

Error responses (401, 403, 404) are still JSON.

---

### 3.3 Get one cycle (screens 1.2–1.5 edit / view)

`GET /api/v1/pms/pms-cycle/get/cycle/{cycleId}`

Any authenticated user. Returns `404 PMS_CYCLE_NOT_FOUND` if the cycle is not in the user's organisation.

**Path:** `cycleId` (UUID)

**Response `data`:** a `PmsCycleResponse`

```json
{
  "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "cycle_code": "PMS-2526-A",
  "status": "draft",
  "created_on": "2026-01-10",
  "published_on": null,
  "applicable_to": null,
  "basic": {
    "name": "Annual Appraisal FY 2025-26",
    "description": "Year-end appraisal",
    "type": "annual",
    "period_start": "2025-04-01",
    "period_end": "2026-03-31"
  },
  "stages": [
    { "stage": "goal_setting", "start_date": "2025-04-01", "end_date": "2025-04-30", "notify": true }
  ],
  "applicability": {
    "all_plants": true,
    "plant_ids": [],
    "all_departments": true,
    "department_ids": [],
    "employment_types": ["permanent", "contract"],
    "min_service_months": 6,
    "service_as_on": "2026-03-31",
    "exclude_probation": true,
    "exclude_notice_period": false
  },
  "finalize": {
    "rating_scale_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "notify_managers": true,
    "notify_employees": true,
    "notify_hod": false,
    "notify_hr": true
  },
  "current_step": 2,
  "completed_step": 1
}
```

| Field | Notes |
|---|---|
| `status` | `draft`, `active`, `closed`, `cancelled` |
| `applicable_to` | `"All Plants"` or `null` |
| `stages` | Only the stages saved so far. May be empty. |
| `applicability.allPlants` etc. | Booleans are always present (`false` if never set). |
| `finalize` | `null` if not saved yet. Check for null before reading inner fields. |
| `current_step` / `completed_step` | Where the user is in the wizard. Use these to restore progress. |

---

### 3.4 Create cycle (screen 1.2 "Next")

`POST /api/v1/pms/pms-cycle/create/cycle` — **write**

Creates a **DRAFT** cycle. The server generates `cycle_code` as `PMS-{FY start yy}{FY end yy}-{A|M|C}` (A = annual, M = mid_year, C = custom).

**Request body**

```json
{
  "basic": {
    "name": "Annual Appraisal FY 2025-26",
    "description": "Year-end appraisal",
    "type": "annual",
    "period_start": "2025-04-01",
    "period_end": "2026-03-31"
  },
  "stages": [],
  "applicability": null,
  "finalize": null,
  "current_step": 2,
  "completed_step": 1
}
```

| Field | Required | Notes |
|---|---|---|
| `basic` | **yes** | See `CycleBasic` |
| `stages` | no | Array of `CycleStage`. Can be omitted on create. |
| `applicability` | no | `CycleApplicability` |
| `finalize` | no | `CycleFinalize` |
| `current_step` | no | 1–4 |
| `completed_step` | no | 0–4 |

Stages, applicability and finalize are **not** checked for completeness here. That happens on publish.

**Response:** `201 Created`, `data` = `PmsCycleResponse` (same as §3.3).

**Errors:** `403` no permission · `422 VALIDATION_ERROR` (missing `basic`, bad type, end before start, etc.)

---

### 3.5 Update cycle (screens 1.2–1.5 Next / Previous)

`PUT /api/v1/pms/pms-cycle/update/cycle/{cycleId}` — **write**

Saves the whole wizard state for a DRAFT or ACTIVE cycle. Send the same body shape as create.

**Replacement rules**

- `basic` is always replaced.
- `stages`, `applicability`, `finalize`: if **supplied**, replace what is stored. If **omitted** (`null` / missing), they are left unchanged.
- Because a supplied `stages` list **replaces** the old list, always send the full list.

**Errors:** `409 PMS_CYCLE_NOT_EDITABLE` for CLOSED or CANCELLED cycles · `404 PMS_CYCLE_NOT_FOUND` · `422` validation.

**Response:** `200 OK`, `data` = `PmsCycleResponse`.

---

### 3.6 Publish cycle (screen 1.5 "Publish Cycle")

`POST /api/v1/pms/pms-cycle/publish/cycle/{cycleId}` — **write**

No request body.

Moves a complete DRAFT cycle to **ACTIVE** and stamps `published_on`. Publishing requires all of the following:

- A rating scale selected (`finalize.rating_scale_id`), and that scale must be active
- At least one plant (or `all_plants = true`)
- At least one department, unless `all_departments = true`
- `min_service_months` set
- `service_as_on` set
- At least one employment type
- Start **and** end dates for **all nine** stages

If any of these are missing, the response is `422 PMS_CYCLE_PUBLISH_VALIDATION_FAILED` and `detail` lists every problem separated by `; `. Show it so the user can fix them.

Also: publishing a non-DRAFT cycle returns `409 PMS_CYCLE_NOT_PUBLISHABLE`.

**Response:** `200 OK`, `data` = `PmsCycleActivationResponse` (see §3.7).

> Eligibility processing and notifications are not implemented yet. Publishing only changes the status.

---

### 3.7 Get activation (screen 1.6)

`GET /api/v1/pms/pms-cycle/get/cycle/{cycleId}/activation`

Returns the published cycle and what was recorded about notifications and eligibility.

**Errors:** `409 PMS_CYCLE_NOT_PUBLISHED` for a DRAFT cycle · `404 PMS_CYCLE_NOT_FOUND`.

**Response `data`**

```json
{
  "cycle": { "...same as PmsCycleResponse..." },
  "published_on": "2026-02-01",
  "notifications": [],
  "eligibility": null
}
```

| Field | Notes |
|---|---|
| `published_on` | `YYYY-MM-DD` |
| `notifications` | Array of `{ audience, sent, status, sent_on }`. **Empty today**, because nothing writes notifications yet. |
| `notifications[].audience` | `hod_reviewers`, `reporting_managers`, `employees`, `hr` |
| `notifications[].status` | `pending`, `sent`, `failed`, `partial` |
| `eligibility` | `null` until an eligibility run exists. When present: `{ status, started_on, completed_on, total_eligible, excluded_probation, excluded_notice_period, excluded_min_service }`. `status` is `started`, `completed` or `failed`. |

Show "Not started" / empty states for these fields. Do not invent counts.

---

### 3.8 Cancel cycle

`POST /api/v1/pms/pms-cycle/cancel/cycle/{cycleId}` — **write**

No request body. Cancels a DRAFT or ACTIVE cycle and sets `status = cancelled`.

**Errors:** `409 PMS_CYCLE_NOT_CANCELLABLE` for CLOSED or CANCELLED cycles.

**Response:** `200 OK`, `data` = `PmsCycleResponse`.

---

## 4. Goal templates — `/pms-goal-template`

Covers screens 2.1 to 2.4. Wizard: **Basic info (2.2) → KRA & KPI (2.3) → Competencies (2.4)**.

A template starts as `draft`. It becomes `active` only when its KRA/KPI step **and** its competency step are both complete.

**`GoalTemplateBasic`** (screen 2.2)

| Field | Type | Required | Rules |
|---|---|---|---|
| `financial_year` | string | yes | max 20, e.g. `"2025-26"` |
| `template_name` | string | yes | max 200 |
| `description` | string | no | max 2000 |
| `department_id` | string | yes | Sentrifugo department id (24-character string) |
| `role_id` | string | yes | Sentrifugo role id (24-character string) |
| `plant_id` | string | no | Sentrifugo plant id (24-character string) |
| `effective_from` | date | yes | `YYYY-MM-DD` |
| `status` | string | no | `draft`, `active`, `inactive`. See notes below. |

Status rules for create and basic-info update:

- `inactive` is kept as `inactive`.
- Anything else, including `active`, is stored as `draft`.
- `active` is only accepted on **update** when the template is already complete. Otherwise it stays `draft`.

**Goal template response** (`PmsGoalTemplateResponse`), used by §4.2–4.5

```json
{
  "id": "a1b2c3d4-0000-4000-8000-000000000001",
  "financial_year": "2025-26",
  "template_name": "Plant Engineer – FY 2025-26",
  "description": "Standard engineer goals",
  "department_id": "…",
  "role_id": "…",
  "plant_id": "…",
  "effective_from": "2025-04-01",
  "status": "active",
  "kras": [
    {
      "kra_id": "…",
      "kra_name": "Production Excellence",
      "kpis": [
        {
          "kpi_id": "…",
          "kpi_name": "OEE %",
          "unit": "%",
          "weightage": 60.00,
          "target_type": "individual",
          "expected_outcome": "Improve OEE",
          "evidence_required": "MES report"
        }
      ]
    }
  ],
  "competencies": [
    { "competency_id": "…", "name": "Communication", "category": "Behavioural", "weightage": 100.00 }
  ],
  "total_kpi_weightage": 100.00,
  "total_competency_weightage": 100.00
}
```

| Field | Notes |
|---|---|
| `department_id`, `role_id`, `plant_id` | Ids only. Department, role and plant **names** must be looked up in Sentrifugo. |
| `kras[].kpis[].expected_outcome`, `evidence_required` | Come from the KPI master. A template cannot override them. |
| `total_kpi_weightage`, `total_competency_weightage` | Running totals for the progress bar. |

---

### 4.1 List goal templates (screen 2.1)

`GET /api/v1/pms/pms-goal-template/get/goal-templates`

Any authenticated user. All query parameters are optional.

| Name | Type | Notes |
|---|---|---|
| `financial_year` | string | e.g. `2025-26` |
| `department_id` | string | |
| `plant_id` | string | |
| `search` | string | Searches template name |

**Response `data`:** array of

```json
{
  "id": "a1b2c3d4-0000-4000-8000-000000000001",
  "template_name": "Plant Engineer – FY 2025-26",
  "financial_year": "2025-26",
  "department_id": "…",
  "role_id": "…",
  "plant_id": "…",
  "effective_from": "2025-04-01",
  "status": "active"
}
```

Message: `"Found N goal templates"`. Not paginated.

---

### 4.2 Get a goal template (screens 2.2–2.4 edit / view)

`GET /api/v1/pms/pms-goal-template/get/goal-template/{templateId}`

**Path:** `templateId` (UUID). Returns `404 PMS_TEMPLATE_NOT_FOUND` if not found.

**Response `data`:** `PmsGoalTemplateResponse` (shape above).

Use it to load the wizard for edit: fill step 1 from the top-level fields, step 2 from `kras`, step 3 from `competencies`.

---

### 4.3 Create goal template (screen 2.2 "Save and Next")

`POST /api/v1/pms/pms-goal-template/create/goal-template` — **write**

**Request body:** `GoalTemplateBasic` (see above). Example:

```json
{
  "financial_year": "2025-26",
  "template_name": "Plant Engineer – FY 2025-26",
  "description": "Standard engineer goals",
  "department_id": "…",
  "role_id": "…",
  "plant_id": "…",
  "effective_from": "2025-04-01",
  "status": "draft"
}
```

**Response:** `201 Created`, `data` = `PmsGoalTemplateResponse` with empty `kras` and `competencies`. Keep the returned `id` for steps 2.3 and 2.4.

**Errors:** `422 VALIDATION_ERROR` · `403` no permission.

---

### 4.4 Update goal template basic info (screen 2.2)

`PUT /api/v1/pms/pms-goal-template/update/goal-template/{templateId}` — **write**

Same body as §4.3. It **replaces** all basic fields; send the full object.

**Response:** `200 OK`, `data` = `PmsGoalTemplateResponse` (the `kras` and `competencies` are kept).

If the stored template is `active` but no longer complete, the server sets it back to `draft`.

---

### 4.5 Save KRA and KPI configuration (screen 2.3)

`PUT /api/v1/pms/pms-goal-template/update/goal-template/{templateId}/kra-kpi` — **write**

Replaces **all** KRA and KPI selections of the template in one transaction.

**Request body**

```json
{
  "save_as_draft": false,
  "kras": [
    {
      "kra_id": "…",
      "kpis": [
        { "kpi_id": "…", "weightage": 60.00, "target_type": "individual" },
        { "kpi_id": "…", "weightage": 40.00 }
      ]
    }
  ]
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `save_as_draft` | boolean | no | `true` = "Save as Draft": incomplete data allowed. `false` or omitted = "Save and Next": full validation. |
| `kras` | array | yes (may be empty when `save_as_draft` is `true`) | Each KRA once |
| `kras[].kra_id` | UUID | yes | Must be an **active** KRA |
| `kras[].kpis` | array | yes | Each KPI once across the template |
| `kpis[].kpi_id` | UUID | yes | Must be an **active** KPI that belongs to its KRA |
| `kpis[].weightage` | decimal | yes | `> 0` and `≤ 100` |
| `kpis[].target_type` | string | no | `individual` or `common`. Defaults to the KPI master's value. |

**Rules when `save_as_draft` is false**

- Every selected KRA needs at least one KPI.
- Total KPI weightage must equal exactly `100` (or `422 PMS_TEMPLATE_INCOMPLETE`: `KPI weightage must total 100 (got 90).`).
- At least one KRA must be selected (`PMS_TEMPLATE_INCOMPLETE`).

When `save_as_draft` is `true`, the total can be anything up to `100`. Over 100 is always rejected.

**Response:** `200 OK`, `data` = `PmsGoalTemplateResponse`.

**Errors:** `404 PMS_TEMPLATE_NOT_FOUND` · `422 PMS_KRA_NOT_FOUND` / `PMS_KPI_NOT_FOUND` (inactive or unknown id) · `422 VALIDATION_ERROR` (KPI not under its KRA, duplicate KRA/KPI) · `422 PMS_TEMPLATE_INCOMPLETE`.

---

### 4.6 Save competency configuration (screen 2.4)

`PUT /api/v1/pms/pms-goal-template/update/goal-template/{templateId}/competencies` — **write**

Replaces all competencies of the template and their weightages in one transaction.

**Request body**

```json
{
  "competencies": [
    { "competency_id": "…", "weightage": 50.00 },
    { "competency_id": "…", "weightage": 50.00 }
  ]
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `competencies` | array | yes | May be empty to clear. Each competency once. |
| `competency_id` | UUID | yes | Must be an **active** competency |
| `weightage` | decimal | yes | `> 0` and `≤ 100` |

When the list is not empty, weightages **must total exactly 100**, otherwise `422 PMS_TEMPLATE_INCOMPLETE` (`Competency weightage must total 100 (got N).`).

If the template now has complete KRA/KPI data and competencies, it becomes `active`.

**Response:** `200 OK`, `data` = `PmsGoalTemplateResponse`.

---

## 5. Master data — `/pms-master`

Three groups: **KRA** (screens 2.5, 2.6), **KPI** (2.7, 2.8), **Competency** (2.9).

### 5.1 KRA

**`KraRequest`**

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | 1–200 chars. Unique per organisation, case-insensitive. |
| `status` | string | no | `active` or `inactive`. Default `active` on create. On update, omitting it leaves the status as is. |

**`KraResponse`**

```json
{ "id": "…", "name": "Production Excellence", "status": "active" }
```

#### 5.1.1 List KRAs (screen 2.5, dropdowns)

`GET /api/v1/pms/pms-master/get/kras` — any authenticated user.

**Response `data`:** array of `KraResponse`, oldest first. Message: `"Found N KRAs"`.

#### 5.1.2 Create KRA (screen 2.6)

`POST /api/v1/pms/pms-master/create/kra` — **write**

Body: `KraRequest`. **Response:** `201 Created`, `data` = `KraResponse`.

**Errors:** `409 PMS_KRA_DUPLICATE` if the name exists.

#### 5.1.3 Update KRA (screen 2.5 edit)

`PUT /api/v1/pms/pms-master/update/kra/{kraId}` — **write**

Body: `KraRequest` (renames and/or changes status). **Response:** `200 OK`, `data` = `KraResponse`.

**Errors:** `404 PMS_KRA_NOT_FOUND` · `409 PMS_KRA_DUPLICATE` if the new name is taken.

#### 5.1.4 Delete KRA (screen 2.5 delete)

`DELETE /api/v1/pms/pms-master/delete/kra/{kraId}` — **write**

No body. **Response:** `200 OK`, `data: null`, message `"KRA deleted successfully"`.

**Errors:** `409 PMS_KRA_IN_USE` if the KRA still has KPIs or is used by a goal template. Remove those first.

---

### 5.2 KPI

**`KpiRequest`**

| Field | Type | Required | Rules |
|---|---|---|---|
| `kra_id` | UUID | yes | Parent KRA. Must exist. |
| `name` | string | yes | 1–200 chars. Unique per KRA. |
| `unit` | string | yes | 1–50 chars. Pick from the list in §5.2.2. |
| `target_type` | string | yes | `individual` or `common` |
| `expected_outcome` | string | no | max 500 |
| `evidence_required` | string | no | max 500 |
| `status` | string | no | `active` or `inactive`. Default `active`. |

**`KpiResponse`**

```json
{
  "id": "…",
  "kra_id": "…",
  "kra_name": "Production Excellence",
  "name": "OEE %",
  "unit": "%",
  "target_type": "individual",
  "expected_outcome": "Improve OEE",
  "evidence_required": "MES report",
  "status": "active"
}
```

#### 5.2.1 List KPIs (screen 2.7)

`GET /api/v1/pms/pms-master/get/kpis` — any authenticated user.

**Response `data`:** array of `KpiResponse`. Message `"Found N KPIs"`.

#### 5.2.2 List KPI units (screen 2.8 unit dropdown)

`GET /api/v1/pms/pms-master/get/kpi-units` — any authenticated user. Fixed list, not from the database.

**Response `data`:** `["TPD", "kcal/kg", "%", "kWh/t", "Count", "Months", "MPa"]`

#### 5.2.3 Create KPI (screen 2.8)

`POST /api/v1/pms/pms-master/create/kpi` — **write**

Body: `KpiRequest`. **Response:** `201 Created`, `data` = `KpiResponse`.

**Errors:** `404 PMS_KRA_NOT_FOUND` (kra_id unknown) · `409 PMS_KPI_DUPLICATE` if the name already exists under this KRA · `422 VALIDATION_ERROR` if `target_type` is not `individual` or `common`.

#### 5.2.4 Update KPI (screen 2.7 edit)

`PUT /api/v1/pms/pms-master/update/kpi/{kpiId}` — **write**

Body: `KpiRequest`. It **replaces** every field, including `kra_id`. **Response:** `200 OK`, `data` = `KpiResponse`.

**Errors:** `404 PMS_KPI_NOT_FOUND` / `PMS_KRA_NOT_FOUND` · `409 PMS_KPI_DUPLICATE` under the KRA.

#### 5.2.5 Delete KPI (screen 2.7 delete)

`DELETE /api/v1/pms/pms-master/delete/kpi/{kpiId}` — **write**

**Response:** `200 OK`, `data: null`. **Errors:** `409 PMS_KPI_IN_USE` if a goal template uses it.

---

### 5.3 Competency (screen 2.9)

Screen 2.9 has no add button. Competencies are created through the endpoint below.

**`CompetencyRequest`**

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | 1–200 chars. Unique per organisation. |
| `category` | string | yes | 1–100 chars, e.g. `Behavioural` |
| `status` | string | no | `active` or `inactive`. Default `active`. |

**`CompetencyResponse`**

```json
{ "id": "…", "name": "Communication", "category": "Behavioural", "status": "active" }
```

#### 5.3.1 List competencies (screen 2.9, screen 2.4 picker)

`GET /api/v1/pms/pms-master/get/competencies`

| Name | Type | Notes |
|---|---|---|
| `search` | string | Case-insensitive substring match on name. Optional. |

**Response `data`:** array of `CompetencyResponse`. Message `"Found N competencies"`.

#### 5.3.2 Create competency

`POST /api/v1/pms/pms-master/create/competency` — **write**

Body: `CompetencyRequest`. **Response:** `201 Created`, `data` = `CompetencyResponse`.

**Errors:** `409 PMS_COMPETENCY_DUPLICATE` if the name already exists.

#### 5.3.3 Update competency (screen 2.9 edit)

`PUT /api/v1/pms/pms-master/update/competency/{competencyId}` — **write**

Body: `CompetencyRequest`. **Response:** `200 OK`, `data` = `CompetencyResponse`.

**Errors:** `404 PMS_COMPETENCY_NOT_FOUND` · `409 PMS_COMPETENCY_DUPLICATE`.

#### 5.3.4 Delete competency (screen 2.9 delete)

`DELETE /api/v1/pms/pms-master/delete/competency/{competencyId}` — **write**

**Response:** `200 OK`, `data: null`. **Errors:** `409 PMS_COMPETENCY_IN_USE` if a goal template uses it.

---

## 6. Rating scales — `/pms-rating-scale`

Covers the dropdown on screen 1.5 and the editor on screen 2.10.

**`RatingScaleRequest`**

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | 1–150 chars |
| `description` | string | no | |
| `status` | string | no | `active` or `inactive`. Default `active`. |
| `is_default` | boolean | no | Setting `true` clears the default on the organisation's other scales. |
| `show_definitions_to_employees` | boolean | no | |
| `levels` | array | yes | At least one level |

**`RatingScaleLevel`** (inside `levels`)

| Field | Type | Required | Rules |
|---|---|---|---|
| `rating_value` | integer | yes | ≥ 1. Unique within the scale. |
| `label` | string | yes | 1–100 chars, e.g. `Exceeds` |
| `definition` | string | no | |
| `minimum_score` | decimal | yes | 0.00 – 999.99 |
| `maximum_score` | decimal | yes | 0.00 – 999.99. Must be ≥ `minimum_score`. |
| `colour_code` | string | no | Hex `#RRGGBB`, e.g. `#22C55E` |
| `display_order` | integer | no | |

Score ranges of different levels **must not overlap**.

**`RatingScaleResponse`**

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "name": "5-point scale",
  "description": "Default appraisal scale",
  "status": "active",
  "is_default": true,
  "show_definitions_to_employees": true,
  "levels": [
    {
      "rating_value": 5,
      "label": "Outstanding",
      "definition": "Consistently exceeds expectations",
      "minimum_score": 90.00,
      "maximum_score": 100.00,
      "colour_code": "#22C55E",
      "display_order": 1
    }
  ]
}
```

Levels are returned **highest rating first**.

### 6.1 List rating scales

`GET /api/v1/pms/pms-rating-scale/get/rating-scales`

| Name | Type | Notes |
|---|---|---|
| `status` | string | Pass `active` to fill the cycle wizard dropdown (screen 1.5). Omit for all scales (screen 2.10). |

**Response `data`:** array of `RatingScaleResponse`. Message `"Found N rating scales"`.

### 6.2 Get one rating scale (screen 2.10)

`GET /api/v1/pms/pms-rating-scale/get/rating-scale/{scaleId}`

**Response `data`:** `RatingScaleResponse`. **Errors:** `404 PMS_RATING_SCALE_NOT_FOUND`.

### 6.3 Create rating scale

`POST /api/v1/pms/pms-rating-scale/create/rating-scale` — **write**

Body: `RatingScaleRequest`. **Response:** `201 Created`, `data` = `RatingScaleResponse`.

Errors: `422 VALIDATION_ERROR` for overlapping score ranges, duplicate `rating_value`, or `minimum_score > maximum_score`.

### 6.4 Save rating scale (screen 2.10 "Save Scale")

`PUT /api/v1/pms/pms-rating-scale/update/rating-scale/{scaleId}` — **write**

Body: `RatingScaleRequest`. Replaces name, status, flags, and **syncs levels by `rating_value`** (send the full level list). **Response:** `200 OK`, `data` = `RatingScaleResponse`.

Errors: `404 PMS_RATING_SCALE_NOT_FOUND` · `422` for the same level rules as create.

---

## 7. Full endpoint index

| # | Method | Path (after `/api/v1/pms`) | Write? | Success | Section |
|---|---|---|---|---|---|
| 1 | GET | `/pms-cycle/get/cycles` | | 200 | §3.1 |
| 2 | GET | `/pms-cycle/get/cycles/export` | | 200 (CSV) | §3.2 |
| 3 | GET | `/pms-cycle/get/cycle/{cycleId}` | | 200 | §3.3 |
| 4 | POST | `/pms-cycle/create/cycle` | ✔ | 201 | §3.4 |
| 5 | PUT | `/pms-cycle/update/cycle/{cycleId}` | ✔ | 200 | §3.5 |
| 6 | POST | `/pms-cycle/publish/cycle/{cycleId}` | ✔ | 200 | §3.6 |
| 7 | GET | `/pms-cycle/get/cycle/{cycleId}/activation` | | 200 | §3.7 |
| 8 | POST | `/pms-cycle/cancel/cycle/{cycleId}` | ✔ | 200 | §3.8 |
| 9 | GET | `/pms-goal-template/get/goal-templates` | | 200 | §4.1 |
| 10 | GET | `/pms-goal-template/get/goal-template/{templateId}` | | 200 | §4.2 |
| 11 | POST | `/pms-goal-template/create/goal-template` | ✔ | 201 | §4.3 |
| 12 | PUT | `/pms-goal-template/update/goal-template/{templateId}` | ✔ | 200 | §4.4 |
| 13 | PUT | `/pms-goal-template/update/goal-template/{templateId}/kra-kpi` | ✔ | 200 | §4.5 |
| 14 | PUT | `/pms-goal-template/update/goal-template/{templateId}/competencies` | ✔ | 200 | §4.6 |
| 15 | GET | `/pms-master/get/kras` | | 200 | §5.1.1 |
| 16 | POST | `/pms-master/create/kra` | ✔ | 201 | §5.1.2 |
| 17 | PUT | `/pms-master/update/kra/{kraId}` | ✔ | 200 | §5.1.3 |
| 18 | DELETE | `/pms-master/delete/kra/{kraId}` | ✔ | 200 | §5.1.4 |
| 19 | GET | `/pms-master/get/kpis` | | 200 | §5.2.1 |
| 20 | GET | `/pms-master/get/kpi-units` | | 200 | §5.2.2 |
| 21 | POST | `/pms-master/create/kpi` | ✔ | 201 | §5.2.3 |
| 22 | PUT | `/pms-master/update/kpi/{kpiId}` | ✔ | 200 | §5.2.4 |
| 23 | DELETE | `/pms-master/delete/kpi/{kpiId}` | ✔ | 200 | §5.2.5 |
| 24 | GET | `/pms-master/get/competencies` | | 200 | §5.3.1 |
| 25 | POST | `/pms-master/create/competency` | ✔ | 201 | §5.3.2 |
| 26 | PUT | `/pms-master/update/competency/{competencyId}` | ✔ | 200 | §5.3.3 |
| 27 | DELETE | `/pms-master/delete/competency/{competencyId}` | ✔ | 200 | §5.3.4 |
| 28 | GET | `/pms-rating-scale/get/rating-scales` | | 200 | §6.1 |
| 29 | GET | `/pms-rating-scale/get/rating-scale/{scaleId}` | | 200 | §6.2 |
| 30 | POST | `/pms-rating-scale/create/rating-scale` | ✔ | 201 | §6.3 |
| 31 | PUT | `/pms-rating-scale/update/rating-scale/{scaleId}` | ✔ | 200 | §6.4 |

---

## 8. Recommended frontend flows

**Appraisal cycle wizard**

1. `POST create/cycle` with `basic` only → store `id`, go to step 2.
2. On each "Next" or "Previous", `PUT update/cycle/{id}` with the full body and the new `current_step` / `completed_step`.
3. Load the rating-scale dropdown with `GET get/rating-scales?status=active`.
4. On "Publish", `POST publish/cycle/{id}`. On `422 PMS_CYCLE_PUBLISH_VALIDATION_FAILED`, show `detail` and stay on the wizard.
5. Open the activation page with `GET get/cycle/{id}/activation`.

**Goal template wizard**

1. `POST create/goal-template` → store `id`.
2. `PUT update/goal-template/{id}/kra-kpi` (use `save_as_draft: true` for drafts).
3. `PUT update/goal-template/{id}/competencies`. The template becomes `active` automatically if complete.
4. Populate KRA and KPI dropdowns from `get/kras` and `get/kpis`; competency picker from `get/competencies`.

**Deleting master data:** show the confirm dialog, then call `DELETE`. On `409 *_IN_USE`, tell the user which template uses it. The API does not return the template names.

---

## 9. Known limitations (plan the UI around these)

- **Names are not returned for ids.** Department, role and plant names must come from Sentrifugo. Plant names in the cycle list are `null` unless "All Plants".
- **Activation notifications and eligibility are empty** until those features are built.
- **Cycle list is paginated; goal template list, master lists and rating scales are not.** Load them in full.
- **Stages and applicability are optional on draft save.** Validation happens only on publish.
- **Stage `stage` values** must match the nine values in §2.2 exactly (lowercase).
