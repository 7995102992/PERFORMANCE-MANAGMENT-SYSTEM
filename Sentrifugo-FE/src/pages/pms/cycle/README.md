# PMS cycle pages (screens 1.1 - 1.6)

Used by Corporate HR to create and publish an appraisal cycle.

```
PmsCycleList (1.1) ──new / edit / view──▶ InitiateAppraisal wizard (1.2 - 1.5) ──publish──▶ CycleActivated (1.6)
```

## PmsCycleList.tsx - screen 1.1 "PMS Cycle"

| | |
|---|---|
| Route | `/pms/cycle` |
| Purpose | List all cycles, filter them, open the wizard to create / view / edit, export to CSV |
| Data | `useGetPmsCyclesQuery(params)` (GET `/pms-cycle/get/cycles`), `usePmsPlants()` for the Plant filter, `useExportPmsCyclesMutation()` for export |
| Filters | Status (the stat cards double as the status filter), search, financial year, appraisal type, plant; paging with page size |
| Actions | **Initiate Appraisal** (new cycle), **View** a row, **Edit** a draft or active row, **Export**, **Clear filters** |
| Notes | Search waits 300 ms (`useDebouncedValue`). Any filter change returns to page 1. Closed and cancelled cycles are view-only. |

Components: `CycleStatCards` (counts that act as filter), `CycleStatusBadge` (coloured status chip).

## InitiateAppraisal.tsx - screens 1.2 - 1.5 "Initiate Appraisal" wizard

| | |
|---|---|
| Routes | `/pms/cycle/new` (create), `/pms/cycle/:cycleId/edit` (edit), `/pms/cycle/:cycleId` (read-only, `readOnly`) |
| Purpose | Four-step form: Basic details, Timeline, Applicability, Rating & Publish |
| Data | `useGetPmsCycleQuery(id)` when editing; `useCreatePmsCycleMutation`, `useUpdatePmsCycleMutation`, `usePublishPmsCycleMutation` |
| Form | One react-hook-form for all steps, typed `PmsCycleUpsert`; only the step on screen is validated |
| Save timing | **Nothing is saved until the last step.** Publish saves (create or update) and then publishes. An active cycle only saves ("Save Changes"). |
| Leaving | Unsaved edits trigger the navigation guard. Closed / cancelled cycles redirect to the read-only view. |
| After publish | Goes to `/pms/cycle/:cycleId/activated` |

### Steps (`components/`)

| Step | File | What the user sets | Rules (`cycle.schema.ts`) |
|---|---|---|---|
| 1 Basic Details | `BasicDetailsStep.tsx` | name, description, type (annual / mid-year / custom), period start and end | name 1-120 chars; end after start |
| 2 Timeline | `TimelineStep.tsx` | start and end date and a notify switch for each of the nine stages | every stage has both dates; end on or after start |
| 3 Applicability | `ApplicabilityStep.tsx` | plants, departments, **Goal Setting** (who gets goals: employment types + minimum service months) and **Appraisal** (who is rated: employment types + minimum service months + "completed on or before" date), exclude resigned / notice period | at least one plant; departments when not "all"; at least one employment type per half; months 0-600 |
| 4 Rating & Publish | `RatingPublishStep.tsx` | rating scale, who is notified (managers, employees, HOD, HR); summary of the cycle | a rating scale is required |

Notes:

- Stage dates are **suggested** from the period (`buildDefaultStages`). Changing the period start on step 1
  regenerates all stage dates (replacing any the user edited); editing a date on step 2 is never overwritten
  otherwise.
- Applicable Plants: choosing every plant is saved as "all plants" so plants added later are covered.
- `EligibleEmployeesDialog` (opened from step 3) shows who would get goals and who would be rated. It is
  **mocked** because PMS_Java has no preview endpoint yet.
- Publishing is refused by the API (422) with a list of everything missing; the toast shows it.

## CycleActivated.tsx - screen 1.6 "Cycle Activated"

| | |
|---|---|
| Route | `/pms/cycle/:cycleId/activated` |
| Purpose | Confirmation after publish: publish date and how many people were notified, by audience |
| Data | `useGetPmsCycleActivationQuery(cycleId)` |
| Actions | **View Cycle** (read-only wizard), **Back to PMS Cycle** |
| Notes | The breadcrumb shows "<cycle name> · Activated". |

## Helper files

| File | Contents |
|---|---|
| `cycle.constants.ts` | route path, labels, status colours, wizard steps, stage labels, default stage timing (`buildDefaultStages`), the blank form (`buildEmptyCycle`) |
| `cycle.schema.ts` | Zod schemas per step; `STEP_SCHEMAS[stepId]` |
