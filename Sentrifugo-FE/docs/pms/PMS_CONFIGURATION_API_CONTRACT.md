# PMS Configuration — API Contract (for backend)

Screens covered: **2.1 Goal Templates list · 2.2–2.4 template wizard · 2.5/2.6 KRA Master · 2.7/2.8 KPI Master · 2.9 Competency Master · 2.10 Rating Scale**.

Same conventions as [PMS_CYCLE_API_CONTRACT.md](PMS_CYCLE_API_CONTRACT.md) (base URL `VITE_PMS_API_BASE_URL`, bearer auth, session-scoped organisation, errors as `{ "detail", "code" }`, UI branches on `code`). Types are in [`src/types/pms-config.ts`](../../src/types/pms-config.ts); every endpoint is wired in [`src/store/api/pmsApi.ts`](../../src/store/api/pmsApi.ts) behind a mock `queryFn` — swap to the commented `query` line per endpoint.

## Endpoints

| # | Method | Path | Purpose | Screen |
|---|--------|------|---------|--------|
| 1 | GET | `/pms/kras` | All KRAs | 2.5, KPI/template pickers |
| 2 | POST | `/pms/kras` | Create KRA | 2.6 |
| 3 | PUT | `/pms/kras/{kra_id}` | Rename KRA | 2.6 |
| 4 | DELETE | `/pms/kras/{kra_id}` | Delete KRA | 2.5 |
| 5 | GET | `/pms/kpis` | All KPIs (with `kra_name`) | 2.7 |
| 6 | POST | `/pms/kpis` | Create KPI | 2.8 |
| 7 | PUT | `/pms/kpis/{kpi_id}` | Update KPI | 2.8 |
| 8 | DELETE | `/pms/kpis/{kpi_id}` | Delete KPI | 2.7 |
| 9 | GET | `/pms/lookups/kpi-units` | Unit options | 2.8 |
| 10 | GET | `/pms/competencies` | All competencies | 2.9, 2.4 |
| 11 | POST | `/pms/competencies` | Create | 2.9 |
| 12 | PUT | `/pms/competencies/{competency_id}` | Update | 2.9 |
| 13 | DELETE | `/pms/competencies/{competency_id}` | Delete | 2.9 |
| 14 | GET | `/pms/rating-scales/config` | Scales with full level config | 2.10 |
| 15 | PUT | `/pms/rating-scales/{scale_id}` | Save a scale | 2.10 |
| 16 | GET | `/pms/goal-templates` | Filtered template list | 2.1 |
| 17 | GET | `/pms/goal-templates/{template_id}` | One template | wizard |
| 18 | POST | `/pms/goal-templates` | Create | 2.2 |
| 19 | PUT | `/pms/goal-templates/{template_id}` | Update | 2.2–2.4 |
| 20 | PATCH | `/pms/goal-templates/{template_id}/status` | Activate / deactivate | 2.1 ⋮ menu |
| 21 | POST | `/pms/goal-templates/{template_id}/duplicate` | Copy as draft | 2.1 ⋮ menu |
| 22 | DELETE | `/pms/goal-templates/{template_id}` | Delete | 2.1 ⋮ menu |
| 23 | GET | `/pms/lookups/designations?department_id=` | Role / designation options | 2.2 |

(`GET /pms/rating-scales` from the cycle contract stays — it is the trimmed lookup the cycle wizard uses; both read the same scales.)

## Masters

```json
GET /pms/kras         → [{ "id": "kra-1", "name": "Production Efficiency" }]
POST/PUT /pms/kras    ← { "name": "Safety" }           → PmsKra
GET /pms/kpis         → [{ "id": "kpi-1", "kra_id": "kra-1", "kra_name": "Production Efficiency",
                           "name": "Clinker production", "unit": "TPD", "target_type": "common",
                           "expected_outcome": "Sustain planned output", "evidence_required": "DCS report" }]
POST/PUT /pms/kpis    ← { "kra_id", "name", "unit", "target_type": "individual|common",
                          "expected_outcome", "evidence_required" }  → PmsKpi
GET /pms/competencies → [{ "id": "comp-1", "name": "Discipline", "category": "behavioural", "is_active": true }]
POST/PUT              ← { "name", "category": "behavioural|technical|leadership|functional", "is_active" }
```

Lists are unpaged (the screens show all rows: "Showing 1 to 7 of 7 KRAs"); order = creation order.

Validation / errors the UI already handles (`code` → message shown from `detail`):

| Code | Status | When |
|---|---|---|
| `PMS_KRA_DUPLICATE` | 409 | KRA name already exists (case-insensitive, trimmed) |
| `PMS_KRA_IN_USE` | 409 | Delete a KRA that still has KPIs |
| `PMS_KPI_DUPLICATE` | 409 | Same KPI name under the same KRA |
| `PMS_KPI_IN_USE` | 409 | Delete a KPI used in any goal template |
| `PMS_COMPETENCY_DUPLICATE` | 409 | Name already exists |
| `PMS_COMPETENCY_IN_USE` | 409 | Delete a competency used in any goal template |
| `PMS_KRA_NOT_FOUND` | 422 | `kra_id` on a KPI does not exist |

Field limits (also enforced client-side): KRA name ≤ 100; KPI name ≤ 120; expected outcome / evidence ≤ 200; competency name ≤ 120. All names required and trimmed. Renaming a KRA must reflect in `kra_name` of its KPIs.

