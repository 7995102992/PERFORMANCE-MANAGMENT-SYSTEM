# PMS API integration (frontend)

How the PMS screens talk to **PMS_Java**. Read this with `pmsApi.ts`, which holds every call.

Related: the backend contract is in `PMS_Java/API_FRONTEND_GUIDE.md`; the screens are described in
`src/pages/pms/README.md` and the README in each page folder.

---

## 1. The pieces

| File | What it does |
|---|---|
| `pmsApi.ts` | The RTK Query API: one endpoint per backend call, the generated hooks, and the static-data switch. |
| `pmsMappers.ts` | Converts between the API shape (snake_case, ids, `2026-27`) and the screen shape (`2026`, names). |
| `pmsLookups.ts` | Plants, departments and designations come from **IAM**, not PMS. Turns IAM records into PMS options. |
| `baseQuery.ts` | Shared fetch wrapper: base URL, bearer token, error shape. `pmsApi` creates it with the PMS base URL. |
| `mocks/*.ts` | Static data used instead of the API (see section 4). |
| `src/types/pms*.ts` | TypeScript shapes of everything that crosses the wire. |

### Request path

```
page  →  hook (useGetPmsCyclesQuery …)  →  pmsBaseQuery
                                              │  static mock switched on and handles it?  → mock data
                                              └  otherwise → realBaseQuery → PMS_Java → { success, message, data }
```

Every PMS_Java reply is wrapped as `{ success, message, data }`. Each endpoint unwraps it with
`transformResponse` (or `unwrapEnvelope` inside a `queryFn`), so pages only see `data`.

## 2. Configuration

| Setting | Where | Meaning |
|---|---|---|
| `VITE_PMS_API_BASE_URL` | `.env` | Host of PMS_Java, e.g. `http://localhost:8080`. The code appends `/api/v1/pms`. |
| `VITE_PMS_STATIC_MANAGER=true` | `.env` | Manager screens (3.x) answer from `pmsGoalAssignmentMock` / `pmsManagerMock` instead of the API. Off by default. |
| `VITE_PMS_STATIC_DATA=false` | `.env` | Sends the HR screens (1.7 - 1.9) and employee progress / self appraisal (4.4, 4.6) to the API too. Without it they use static data. |

Restart the Vite dev server after changing `.env`.

The signed-in user's bearer token is added by `baseQuery.ts`. PMS_Java reads the session IAM wrote to Valkey
(`session:<token>`), so the user must be signed in through IAM.

## 3. Endpoints, hooks and the pages that use them

"Permission" is the `performance_management` action PMS_Java checks. A 403 means the logged-in user lacks it.

### Appraisal cycles (`/pms-cycle`)

| Hook | Method and path | Permission | Used by |
|---|---|---|---|
| `useGetPmsCyclesQuery` | GET `/pms-cycle/get/cycles` | any signed-in user | `PmsCycleList` |
| `useGetPmsCycleQuery` | GET `/pms-cycle/get/cycle/{id}` | any | `InitiateAppraisal` |
| `useCreatePmsCycleMutation` | POST `/pms-cycle/create/cycle` | `pms_cycle` | `InitiateAppraisal` |
| `useUpdatePmsCycleMutation` | PUT `/pms-cycle/update/cycle/{id}` | `pms_cycle` | `InitiateAppraisal` |
| `usePublishPmsCycleMutation` | POST `/pms-cycle/publish/cycle/{id}` | `pms_cycle` | `InitiateAppraisal` |
| `useGetPmsCycleActivationQuery` | GET `/pms-cycle/get/cycle/{id}/activation` | any | `CycleActivated` |
| `useCancelPmsCycleMutation` | POST `/pms-cycle/cancel/cycle/{id}` | `pms_cycle` | (cancel action) |
| `useExportPmsCyclesMutation` | GET `/pms-cycle/get/cycles/export` | any | `PmsCycleList` |
| `usePreviewEligibleEmployeesMutation` | **mocked** (no endpoint yet) | - | `EligibleEmployeesDialog` |

