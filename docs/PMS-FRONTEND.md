# PMS Frontend: what is built and where

Covers the PMS (performance management) screens in `Sentrifugo-FE/src`. Paths are relative to `Sentrifugo-FE/src/`.

Written for: developers who will continue the PMS frontend.

## 1. How the code is laid out

| Area | Folder / file | What it holds |
|---|---|---|
| Pages | `pages/pms/` | One folder per module: `cycle/`, `configuration/`, `goal-setting/`, `shared/` |
| API layer | `store/api/pmsApi.ts` | RTK Query endpoints for every PMS call |
| Response mapping | `store/api/pmsMappers.ts` | Converts snake_case API data into the camelCase shapes the UI uses |
| Mocks | `store/api/mocks/` | Fake data for endpoints that are not yet real (see section 5) |
| Types | `types/pms.ts`, `types/pms-config.ts`, `types/pms-goals.ts` | Shapes for cycles, masters, and goals |
| Routes | `router.tsx` (search `pms`) | TanStack Router routes for each screen |
| Menu | `layouts/menu-config.ts` | Sidebar entries for PMS |

Screen numbers (1.1, 2.2, 3.3 ...) come from the design mockups and are kept in the comments so each file can be traced to its screen.

## 2. Screens

### 2.1 PMS cycle (screens 1.x)

Files: `pages/pms/cycle/`

| Screen | File | Route | Status |
|---|---|---|---|
| Cycle list | `PmsCycleList.tsx` | `/pms/cycle` | Real API (`getPmsCycles`) |
| Create / edit / view cycle (4-step wizard) | `InitiateAppraisal.tsx` | `/pms/cycle/new`, `/pms/cycle/:cycleId/edit`, `/pms/cycle/:cycleId` | Real API for save; plants and departments are mocked |
| Step 1 Basic Details | `components/BasicDetailsStep.tsx` | inside the wizard | Form only |
| Step 2 Timeline | `components/TimelineStep.tsx` | inside the wizard | Form only; stage dates suggested from the period |
| Step 3 Applicability | `components/ApplicabilityStep.tsx` | inside the wizard | Plants and departments are mocked; eligibility preview is mocked |
| Step 4 Rating and publish | `components/RatingPublishStep.tsx` | inside the wizard | Real rating scale list |
| Eligible employees preview | `components/EligibleEmployeesDialog.tsx` | opened from step 3 | Mocked (`previewEligibleEmployees`) |
| Cycle activated | `CycleActivated.tsx` | `/pms/cycle/:cycleId/activated` | Real API (`getPmsCycleActivation`) |
| Stat cards | `components/CycleStatCards.tsx` | on the list | Doubles as the status filter |
| Status badge | `components/CycleStatusBadge.tsx` | on the list and wizard | Display only |
| Shared helpers | `cycle.constants.ts`, `cycle.schema.ts` | - | Wizard steps, stage defaults, and Zod validation per step |

The wizard keeps one form for all four steps. Validation runs only for the step on screen (`STEP_SCHEMAS`). Once a cycle is saved, every step is browsable. A cycle that is active is edited with "Save Changes" and not published again.

### 2.2 Configuration (screens 2.x)

Files: `pages/pms/configuration/`

| Screen | File | Route | Status |
|---|---|---|---|
| 2.1 Goal templates list | `goal-templates/GoalTemplateList.tsx` | `/pms/configuration/goal-templates` | Real list. Delete is real. Duplicate and status change are mocked |
| 2.2 Goal template, step 1 | `goal-templates/components/TemplateBasicStep.tsx` | `/new`, `/:templateId/edit` | Real save |
| 2.3 KRA and KPI selection | `goal-templates/components/TemplateKraKpiStep.tsx` | same wizard | Real save; weightage rules enforced |
| 2.4 Competencies | `goal-templates/components/TemplateCompetencyStep.tsx` | same wizard | Real save |
| Template wizard | `goal-templates/GoalTemplateWizard.tsx` | `/new`, `/:templateId`, `/:templateId/edit` | Each "Save and Next" persists a draft |
| Copy template | `goal-templates/CopyTemplateDialog.tsx` | opened from the list | Real preview and copy |
| 2.5 KRA master | `kra-master/KraMaster.tsx` | `/pms/configuration/kra-master` | Real |
| 2.6 KRA add/edit | `kra-master/KraMaster.tsx` (`KraDialog`) | same page | Real |
| 2.7 KPI master | `kpi-master/KpiMaster.tsx` | `/pms/configuration/kpi-master` | Real |
| 2.8 KPI add/edit | `kpi-master/KpiMaster.tsx` (`KpiDialog`) | same page | Real |
| 2.9 Competency master | `competency-master/CompetencyMaster.tsx` | `/pms/configuration/competency-master` | Real |
| 2.10 Rating scale | `rating-scale/RatingScale.tsx` | `/pms/configuration/rating-scale` | Real. Lists all scales and edits the selected one |
| 2.13 Add rating scale | `rating-scale/AddRatingScaleDialog.tsx` | opened from 2.10 | Real |
| Config helpers | `config.constants.ts` | - | Labels, financial-year helpers (April to March) |

Goal templates have a state machine: `draft`, `active`, `inactive`. A copy is always created as a draft.

### 2.3 Goal setting (screens 3.x to 5.x)

Files: `pages/pms/goal-setting/`

