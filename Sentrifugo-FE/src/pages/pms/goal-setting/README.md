# Goal setting pages (screens 3.1 - 3.8, 4.1 - 4.3, 4.5, 5.1 - 5.2)

The goal sheet moves between three people:

```
Manager sets targets ──send──▶ Employee acknowledges (or requests a change)
        ▲                               │
        │ return                        ▼
      HOD  ◀──send to HOD── Manager (acknowledged sheets)  ──approve──▶ goals approved
```

Goal statuses (`goal_status`): `not_started`, `draft`, `sent_to_employee`, `acknowledged`, `change_requested`,
`with_hod`, `returned_by_hod`, `approved`, `transferred_in`.

## Manager

### TeamGoalSettingPage.tsx - 3.1 "My Team"

| | |
|---|---|
| Route | `/pms/team-goal-setting/:fy` |
| Data | `useGetPmsTeamQuery(financialYear)` (GET `/pms-goal-assignment/get/team`) |
| Shows | Each direct report, role, template and goal status with a row button (Set Goals / Continue / Revise / View / Set KRAs) |
| Actions | Row button opens the right form; **Set Goals** goes to 3.2; financial-year dropdown; **Send to HOD** on an acknowledged row opens `SendToHodDialog` |
| Send to HOD | Only revised KRAs go to the HOD: those whose target moved after the manager first assigned it. A sheet with no revised KRA is approved when the employee acknowledges, and never reaches the HOD. `SendToHodDialog.tsx` lists the KRAs revised since the targets were first assigned (`original_target` vs `target`), checks the sheet is complete (`sendToHod.schema.ts`: every target set, weights total 100) and takes an optional note (max 500). Calls `useSendGoalsToHodMutation` (POST `/pms-goal-assignment/send-to-hod` with `{ financial_year, employee_user_ids, remarks }`). The API refuses anything but an acknowledged sheet (422 `PMS_INVALID_GOAL_STATE`) or an incomplete one (422 `PMS_TARGETS_INVALID`). |

### SelectRoleTemplatePage.tsx - 3.2 "Goal Setting - Create Template"

| | |
|---|---|
| Route | `/pms/team-goal-setting/:fy/role` |
| Data | `useGetPmsRoleEmployeesQuery`, `useAssignRoleTemplateMutation` (POST `/pms-goal-assignment/assign-template` with `{ financial_year, designation_id, template_id }`; `template_id` comes from the team rows) |
| Shows | A role dropdown, the role's active template (auto-loaded), a banner counting employees without a template, and the employees of that role: type, **template** ("Not assigned" until assigned), goal status, action |
| Actions | **Create & assign template** gives the template to every employee in the role who has none (employees whose sheet already started keep theirs). Then open one employee: **Set Targets** (disabled until the template is assigned), Continue, Revise, View |
| Notes | Setting targets before the template is assigned is refused by the API (409 `PMS_TEMPLATE_NOT_ASSIGNED`). "Set Goals" on 3.1 / 3.6 for an unassigned employee opens this page. The "Type" column shows "—" until IAM's `direct_reports` reply includes the employment type. |

### TargetAssignmentPage.tsx - 3.3 - 3.5 "Employee Target Assignment"

| | |
|---|---|
| Route | `/pms/team-goal-setting/:fy/employee/:employeeUserId` |
| Data | `useGetPmsEmployeeTargetsQuery`; `useSaveEmployeeTargetsMutation`, `useValidateEmployeeTargetsMutation`, `useSendEmployeeTargetsMutation` |
| Steps | **Save Draft** (any state) → **Validate** → confirmation dialog → **Send to employee** |
| Validation | `target.schema.ts` (`checkTargetRows`): weight and target required and numeric, weight 0-100, total weight = 100; then the API validates again |
| Notes | Read-only once the sheet is with the employee or beyond. A side panel shows the KPI's previous years (target vs actual) until Validate is pressed. |

### TeamGoalStatusPage.tsx - 3.6 "My Team, Goal Status"

| | |
|---|---|
| Route | `/pms/team-goal-setting/:fy/status` |
| Data | `useGetPmsTeamStatusQuery`, `useGetPmsTransferNoticesQuery`, `useSendGoalsToHodMutation` |
| Shows | Goal status per employee, banners for returned sheets and employees transferred into the team |
| Actions | Tick acknowledged sheets and **Send to HOD**; per-row actions as on 3.1 |

### ReviseReturnedGoalsPage.tsx - 3.7 "Review & Revise"