### Masters and rating scales (`/pms-master`, `/pms-rating-scale`)

| Hook | Method and path | Used by |
|---|---|---|
| `useGetPmsKrasQuery`, `useCreatePmsKraMutation`, `useUpdatePmsKraMutation`, `useDeletePmsKraMutation` | `/pms-master/get/kras`, `create/kra`, `update/kra/{id}`, `delete/kra/{id}` | `KraMaster`, `KpiMaster`, template wizard |
| `useGetPmsKpisQuery`, `useCreatePmsKpiMutation`, `useUpdatePmsKpiMutation`, `useDeletePmsKpiMutation`, `useGetPmsKpiUnitsQuery` | `/pms-master/get/kpis`, `create/kpi`, `update/kpi/{id}`, `delete/kpi/{id}`, `get/kpi-units` | `KpiMaster`, template wizard |
| `useGetPmsCompetenciesQuery`, `useCreatePmsCompetencyMutation`, `useUpdatePmsCompetencyMutation`, `useDeletePmsCompetencyMutation` | `/pms-master/get/competencies`, `create/competency`, `update/competency/{id}`, `delete/competency/{id}` | `CompetencyMaster`, template wizard |
| `useGetPmsRatingScalesQuery` | GET `/pms-rating-scale/get/rating-scales?status=active` | `RatingPublishStep` |
| `useGetPmsRatingScaleConfigsQuery`, `useCreatePmsRatingScaleMutation`, `useUpdatePmsRatingScaleMutation` | `/pms-rating-scale/get/rating-scales`, `create/rating-scale`, `update/rating-scale/{id}` | `RatingScale`, `AddRatingScaleDialog` |
| `useGetPmsStandardRatingLevelsQuery`, `useCreatePmsStandardRatingLevelMutation` | `/pms-master/get/standard-rating-levels`, `create/standard-rating-level` | `AddRatingScaleDialog` |

### Goal templates (`/pms-goal-template`)

| Hook | Method and path | Used by |
|---|---|---|
| `useGetPmsTemplatesQuery` | GET `/get/goal-templates` | `GoalTemplateList` |
| `useGetPmsTemplateQuery` | GET `/get/goal-template/{id}` | `GoalTemplateWizard` |
| `useCreatePmsTemplateMutation` | POST `/create/goal-template`, then PUT `.../{id}/kra-kpi`, PUT `.../{id}/competencies` | `GoalTemplateWizard` |
| `useUpdatePmsTemplateMutation` | PUT `/update/goal-template/{id}`, then the same two PUTs | `GoalTemplateWizard` |
| `useSetPmsTemplateStatusMutation` | PUT `/update/goal-template/{id}/status` | `GoalTemplateList` |
| `useDuplicatePmsTemplateMutation` | POST `/duplicate/goal-template/{id}` | `GoalTemplateList` |
| `useDeletePmsTemplateMutation` | DELETE `/delete/goal-template/{id}` | `GoalTemplateList` |
| `useGetPmsCopyPreviewQuery`, `useCopyPmsTemplatesMutation` | GET `/get/copy-preview`, POST `/copy` | `CopyTemplateDialog` |

A template save is **three calls** (basic info, KRA/KPI, competencies). If call 2 or 3 fails, the basic
info is already saved; the wizard keeps the new id so retrying updates it instead of creating a second one.

### Goal assignment (`/pms-goal-assignment`) - manager, employee and HOD

