# PMS module: status (completed and pending)

Last updated: 2026-10-13. Branch `feature/pms-goal-setting`.
Frontend: `Sentrifugo-FE/src/pages/pms`. Backend: `PMS_Java` (API base `/pms-*`).

## 1. End-to-end flow

```
Corporate HR config → Cycle published → Manager sets goals → Employee acknowledges / requests change
→ (Manager revises) → HOD approval → Progress / Mid-year review → Appraisal → HR rating → Calibration & publish
```

## 2. Completed

### 2.1 Corporate HR configuration (frontend + backend)
- Rating scale (create, standard levels), KRA master, KPI master, competency master (with Type HR / Manager).
- Goal templates: create, edit, status, copy to next year, duplicate, delete, view KRA/KPI. A template exists for every role.
- Seed data: KPIs for the KRAs and competencies for the organisation.

### 2.2 Cycle setup (frontend + backend)
- Cycle wizard: basic details, applicability, timeline, rating publish.
- Multiple employment types per cycle, eligible-employee preview, activation, cancel, cycle list and export.
- Fixes: employment-type check constraint, stale unique key (SQL V2).

### 2.3 Manager goal setting (frontend + backend, tested)
- My Team list with template and goal status.
- "Create & assign template" (request carries `template_id`; role-mismatch and team-membership checks).
- Target assignment page: KRA accordion with KPIs under it; save draft, validate (weights = 100%), send.
- Revise page for returned or change-requested sheets: only the questioned KPI is editable; remarks travel with the changed target.
- Goals set for manager Suresh's 10 employees.

### 2.4 Employee goal review (frontend + backend, tested)
- My Goals reads the real `GET /get/my-goals`, flat KPI list.
- Acknowledge (with optional comment) and request change (KPI, proposed target, reason).
- Change-request rules (backend + frontend, 27 backend tests passing):
  - `original_target` is set once and never overwritten; it is always shown in the Target column.
  - The Revised Target column shows the manager's latest finalised value; `revision_count` is kept per KPI.
  - One open request per KPI; the employee is locked until the manager sends the final target, then unlocked.
  - The full request log is kept (reason, proposed value, decision, final target, remarks, timestamps): `GET /get/my-change-requests` and `GET /get/change-requests`.
  - A "Your change requests" history table on My Goals.

### 2.5 Documentation
- Comments on every PMS frontend file and a README per `pages/pms/*` folder.
- `PMS_Java/API_FRONTEND_GUIDE.md`, `Sentrifugo-FE/src/store/api/PMS-API-INTEGRATION.md`, `docs/PMS-FRONTEND.md`.

### 2.6 Infrastructure
- PMS_Java startup error fixed.
- Seeding: direct_reports RPC, roles/permissions, hierarchy.

## 3. Built but not yet verified end to end
These screens and backend endpoints exist, but they were not tested against the real backend in this work the way 2.3 and 2.4 were. Several frontend calls are served by static mocks (`store/api/mocks/*`) unless switched to the real API.

| Area | Frontend | Backend endpoint (prefix) |
|---|---|---|
| HOD approval queue, review, approve, return | `GoalApprovalsPage`, `GoalReviewPage` | `/pms-goal-assignment/get/approvals`, `/approve`, `/return` |
| Send to HOD | `TeamGoalStatusPage` | `/pms-goal-assignment/send-to-hod` (mock case exists) |
| Transferred KRAs | `TransferredKrasPage` | `/pms-goal-transfer/*` (mocked in manager mock) |
| Team progress | `TeamProgressPage` | `/pms-progress/get/team` (mocked) |
| Mid-year review and target revision request | `MidYearReviewPage`, `MidYearTeamPage`, `TargetRevisionRequestPage` | `/pms-mid-year/*` (mocked) |
| Manager appraisal | `ManagerAppraisalPage`, `TeamAppraisalPage` | `/pms-appraisal/*` (mocked) |
| HR competency rating | `HrCompetencyRatingPage`, `HrCompetencyEmployeePage` | `/pms-hr-appraisal/*` (HR mock) |
| Calibration & publish | `CalibrationPage` | `/pms-calibration/*` (covered by an earlier backend test) |

## 4. Pending

### 4.1 Backend
- Employee-side endpoints for **My Progress (4.4)** and **Self Appraisal (4.6)**: no matching controller endpoints were found; the screens run on static data.
- Review and test the real flows for 3 above (HOD approval, transfer, mid-year, appraisal, HR rating, calibration).

### 4.2 Frontend
- Replace static mocks with the real APIs for each row in section 3, and check the env flags (`VITE_PMS_STATIC_MANAGER`, `VITE_PMS_STATIC_GOALS`, `VITE_PMS_STATIC_DATA`).
- Placeholder (`PmsComingSoon`) screens, not designed yet: **Target Revisions**, **Appraisal History**, **Lock Access**, **Cycle Closure**.
- Optional: manager-side view of the per-KPI change-request log (`useGetPmsChangeRequestsQuery` is wired but not used on a page).
- Optional: let one change request cover several KPIs (currently one KPI per request, one cycle at a time).

### 4.3 Database / deployment (yours to run)
- Restart `pms-app` to pick up the latest backend code.
- `ddl-auto=update` adds new nullable columns and tables, but not constraints or unique keys. Run `PMS_Java/sql/V2` to `V5` on databases that need them (V5 adds `original_target` and `goal_change_request`).

## 5. Suggested next order
1. HOD approval end to end (5.1, 5.2) with real data.
2. Transfer, progress and mid-year review on the real backend.
3. Employee progress and self appraisal: build the backend endpoints, then connect the screens.
4. Manager appraisal, HR rating, calibration and publish on real data.
5. The four placeholder screens, then a full regression.