| | |
|---|---|
| Route | `/pms/team-goal-setting/:fy/employee/:employeeUserId/revise` |
| Purpose | A sheet came back (employee change request or HOD return): change targets, explain, send again |
| Data | `useGetPmsEmployeeTargetsQuery`, `useSaveEmployeeTargetsMutation`, `useSendEmployeeTargetsMutation` |
| Validation | `revise.schema.ts`: revised target numeric and not negative; a changed target needs a remark of 3+ characters |
| Notes | Weights are locked. Shows the employee comment or HOD remark that caused the return. |

### TransferredKrasPage.tsx - 3.8 "Goal Sheet" for a transferred employee

| | |
|---|---|
| Route | `/pms/team-goal-setting/:fy/employee/:employeeUserId/transfer` |
| Purpose | An employee joined mid-year: period 1 KRAs are frozen; set period 2 KRAs |
| Data | `useGetPmsTransferGoalSheetQuery`, `useSaveTransferGoalSheetMutation`, `useSendTransferGoalSheetMutation` |
| Actions | Edit weight / target of template KRAs, add or edit a KRA in a dialog, remove added KRAs, pick a reason, write remarks, save draft, send |
| Validation | `transfer.schema.ts`: at least one KRA; period 2 weights total 100; reason chosen; remarks 10-500 characters |

## Employee

### MyGoalsPage.tsx - 4.1 / 4.2 / 4.3 / 4.5 "My Goals"

| | |
|---|---|
| Route | `/pms/my-goals/:fy` |
| Data | `useGetPmsMyGoalsQuery` (GET `/pms-goal-assignment/get/my-goals`: KRAs and KPIs with weight, target, unit, evidence; `manager_name`, `sent_on`, `acknowledge_by`, `revision`), `useAcknowledgeMyGoalsMutation`, `useRequestGoalChangeMutation`. Real API by default; `VITE_PMS_STATIC_GOALS=true` uses a static sheet |
| 4.1 | Blue banner "Goals sent by <manager> on <date> · Respond by <date>", the KRA table, **Request Change** and **Acknowledge** (only while the sheet is `sent_to_employee`) |
| 4.2 | Request Change dialog: choose a KRA, optional proposed target, required reason |
| 4.3 | Acknowledge dialog: tick the confirmation, optional comment |
| 4.5 | When the sheet carries a HOD-approved `revision`: green "Target revised" banner, a **Revised target** column ("No change" on other rows) and the same two buttons |
| Notes | The API's current response has no `sent_on` or `acknowledge_by`; the banner falls back to a status sentence. |

## HOD

### GoalApprovalsPage.tsx - 5.1 "Team Goals Settings"

Route `/pms/goal-approvals/:fy`. Data `useGetPmsApprovalsQuery`. Lists sheets waiting for approval; **Review**
opens 5.2.

### GoalReviewPage.tsx - 5.2 "Goal Approval"

| | |
|---|---|
| Route | `/pms/goal-approvals/:fy/employee/:employeeUserId` |
| Data | `useGetPmsEmployeeTargetsQuery` (the same sheet), `useApproveGoalsMutation`, `useReturnGoalsMutation` |
| Actions | **Approve** (remarks optional) or **Return to manager** (remark required) |

## Schema files

| File | Contents |
|---|---|
| `target.schema.ts` | `TargetFormRow`, `checkTargetRows` (3.3 - 3.5) |
| `revise.schema.ts` | `reviseSchema` (3.7) |
| `transfer.schema.ts` | `TRANSFER_REASONS`, `transferKraSchema`, `transferSchema` (3.8) |

## HOD approval screens

| File | Route | What it does |
|---|---|---|
| `GoalApprovalsPage.tsx` | `/pms/goal-approvals/$fy` | List of goal sheets and target revisions sent to the HOD; filter chips, Approve Selected (per-request result). |
| `GoalReviewPage.tsx` | `/pms/goal-approvals/$fy/review/$requestType/$employeeUserId` | Review one request. A revision is approved or returned KRA by KRA; a goal sheet as a whole. Previous / Next walk the list. |
| `hod/ReturnToManagerDialog.tsx` | (dialog) | Return with mandatory remarks (max 500). |
| `ApprovalHistoryPage.tsx` | `/pms/goal-approvals/$fy/history` | Decisions already made, with search and filters. |
| `ApprovalTrailPage.tsx` | `/pms/goal-approvals/$fy/trail/$employeeUserId` | How each KPI moved and every request of one employee. |
| `hod/hod.utils.ts`, `hod/hod.components.tsx` | | Paths, number formatting and small shared components. |