| Hook | Method and path | Permission | Used by |
|---|---|---|---|
| `useGetPmsTeamQuery`, `useGetPmsRoleEmployeesQuery`, `useGetPmsTeamStatusQuery` | GET `/get/team` (the last two add `scope=role` / `scope=status`, which the real API ignores) | `team_goals` | `TeamGoalSettingPage`, `SelectRoleTemplatePage`, `TeamGoalStatusPage` |
| `useAssignRoleTemplateMutation` | POST `/assign-template` | `team_goals` | `SelectRoleTemplatePage` |
| `useGetPmsEmployeeTargetsQuery` | GET `/get/employee-targets` | `team_goals` | `TargetAssignmentPage`, `ReviseReturnedGoalsPage` |
| `useSaveEmployeeTargetsMutation` | PUT `/update/employee-targets` | `team_goals` | same pages |
| `useValidateEmployeeTargetsMutation` | POST `/validate` | `team_goals` | `TargetAssignmentPage` |
| `useSendEmployeeTargetsMutation` | POST `/send` | `team_goals` | `TargetAssignmentPage`, `ReviseReturnedGoalsPage` |
| `useSendGoalsToHodMutation` | POST `/send-to-hod` | `team_goals` | `TeamGoalStatusPage` |
| `useGetPmsMyGoalsQuery` | GET `/get/my-goals` | `my_goals` | `MyGoalsPage` |
| `useGetPmsMyChangeRequestsQuery` | GET `/get/my-change-requests` | `my_goals` | `MyGoalsPage` (request log) |
| `useGetPmsChangeRequestsQuery` | GET `/get/change-requests` | `team_goals` | manager views (request log) |
| `useAcknowledgeMyGoalsMutation` | POST `/acknowledge` | `my_goals` | `MyGoalsPage` |
| `useRequestGoalChangeMutation` | POST `/request-change` | `my_goals` | `MyGoalsPage` |
| `useGetPmsApprovalsQuery` | GET `/get/approvals` | `goal_approval` | `GoalApprovalsPage` |
| `useApproveGoalsMutation`, `useReturnGoalsMutation` | POST `/approve`, `/return` | `goal_approval` | `GoalReviewPage` |

### Transfers, progress, mid-year, appraisal

| Hook | Method and path | Permission | Used by |
|---|---|---|---|
| `useGetPmsTransferNoticesQuery` | GET `/pms-goal-transfer/get/notices` | `team_goals` | `TeamGoalStatusPage` |
| `useGetPmsTransferGoalSheetQuery` | GET `/pms-goal-transfer/get/transfer-sheet` | `team_goals` | `TransferredKrasPage` |
| `useSaveTransferGoalSheetMutation` | PUT `/pms-goal-transfer/update/transfer-sheet` | `team_goals` | `TransferredKrasPage` |
| `useSendTransferGoalSheetMutation` | POST `/pms-goal-transfer/send/transfer-sheet` | `team_goals` | `TransferredKrasPage` |
| `useGetPmsTeamProgressQuery` | GET `/pms-progress/get/team` | `team_progress` | `TeamProgressPage` |
| `useGetPmsMidYearTeamQuery` | GET `/pms-mid-year/get/team` | `mid_year_review` | `MidYearTeamPage` |
| `useGetPmsMidYearReviewQuery` | GET `/pms-mid-year/get/review` | `mid_year_review` | `MidYearReviewPage` |
| `useSubmitPmsMidYearReviewMutation` | POST `/pms-mid-year/submit/review` | `mid_year_review` | `MidYearReviewPage` |
| `useGetPmsRevisionRequestQuery` | GET `/pms-mid-year/get/revision-request` | `mid_year_review` | `TargetRevisionRequestPage` |
| `useSubmitPmsRevisionRequestMutation` | POST `/pms-mid-year/submit/revision-request` | `mid_year_review` | `TargetRevisionRequestPage` |
| `useGetPmsTeamAppraisalQuery` | GET `/pms-appraisal/get/team` | `team_appraisal` | `TeamAppraisalPage` |
| `useGetPmsManagerAppraisalQuery` | GET `/pms-appraisal/get/manager-appraisal` | `team_appraisal` | `ManagerAppraisalPage` |
| `useSavePmsManagerAppraisalMutation` | PUT `/pms-appraisal/update/manager-appraisal` | `team_appraisal` | `ManagerAppraisalPage` |
| `useSubmitPmsManagerAppraisalMutation` | POST `/pms-appraisal/submit/manager-appraisal` | `team_appraisal` | `ManagerAppraisalPage` |

