# Shared PMS components and helpers

Used across the PMS pages. None of them call the API except `usePmsLookups`.

## Components

| File | What it is | Used by |
|---|---|---|
| `FormRow.tsx` | `FormRow` (label left, control right, optional hint / error) and `StepSection` (heading of a wizard step) | cycle wizard steps |
| `WizardStepper.tsx` | Full-width numbered stepper; completed steps show a tick and are clickable | cycle wizard |
| `PmsTableCard.tsx` | `PmsTableCard` (white card), `PmsTh` (header cell), `PMS_HEADER_ROW`, `ShowingFooter`, `SkeletonRows` | every PMS table |
| `RowActions.tsx` | Edit (pencil) and delete (bin) buttons with tooltips | master tables |
| `FinancialYearTag.tsx` | "FY 2026-27" pill; a dropdown when `onChange` is given | manager, employee and HR pages |
| `StatusLabel.tsx` | Icon plus coloured text for a status | manager, HR and employee tables |
| `RagDot.tsx` | Red / amber / green dot, optionally with a label | progress and mid-year pages |
| `RatingSelect.tsx` | 1-5 rating dropdown (`withLabel` shows "4 - Exceeds Expectations") | appraisal, HR, self appraisal |
| `EvidenceUpload.tsx` | "Upload" link / attached file name; keeps only the name (no storage yet) | progress, self appraisal |

## Helpers

| File | Contents |
|---|---|
| `pms.utils.ts` | `isoToDate`, `dateToIso`, `formatDisplayDate` (18-Apr-2026), `formatMonthYear`, `financialYearOf`, `financialYearLabel`, `relativeDate` |
| `validation.ts` | `toFieldErrors` (Zod error to `{ "rows.0.target": "message" }`), `parseDecimal` ("" is null), `formatNumber` (en-IN, no trailing zeros), `FieldErrors` |
| `rating.constants.ts` | `RATING_LABELS`: 5 Outstanding ... 1 Unsatisfactory |
| `usePmsLookups.ts` | `usePmsPlants` (IAM business units), `usePmsDepartments`, `usePmsDesignations(departmentId)`: `{ data: {id, name}[], isLoading }` |

## Notes

- A PMS **plant** is an IAM **business unit**; the PMS API stores only the id.
- Dates are ISO `YYYY-MM-DD` strings everywhere; convert at the edge with `isoToDate` / `dateToIso`.