## Rating scale

```json
GET /pms/rating-scales/config → [{
  "id": "scale-5", "name": "Standard 5-Point Scale",
  "is_default": true, "show_definitions_to_employees": true,
  "levels": [   // highest rating first
    { "rating": 5, "label": "Outstanding", "definition": "Exceptional performance, consistently exceeds all targets",
      "score_min": 4.50, "score_max": 5.00, "color": "#16a34a" } ]
}]
PUT /pms/rating-scales/{scale_id} ← { "levels": [...], "is_default": true, "show_definitions_to_employees": true }
```

- The UI edits labels, definitions, ranges and colours only. `rating` values are fixed per scale; levels are never added or removed here.
- Validate server-side too: `label` required ≤ 40, `definition` ≤ 200, `color` matches `#rrggbb`, `score_min ≤ score_max`, and ranges must not overlap — for ascending `rating`, each `score_min` must be **greater than** the previous level's `score_max`.
- Saving with `is_default: true` clears the flag on every other scale (exactly one default).

## Goal templates

### List — `GET /pms/goal-templates`

Query: `financial_year` (FY start, `2026` = FY 2026-27), `plant_id`, `department_id`, `search` (matches template name or role/designation). Not paged.

```json
[{ "id": "tpl-1", "name": "Production Engineer", "financial_year": 2026,
   "designation_name": "Engineer – Kiln Ops", "department_id": "dept-production",
   "department_name": "Production", "plant_id": "plant-mattampally", "plant": "Mattampally",
   "status": "active" }]
```

`plant` / `plant_id` are **derived, read-only**: the plant the role belongs to, or `"All"` / `null` when it applies everywhere. A template with `plant_id: null` must match **any** `plant_id` filter. The wizard has no plant field (per the design).

### Get / create / update

```json
PmsGoalTemplate = {
  "id": "tpl-1", "department_name": "Production", "designation_name": "Engineer – Kiln Ops", "plant": "Mattampally",
  "basic": { "financial_year": 2026, "name": "Production Engineer", "description": "…",
             "department_id": "dept-production", "designation_id": "desig-1",
             "effective_from": "2026-04-01", "status": "active" },   // active | inactive | draft
  "kras": [ { "kra_id": "kra-1", "kpis": [
      { "kpi_id": "kpi-1", "weight": 25, "target_type": "common",
        "expected_outcome": "Sustain planned output", "evidence_required": "DCS report" } ] } ],
  "competencies": [ { "competency_id": "comp-1", "weight": 8 } ]
}
```

POST / PUT body = `{ basic, kras, competencies }` (no server fields). **`kras` and `competencies` contain only what the user ticked** — unticked masters are simply absent. `target_type`, `expected_outcome` and `evidence_required` are per-template overrides of the KPI master's defaults.

**Draft saves are partial.** The wizard persists on every "Save & Next", so a template is created after step 1 with `status: "draft"` and empty `kras` / `competencies`, then updated after steps 2 and 3. Strict validation applies only when `status` is `active` or `inactive` (the final Save):

- ≥ 1 KRA, each with ≥ 1 KPI; each KPI `weight` > 0; **sum of all KPI weights = 100** (tolerance 0.01).
- ≥ 1 competency; each `weight` > 0; **sum = 100** (tolerance 0.01).
- `designation_id` must belong to `department_id`.

For a template that is already `active`/`inactive`, the UI re-sends its current status on interim saves so it never drops back to `draft`.

| Code | Status | When |
|---|---|---|
| `PMS_TEMPLATE_NOT_FOUND` | 404 | unknown id |
| `PMS_TEMPLATE_DUPLICATE` | 409 | same name + financial year + designation as another non-inactive template |
| `PMS_TEMPLATE_INCOMPLETE` | 409 | activating a template that has no KRAs/competencies yet |

### Status, duplicate, delete

- `PATCH …/status` `{ "status": "active" | "inactive" }` → updated template. `active` requires a complete template (`PMS_TEMPLATE_INCOMPLETE`).
- `POST …/duplicate` → new template, name `"<name> (Copy)"`, `status: "draft"`, same KRAs / competencies.
- `DELETE` → 204. Goals already created from a template must not be affected.

### Lookups

```json
GET /pms/lookups/designations?department_id=dept-production → [{ "id": "desig-1", "name": "Engineer – Kiln Ops", "department_id": "dept-production" }]
GET /pms/lookups/kpi-units → ["TPD", "kcal/kg", "%", "kWh/t", "Count", "Months", "MPa", …]
```
`department_id` is optional on designations (omit for all). Departments and plants reuse `/pms/lookups/departments` and `/pms/lookups/plants` from the cycle contract.

## Open questions for backend

1. Should the goal template carry an explicit plant (the list shows a Plant column and filter, but the design's form has no plant field)? Currently derived from the designation.
2. Is `kpi.unit` free text or a managed list? The UI treats it as a managed list from `/pms/lookups/kpi-units`.
3. Competency categories are a fixed enum on the UI (`behavioural | technical | leadership | functional`) — confirm or make it a lookup.
4. The Competency Master design has no "Add" button; the UI adds one (and a Status field in the dialog). Say if that should be removed.
