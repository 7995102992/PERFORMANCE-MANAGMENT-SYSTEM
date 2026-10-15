# PMS configuration pages (screens 2.1 - 2.10)

Set-up data Corporate HR maintains before goals are set. Menu: PMS Cycle > Configuration.

| Page | Screen | Route |
|---|---|---|
| `goal-templates/GoalTemplateList.tsx` | 2.1 | `/pms/configuration/goal-templates` |
| `goal-templates/GoalTemplateWizard.tsx` | 2.2 - 2.4 | `/pms/configuration/goal-templates/new`, `/:templateId/edit`, `/:templateId` (view) |
| `kra-master/KraMaster.tsx` | 2.5 (list), 2.6 (add / edit popup) | `/pms/configuration/kra-master` |
| `kpi-master/KpiMaster.tsx` | 2.7 (list), 2.8 (add / edit popup) | `/pms/configuration/kpi-master` |
| `competency-master/CompetencyMaster.tsx` | 2.9 | `/pms/configuration/competency-master` |
| `rating-scale/RatingScale.tsx` | 2.10 (and 2.13 add dialog) | `/pms/configuration/rating-scale` |

---

## KraMaster.tsx - KRA Master

| | |
|---|---|
| Purpose | Maintain Key Result Areas (a list of names) |
| Data | `useGetPmsKrasQuery`, `useCreatePmsKraMutation`, `useUpdatePmsKraMutation`, `useDeletePmsKraMutation` |
| Actions | Add / edit in a popup (`KraDialog`), delete after confirmation |
| Validation | Name required, at most 100 characters, no duplicate (checked locally and by the API 409) |
| Notes | Delete is refused while KPIs are mapped to the KRA. |

## KpiMaster.tsx - KPI Master

| | |
|---|---|
| Purpose | Maintain KPIs; every KPI belongs to one KRA |
| Data | `useGetPmsKpisQuery`, `useGetPmsKrasQuery`, `useGetPmsKpiUnitsQuery`, create / update / delete KPI mutations |
| Fields | KRA, KPI name (120), unit, target type (individual or common), expected outcome (200), evidence required (200) |
| Actions | Add / edit in `KpiDialog`, delete after confirmation |
| Notes | **Target type**: *common* means one target for everyone in the role, *individual* means each employee gets their own. Delete is refused while a template uses the KPI. |

## CompetencyMaster.tsx - Competency Master

| | |
|---|---|
| Purpose | Maintain competencies assessed at year end |
| Data | `useGetPmsCompetenciesQuery` and create / update / delete mutations |
| Fields | Name, category (behavioural, technical, leadership, functional), **competency type** (Manager or HR), status (active / inactive) |
| Actions | Search by name, add / edit in `CompetencyDialog`, delete after confirmation |
| Notes | The **type** decides who rates it: *HR* competencies are rated by Corporate HR (screen 1.8), *Manager* ones by the manager and HOD (screen 3.14). Delete is refused while a template uses it. |

## RatingScale.tsx - Rating Scale (and AddRatingScaleDialog)

| | |
|---|---|
| Purpose | Define the levels of a rating scale: label, definition, score range, colour |
| Data | `useGetPmsRatingScaleConfigsQuery`, `useUpdatePmsRatingScaleMutation`, `useCreatePmsRatingScaleMutation`; the dialog also uses `useGetPmsStandardRatingLevelsQuery` |
| Actions | Pick a scale, edit its levels, switch "default scale" and "show definitions to employees", **Save**; **Create Rating Scale** opens `AddRatingScaleDialog` (3 to 7 levels) |
| Validation | Label required (40 chars); definition 200; scores 0-100; max not below min; ranges must not overlap between ratings |
| Notes | The default scale opens first. The form warns before leaving with unsaved changes. When no scale exists, the page offers to create the first one. |

---

## GoalTemplateList.tsx - Goal Templates (2.1)

| | |
|---|---|
| Purpose | List role-based goal templates for a financial year |
| Data | `useGetPmsTemplatesQuery({financial_year, plant_id, department_id, search})`, `usePmsPlants()`, `usePmsDepartments()` |
| Actions | **Create** template, **Copy templates** (opens `CopyTemplateDialog`), row menu: view, edit, activate / deactivate, duplicate (creates a draft copy), delete |
| Notes | Search waits 300 ms. Activating needs a complete template and only one active template per role and year (API 409). Deleting does not touch goals already set. |

### CopyTemplateDialog.tsx

Copies every template of a previous financial year into a target year as **drafts**, skipping roles that
already have a template in the target year. Shows a preview (copied / skipped) before running. Data:
`useGetPmsCopyPreviewQuery`, `useCopyPmsTemplatesMutation`.

## GoalTemplateWizard.tsx - Create / edit template (2.2 - 2.4)

| | |
|---|---|
| Routes | `/new`, `/:templateId/edit`, `/:templateId` (read-only) |
| Purpose | Three steps: Basic info, KRA & KPI, Competencies |
| Data | masters (`useGetPmsKrasQuery`, `useGetPmsKpisQuery`, `useGetPmsCompetenciesQuery`), `useGetPmsTemplateQuery`, create / update template mutations |
| Save timing | **Save & Next** saves to the API at each step, so a half-built template survives as a draft. **Save Draft** saves after step 1 is valid. The last step saves with the status chosen on step 1. |
| Form building | `buildFormValues` merges the masters with the saved template (every KRA / KPI / competency appears, ticked if saved). `toApiBody` keeps only ticked rows. |

| Step | File | Rules (`template.schema.ts`) |
|---|---|---|
| 1 Basic info | `TemplateBasicStep.tsx`: financial year, name, description, department, role (depends on department), effective date, status | name 100 chars; department, role and date required |
| 2 KRA & KPI | `TemplateKraKpiStep.tsx`: tick KRAs and KPIs; per KPI weight, target type, expected outcome, evidence | at least one KRA with a KPI; total weight of ticked KPIs = 100 |
| 3 Competencies | `TemplateCompetencyStep.tsx`: tick competencies, weight each (shows the HR / Manager type); **Distribute equally** | at least one; total = 100 |

`WeightInput` keeps what the user types ("12.") while the form holds a clean number; an empty box is 0.

## Helper files

| File | Contents |
|---|---|
| `config.constants.ts` | category and target-type labels, financial-year helpers (`currentFinancialYear`, `financialYearOptions`) |
| `CompetencyTypeBadge.tsx` | The orange HR / purple Manager tag |
| `goal-templates/template.types.ts` | Form value shapes of the wizard |
| `goal-templates/template.utils.ts` | `buildFormValues`, `toApiBody`, `sumWeights`, `distributeEqually` |
| `goal-templates/template.schema.ts` | Zod schemas per step |