### Employee progress and self appraisal

| Hook | Method and path | Status | Used by |
|---|---|---|---|
| `useGetPmsMyProgressQuery` | GET `/pms-progress/get/my-progress` | **no backend endpoint yet** (static data only) | `MyProgressPage` |
| `useSavePmsMyProgressMutation` | PUT `/pms-progress/update/my-progress` | exists (`progress`) | `MyProgressPage` |
| `useGetPmsMySelfAppraisalQuery` | GET `/pms-appraisal/get/self-appraisal` | **no backend endpoint yet** | `SelfAppraisalPage` |
| `useSavePmsMySelfAppraisalMutation` | PUT `/pms-appraisal/update/self-appraisal` | exists (`self_appraisal`); has no field for achievement text or competency comments | `SelfAppraisalPage` |

### Corporate HR (`/pms-hr-appraisal`, `/pms-calibration`) - permission `rating_normalization`

| Hook | Method and path | Used by |
|---|---|---|
| `useGetPmsHrQueueQuery` | GET `/pms-hr-appraisal/get/queue` | `HrCompetencyRatingPage` |
| `useGetPmsHrAppraisalQuery` | GET `/pms-hr-appraisal/get/employee` | `HrCompetencyEmployeePage` |
| `useSavePmsHrAppraisalMutation` | PUT `/pms-hr-appraisal/update/hr-ratings` | `HrCompetencyEmployeePage` |
| `useSubmitPmsHrAppraisalMutation` | POST `/pms-hr-appraisal/submit/hr-ratings` | `HrCompetencyEmployeePage` |
| `useSendPmsToCalibrationMutation` | POST `/pms-hr-appraisal/send/calibration` | `HrCompetencyRatingPage` |
| `useGetPmsCalibrationQuery` | GET `/pms-calibration/get/calibration` | `CalibrationPage` |
| `useSavePmsCalibrationMutation` | PUT `/pms-calibration/update/calibration` | `CalibrationPage` |
| `usePublishPmsCalibrationMutation` | POST `/pms-calibration/publish/calibration` | `CalibrationPage` |

## 4. Static data (mocks)

Used when the backend is not available or the endpoint does not exist yet. State lives in memory, so it
survives navigation and is lost on reload.

| Mock file | Covers | Switch |
|---|---|---|
| `pmsGoalAssignmentMock.ts`, `pmsManagerMock.ts` | Manager screens 3.1 - 3.14 | on only with `VITE_PMS_STATIC_MANAGER=true` |
| `pmsHrMock.ts` | HR screens 1.7 - 1.9 | on unless `VITE_PMS_STATIC_DATA=false` |
| `pmsEmployeeMock.ts` | My Goals review (4.1 - 4.3, 4.5), progress (4.4), self appraisal (4.6) | on unless `VITE_PMS_STATIC_DATA=false` |
| `pmsCycleMock.ts`, `pmsConfigMock.ts` | The eligibility preview (cycle step 3) is the only one still used; the rest are kept as fixtures | - |

Each mock exports a `static…` function that receives the base-query arguments (`url`, `params`, `body`) and
either answers or returns `null`, which sends the call on to the real API.

## 5. Mapping and naming conventions

- **Financial year:** screens use the start year (`2026`, from the URL `/pms/…/2026`); the API uses `"2026-27"`.
  Use `fyToApi` / `fyFromApi`.
- **Names for ids:** PMS stores only IAM ids for plants, departments and designations. `fetchLookups`
  (inside a `queryFn`) or `usePmsPlants` / `usePmsDepartments` (inside a component) resolve names.
