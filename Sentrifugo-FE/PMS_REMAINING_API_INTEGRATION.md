# PMS: remaining API integration

Audience: frontend engineers finishing off the PMS module in `src/store/api/pmsApi.ts`.

Everything in `pmsApi.ts` is wired to the real PMS backend (`PMS_Java`) **except
six endpoints**, which still run against in-memory mock functions in
`src/store/api/mocks/pmsCycleMock.ts` and `pmsConfigMock.ts`. This doc lists
exactly those six, what each one needs to return, and — for three of them —
points out that the real backend call **already exists elsewhere in this
codebase** and just needs to be reused, not built.

## How to tell a mock endpoint from a real one

In `pmsApi.ts`, every endpoint either has:
- `query: (...) => ({ url: ... })` or `queryFn: async (...) => { ... send(...) ... }` → **real**, hits `PMS_BASE_URL` (`${VITE_PMS_API_BASE_URL}/api/v1/pms`).
- `queryFn: () => mock(() => mockXxx(...), ms)` → **mock**, resolves from an in-memory array, never leaves the browser.

Each mock-backed endpoint also has a `// Not in the API guide yet — mock.` or
`// Sentrifugo lookup, not in the guide yet — mock.` comment immediately above it.

## The six mock-backed endpoints

### 1–3. Plant / Department / Designation lookups — **no new backend work needed**

| Endpoint (pmsApi.ts) | Mock source | Used by |
|---|---|---|
| `getPmsPlants` | `MOCK_PLANTS` in `pmsCycleMock.ts` | Cycle wizard's applicability step (plant multi-select) |
| `getPmsDepartments` | `MOCK_DEPARTMENTS` in `pmsCycleMock.ts` | Cycle applicability, goal template filters |
| `getPmsDesignations` | `MOCK_DESIGNATIONS` / `mockListDesignations()` in `pmsConfigMock.ts` | Goal template basic-info step |

**These aren't missing backend endpoints — they're IAM org data, and IAM's REST API for them is already integrated into this same frontend**, in `src/store/api/iamApi.ts`:

- "Plant" in PMS language = **Business Unit** in IAM: `useGetBusinessUnitsQuery()` → `GET /business-units/` → `{ id, business_unit_name, ... }[]`
- `useGetDepartmentsQuery()` → `GET /departments/` → `{ id, departmentName, businessUnits: string[], ... }[]`
- `useGetDesignationsQuery()` → `GET /designations/` → `{ id, designationName, departmentId, is_active, ... }[]`

