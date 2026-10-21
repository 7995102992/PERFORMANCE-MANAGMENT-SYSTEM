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
| Step 3 Applicability | `components/ApplicabilityStep.tsx` | inside the wizard | Two rule cards: Goal Setting (who gets goals) and Appraisal (who is rated), each with its own employment types and minimum service. Eligibility preview is mocked |
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
| 3.1 My team (manager) | `TeamGoalSettingPage.tsx` | `/pms/team-goal-setting/:fy` | Static data; API wired (`getPmsTeam`) |
| 3.2 Select employee by role | `SelectRoleTemplatePage.tsx` | `/pms/team-goal-setting/:fy/role` | Static data; API wired |
| 3.3 to 3.5 Enter, validate, send targets | `TargetAssignmentPage.tsx` | `/pms/team-goal-setting/:fy/employee/:employeeUserId` | Static data; API wired. Validation: weights 0-100 and total 100%, every target required and numeric |
| 3.6 Goal status and send to HOD | `TeamGoalStatusPage.tsx` | `/pms/team-goal-setting/:fy/status` | Static data; API wired (`sendGoalsToHod`). Linked from the footer of 3.1 |
| 3.7 Revise returned goals | `ReviseReturnedGoalsPage.tsx` | `/pms/team-goal-setting/:fy/employee/:employeeUserId/revise` | Static data; API wired (the target endpoints) |
| 3.8 Set period 2 KRAs, transferred employee | `TransferredKrasPage.tsx` | `/pms/team-goal-setting/:fy/employee/:employeeUserId/transfer` | Static data; API wired (`/pms-goal-transfer`) |
| 4.1 to 4.3 My goals (employee) | `MyGoalsPage.tsx` | `/pms/my-goals/:fy` | Real: acknowledge, request change |
| 5.1 Goal approvals (HOD) | `GoalApprovalsPage.tsx` | `/pms/goal-approvals/:fy` | Real |
| 5.2 Review one employee (HOD) | `GoalReviewPage.tsx` | `/pms/goal-approvals/:fy/employee/:employeeUserId` | Real: approve or return |

Assignment statuses, in order: `DRAFT`, `SENT_TO_EMPLOYEE`, `ACKNOWLEDGED` (or `CHANGE_REQUESTED`), `WITH_HOD`, `APPROVED`.

Manager screens (3.1 to 3.14) call PMS_Java. The request and response shapes were checked against the controllers and models, and `PmsManagerApiTest` in PMS_Java covers the same calls. To work without the backend, set `VITE_PMS_STATIC_MANAGER=true`: they then answer from `store/api/mocks/pmsGoalAssignmentMock.ts` and `pmsManagerMock.ts`, which sit in front of the base query in `pmsApi.ts`. In static mode 3.1 and 3.2 share one set of goal sheets; 3.6 has its own.

### 2.3b Manager: progress, mid-year review and appraisal (screens 3.9 to 3.14)

These screens run on static data for now and are wired to PMS_Java (`/pms-goal-transfer`, `/pms-progress`, `/pms-mid-year`, `/pms-appraisal`; types in `types/pms-manager.ts`; contract in `PMS_Java/API_FRONTEND_GUIDE.md` section 10). Each screen also validates with Zod (`*.schema.ts` next to the page) before it calls the API. The data only appears once the employee has had goals approved by the HOD and has reported actuals and a self appraisal, because those are the sources.

| Screen | File | Route | Validation |
|---|---|---|---|
| 3.9 Team progress dashboard | `progress/TeamProgressPage.tsx` | `/pms/team-progress/:fy` | Read only |
| 3.10 Mid-year review, my team | `mid-year/MidYearTeamPage.tsx` | `/pms/mid-year-review/:fy` | Read only |
| 3.11 Mid-year review | `mid-year/MidYearReviewPage.tsx` | `/pms/mid-year-review/:fy/employee/:employeeUserId` | Revision choice required; notes (10+ chars) required when revising |
| 3.12 Target revision request | `mid-year/TargetRevisionRequestPage.tsx` | `.../employee/:employeeUserId/revision` | At least one target changed; reason per changed row; attachment PDF/Excel/image up to 5 MB |
| 3.13 Team appraisal | `appraisal/TeamAppraisalPage.tsx` | `/pms/team-appraisal/:fy` | Read only |
| 3.14 Manager rating, submit to HOD | `appraisal/ManagerAppraisalPage.tsx` | `/pms/team-appraisal/:fy/employee/:employeeUserId` | Every KRA and competency rated; recommended rating required; a rating 2+ points from self needs a comment |