| Screen | File | Route | Status |
|---|---|---|---|
| 3.1 My team (manager) | `TeamGoalSettingPage.tsx` | `/pms/team-goal-setting/:fy` | Real. Team comes from IAM (`getPmsTeam`) |
| 3.3 to 3.5 Enter, validate, send targets | `TargetAssignmentPage.tsx` | `/pms/team-goal-setting/:fy/employee/:employeeUserId` | Real: save, validate, send |
| 4.1 to 4.3 My goals (employee) | `MyGoalsPage.tsx` | `/pms/my-goals/:fy` | Real: acknowledge, request change |
| 5.1 Goal approvals (HOD) | `GoalApprovalsPage.tsx` | `/pms/goal-approvals/:fy` | Real |
| 5.2 Review one employee (HOD) | `GoalReviewPage.tsx` | `/pms/goal-approvals/:fy/employee/:employeeUserId` | Real: approve or return |

Assignment statuses, in order: `DRAFT`, `SENT_TO_EMPLOYEE`, `ACKNOWLEDGED` (or `CHANGE_REQUESTED`), `WITH_HOD`, `APPROVED`.

### 2.4 Not built yet

Routes for these exist in `router.tsx` and show `PmsComingSoon.tsx`:
progress tracking (6.x), mid-year review and target revisions (7.x), self and manager appraisal and HOD review (8.x), rating normalisation (9.x), final rating (10.x), cycle closure (11.x).

## 3. Shared components

Files: `pages/pms/shared/`

| File | Used for |
|---|---|
| `FormRow.tsx` | Label-left, control-right row for every wizard step (`FormRow`, `StepSection`) |
| `WizardStepper.tsx` | Full-width stepper for the cycle wizard |
| `PmsTableCard.tsx` | White card around master tables; `PmsTh`, `ShowingFooter`, `SkeletonRows` |
| `RowActions.tsx` | Edit and delete buttons in master tables |
| `pms.utils.ts` | Date helpers: ISO to Date, display format, financial year labels |

Import path from the goal-setting folder is `../shared/...` (not `../../shared`).

## 4. API layer

`store/api/pmsApi.ts` uses `createBaseQuery`. Each endpoint:
- sends the request to `/api/v1/pms/...`,
- unwraps the `{ success, message, data }` envelope with `transformResponse`,
- invalidates the matching tag (`PmsCycle`, `PmsTemplate`, ...) so lists refresh after a write.

Hooks are exported at the bottom of the file, named `use<Endpoint>Query` or `use<Endpoint>Mutation`.

Errors come back as `{ detail, code }`. `lib/toast` reads `detail` to show the message.

Recent additions:

| Endpoint | Method and path | Where used |
|---|---|---|
| `getPmsCopyPreview` | GET `/pms-goal-template/get/copy-preview` | `CopyTemplateDialog.tsx` |
| `copyPmsTemplates` | POST `/pms-goal-template/copy` | `CopyTemplateDialog.tsx` |
| `deletePmsTemplate` | DELETE `/pms-goal-template/delete/goal-template/{id}` (drafts only) | `GoalTemplateList.tsx` |
| `createPmsRatingScale` | POST rating scale | `AddRatingScaleDialog.tsx` |
| `getPmsMyGoals`, `acknowledgeMyGoals`, `requestGoalChange` | goal setting, employee side | `MyGoalsPage.tsx` |
| `getPmsApprovals`, `approveGoals`, `returnGoals` | goal setting, HOD side | `GoalApprovalsPage.tsx`, `GoalReviewPage.tsx` |
| `getPmsTeam`, `getPmsEmployeeTargets`, `saveEmployeeTargets`, `validateEmployeeTargets`, `sendEmployeeTargets` | goal setting, manager side | `TeamGoalSettingPage.tsx`, `TargetAssignmentPage.tsx` |

## 5. Mocked, not yet real

These still return fake data from `store/api/mocks/`:

| Endpoint | Effect |
|---|---|
| `previewEligibleEmployees` | Eligibility preview always shows the same people |
| `getPmsPlants`, `getPmsDepartments` | Dropdowns come from fixed lists |
| `setPmsTemplateStatus` | Status change does not reach the server |
| `duplicatePmsTemplate` | Duplicate does not reach the server |
| `getPmsDesignations` | Designation list is fixed |

Replace these one at a time when the backend endpoint exists.

## 6. Recent decisions

- Applicable plants (cycle step 3) has All Plants / Select Plants, like departments. "All" fills in the plants that exist when chosen; a plant added later is not included until the cycle is edited.
- Eligible employees preview is wider; the excluded counts sit on the right.
- The cycle wizard no longer shows a page title. The stepper shows the step.
- Copy template skips a role if the target year already has a template for that role. Copies are drafts.
- Only draft templates can be deleted. Active and inactive templates are kept.

## 7. Known gaps

- Several write endpoints for goal templates use `create_resource`, while copy and delete use `manage_goal_templates`. Corporate HR may be blocked from some template edits. Check that all template writes use the same permission.
- The spacing gap above PMS page headers has been removed only on the cycle wizard. Other PMS pages still need the same check.
- Shared master tables and mocks listed in section 5 still need real backends.

## 8. Adding a new PMS screen

1. Put the page in `pages/pms/<module>/`, with a comment at the top naming the screen number.
2. Add the route in `router.tsx` using the `pmsRoute` helper.
3. Add the endpoint in `pmsApi.ts` and map the response in `pmsMappers.ts` if field names differ.
4. Add the menu entry in `layouts/menu-config.ts`.
5. Use `PmsTableCard` for tables and `FormRow` for forms so the look stays the same.