**To integrate:** in the PMS pages that currently call `useGetPmsPlantsQuery` / `useGetPmsDepartmentsQuery` / `useGetPmsDesignationsQuery`, switch to the `iamApi` hooks above and map the field names (`business_unit_name` → `name`, `departmentName` → `name`, `designationName` → `name`, `departmentId` → `department_id`) into the existing `PmsLookupOption` / `PmsDesignationOption` shapes already used throughout the PMS module. Once every call site is switched, delete `getPmsPlants`/`getPmsDepartments`/`getPmsDesignations` from `pmsApi.ts` along with `MOCK_PLANTS`/`MOCK_DEPARTMENTS`/`MOCK_DESIGNATIONS`/`mockListDesignations` from the two mock files (check `pmsCycleMock.ts`'s eligibility-preview mock first — it depends on `MOCK_PLANTS`/`MOCK_DEPARTMENTS` too; see #4 below).

No backend ticket needed for these three — it's a frontend-only swap.

### 4. Eligibility preview — **new PMS backend endpoint needed**

```
previewEligibleEmployees: builder.mutation<PmsEligibilityPreview, PmsCycleApplicability>
```
Mock: `mockEligibilityPreview()` in `pmsCycleMock.ts`. Used by the cycle wizard's applicability step to show "X employees eligible" before the cycle is published.

**Request** (`PmsCycleApplicability`, from `src/types/pms.ts`):
```ts
{
  plant_ids: string[]
  all_departments: boolean
  department_ids: string[]
  employment_types: string[]        // e.g. ['permanent', 'contract', 'trainee']
  min_service_months: number
  service_as_on: string             // ISO date
  exclude_probation: boolean
  exclude_notice_period: boolean
}
```

**Expected response** (`PmsEligibilityPreview`):
```ts
{
  total_eligible: number
  excluded_probation: number
  excluded_notice_period: number
  excluded_min_service: number
  items: {                          // sample only — mock caps this at 25
    employee_id: string
    employee_code: string
    name: string
    department: string
    plant: string
    employment_type: string
    service_months: number
  }[]
}
```

This needs real employee data (plant, department, employment type, service length) that lives in IAM, not PMS's own Postgres tables — so this endpoint most likely needs to live on the PMS backend but call IAM's employee directory (the same way `IamEmployeeClient` already does for `direct_reports`), rather than being pure PMS data. Flag this to whoever picks up the backend ticket: it's a cross-service query, not a simple PMS table read.

**Suggested route**, matching the existing `pms-cycle` controller's naming convention: `POST /pms-cycle/preview-eligibility` (or make it a sub-step of the existing create/update cycle flow if the backend team prefers not to add a new route).

### 5. Goal template status (activate/deactivate) — **new PMS backend endpoint needed**

```
setPmsTemplateStatus: builder.mutation<PmsGoalTemplate, { id: string; status: PmsTemplateStatus }>
```
Mock: `mockSetTemplateStatus()` in `pmsConfigMock.ts`. `PmsTemplateStatus` is `'draft' | 'active' | 'inactive'`.

**Request:** `{ status: 'draft' | 'active' | 'inactive' }`, path param `{templateId}`.
**Response:** the updated `PmsGoalTemplate` (same shape `GET /pms-goal-template/get/goal-template/{id}` already returns).
**Business rule the mock enforces** — the real backend should too: a template cannot move to `active` unless it has at least one KRA and at least one competency saved (`PMS_TEMPLATE_INCOMPLETE`, 409).

**Suggested route**, matching `PmsGoalTemplateController`'s existing verbs: `PUT /pms-goal-template/update/goal-template/{templateId}/status`.

### 6. Goal template duplicate — **new PMS backend endpoint needed**

```
duplicatePmsTemplate: builder.mutation<PmsGoalTemplate, string>   // arg = template id
```
Mock: `mockDuplicateTemplate()` in `pmsConfigMock.ts`.

**Behavior:** clone an existing template's `basic` info (name suffixed with " (Copy)", status forced to `draft`), plus its full `kras`/`kpis` and `competencies` arrays, as a brand-new template id.
**Response:** the newly created `PmsGoalTemplate`.

**Suggested route:** `POST /pms-goal-template/duplicate/goal-template/{templateId}` — no request body needed, same pattern as `/pms-goal-template/copy` (which already exists but does something different: copying *all* templates from one financial year to another, not cloning one template).

## Once a real endpoint exists: how to swap it in

Each mock endpoint in `pmsApi.ts` follows the same shape:
```ts
// Not in the API guide yet — mock.
someEndpoint: builder.mutation<ResponseType, RequestType>({
  queryFn: (arg) => mock(() => mockSomeEndpoint(arg), 500),
  invalidatesTags: [...],
}),
```
Replace the `queryFn` with a real `query` (or `queryFn` using `send`, if the response needs envelope-unwrapping or chained calls — see `getPmsTemplates` for an example):
```ts
someEndpoint: builder.mutation<ResponseType, RequestType>({
  query: (arg) => ({ url: '/pms-xxx/...', method: 'POST', body: arg }),
  transformResponse: (r: ApiEnvelope<ApiResponseType>) => mapFromApi(r.data),
  invalidatesTags: [...],
}),
```
All real PMS responses are wrapped in the `{ success, message, data }` envelope (`ApiEnvelope<T>` in `pmsMappers.ts`) — `transformResponse` unwraps it the same way every other real endpoint in this file already does. Auth (`Authorization: Bearer <token>`) and the `/api/v1/pms` base path are handled automatically by `createBaseQuery(PMS_BASE_URL)`; no per-endpoint auth code needed.

Once every mock call site for an endpoint is removed, delete the corresponding `mockXxx` function and any now-unused constants (`MOCK_PLANTS`, etc.) from the mock files, and remove the `mock()` helper import if nothing else in the file still uses it.

## Checklist

- [ ] Swap `getPmsPlants` → `useGetBusinessUnitsQuery` (iamApi)
- [ ] Swap `getPmsDepartments` → `useGetDepartmentsQuery` (iamApi)
- [ ] Swap `getPmsDesignations` → `useGetDesignationsQuery` (iamApi)
- [ ] Backend: add eligibility preview endpoint, then swap `previewEligibleEmployees`
- [ ] Backend: add template status endpoint, then swap `setPmsTemplateStatus`
- [ ] Backend: add template duplicate endpoint, then swap `duplicatePmsTemplate`
- [ ] Remove now-dead mock code (`MOCK_PLANTS`, `MOCK_DEPARTMENTS`, `MOCK_DESIGNATIONS`, `mockListDesignations`, `mockEligibilityPreview`, `mockSetTemplateStatus`, `mockDuplicateTemplate`) once their last call site is gone