Pages that load a record and then edit it are split into a loader component and a form component that starts from props (no state-setting effect). Follow that pattern for new forms.

### 2.3c Corporate HR: HR competency rating and calibration (screens 1.7 to 1.9)

Files: `pages/pms/hr/`

| Screen | File | Route | Status |
|---|---|---|---|
| 1.7 HR Competency Rating (list) | `HrCompetencyRatingPage.tsx` | `/pms/hr-competency-rating/:fy` | Wired to `/pms-hr-appraisal`; static data until `VITE_PMS_STATIC_DATA=false` |
| 1.8 HR Competency Rating (employee) | `HrCompetencyEmployeePage.tsx` | `/pms/hr-competency-rating/:fy/employee/:employeeUserId` | Same |
| 1.9 Calibration & Publish | `CalibrationPage.tsx` | `/pms/calibration/:fy` | Wired to `/pms-calibration`; same |
| Validation | `hr.schema.ts` | - | Zod: every HR competency rated; a changed rating needs a reason |

The API gates all of these on `rating_normalization`, the code Corporate HR already holds. The menu items carry no permission yet, like the other PMS items. Calibration works on the whole organisation for the year; there is no plant or department filter because PMS does not store them (only the department id).

### 2.3d Employee screens (4.1 to 4.6)

| Screen | File | Route | Status |
|---|---|---|---|
| 4.1 - 4.3 My Goals, request change, acknowledge | `goal-setting/MyGoalsPage.tsx` | `/pms/my-goals/:fy` | Static data (`mocks/pmsEmployeeMock.ts`) until `VITE_PMS_STATIC_DATA=false`; then the real `/pms-goal-assignment` API |
| 4.5 Acknowledge revised target | same page, when the sheet carries a `revision` | same | Static data. In the mock, the revision appears after you acknowledge the original goals |
| 4.4 Update Progress | `employee/MyProgressPage.tsx` | `/pms/my-progress/:fy` | Static data. The API has the PUT but no GET for the employee's own sheet yet |
| 4.6 Self Appraisal | `employee/SelfAppraisalPage.tsx` | `/pms/self-appraisal/:fy` | Static data. The API has the PUT but no GET, and no field for achievement text or comments |

Evidence uploads keep only the file name (`shared/EvidenceUpload.tsx`); file storage is not connected.

### 2.4 Not built yet

Routes for these exist in `router.tsx` and show `PmsComingSoon.tsx`:
employee-side and HOD-side progress tracking (6.x), HOD approval of target revisions (7.x), self appraisal and HOD review (8.x), final rating (10.x), cycle closure (11.x).

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

| Endpoint | Effect |
|---|---|
| `previewEligibleEmployees` | Eligibility preview always shows the same people. No endpoint in `PMS_Java` yet; it needs an employee-directory query from IAM |

Everything else goes to the PMS API, including the template status and duplicate calls. The manager screens (3.1 to 3.14) call the API (static data only with `VITE_PMS_STATIC_MANAGER=true`). The HR screens (1.7 to 1.9) and employee progress / self appraisal (4.4, 4.6) answer from static data until `VITE_PMS_STATIC_DATA=false`. Plants, departments and designations come from IAM (`usePmsPlants`, `usePmsDepartments`, `usePmsDesignations` in `pages/pms/shared/usePmsLookups.ts`; `fetchLookups` in `store/api/pmsLookups.ts` resolves ids to names inside the API layer). A PMS plant is an IAM business unit.

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