- **"All plants":** the API stores `all_plants: true`. `cycleFromApi` expands it to every plant id so the form
  shows them ticked; `cycleToApi` collapses a full selection back to `all_plants: true`.
- **Dates:** ISO `YYYY-MM-DD` strings everywhere; convert with `isoToDate` / `dateToIso`.
- **Employment types:** `permanent`, `contract`, `probationary`, `trainee`.

## 6. Errors

PMS_Java errors look like `{ detail, code }` with an HTTP status.
Pages show them with `toast.error(e, "fallback message")`, which prefers `detail`. Codes the screens rely on:

| Code | Meaning |
|---|---|
| `PMS_CYCLE_PUBLISH_VALIDATION_FAILED` (422) | Cycle incomplete; `detail` lists every missing field |
| `PMS_GOALS_NOT_FOUND` (404) | Manager has not set goals for the year |
| `PMS_SELF_APPRAISAL_PENDING` (409) | Employee has not submitted a self appraisal yet |
| `PMS_APPRAISAL_INVALID` (422) | Manager appraisal incomplete or a wide gap has no comment |
| `PMS_CALIBRATION_TOTAL` (422) | HR normalization targets do not total 100% |
| `PMS_NOT_IN_TEAM` (403) | The employee is not a direct report of the caller |
| `IAM_UNAVAILABLE` (503) | PMS could not reach the IAM employee directory |

## 7. Cache tags

| Tag | Provided by | Invalidated by |
|---|---|---|
| `PmsCycle` (`LIST` and id) | cycle list, cycle | create / update / publish / cancel cycle |
| `PmsKra`, `PmsKpi`, `PmsCompetency` | the master lists | create / update / delete of that master |
| `PmsRatingScale` | rating scale lists, standard levels | create / update scale, add standard level |
| `PmsTemplate` | template list and one template; also the manager goal sheets (`TEAM`, `TARGETS-<id>`), `MY-GOALS`, `APPROVALS` | template changes; save / send / acknowledge / approve |
| `PmsManager` | transfers, progress, mid-year, appraisal, employee progress and self appraisal, HR queue, calibration | the matching save / submit |

## 8. Adding an endpoint

1. Add the shape to `src/types/pms-*.ts`.
2. Add a `builder.query` or `builder.mutation` in `pmsApi.ts`, with `providesTags` / `invalidatesTags`.
3. If the API shape differs from the screen shape, add a `…FromApi` / `…ToApi` pair in `pmsMappers.ts`.
4. Export the hook at the bottom of `pmsApi.ts`.
5. Optional: add the call to the matching mock so the screen works with static data.
6. Document it in the table above and in the README of the page folder.

## HOD approvals (`goal_approval`)

| Hook | Endpoint | Screen |
|---|---|---|
| `useGetPmsHodQueueQuery` | GET `/get/hod-queue` | `GoalApprovalsPage` |
| `useGetPmsHodReviewQuery` | GET `/get/hod-review` | `GoalReviewPage` |
| `useHodApproveMutation` | POST `/hod/approve` | `GoalReviewPage` |
| `useHodReturnMutation` | POST `/hod/return` | `GoalReviewPage` (via `ReturnToManagerDialog`) |
| `useHodApproveSelectedMutation` | POST `/hod/approve-selected` | `GoalApprovalsPage` |
| `useGetPmsHodHistoryQuery` | GET `/get/hod-history` | `ApprovalHistoryPage` |
| `useGetPmsHodTrailQuery` | GET `/get/hod-trail` | `ApprovalTrailPage` |

## Stage notices (bell and banner)

| Hook | Endpoint | Used by |
|---|---|---|
| `useGetPmsStageNoticesQuery` | GET `/get/stage-notices` | `layouts/Topbar.tsx` (bell), `StageWindowBanner` on Team Goal Setting, My Goals, Goal Approvals |
