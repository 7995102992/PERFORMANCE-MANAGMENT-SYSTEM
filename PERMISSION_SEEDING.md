# PMS Roles – Final README (menus, screens, privileges, seed instructions)

Source: the final menu maps and the top-to-bottom PMS flow (9 diagrams), plus the Create Role screen (21 Performance Management permission rows).
This file **replaces** `PMS_Role_Privileges_README.md` and `SEED_PMS_ROLE_PERMISSIONS.md`. Where they disagree with this file, this file wins (see section 9 for what changed).

Audience: (a) the admin who ticks privileges on **Create Role**, (b) Claude Code, which seeds the roles.

---

## 1. Hard rules for Claude Code (read first)

1. **Additive only.** Do not edit, rename, reorder or delete any existing module, tab, menu item, permission row, role or user-role link. Module cards: Core HR, Leave & Attendance, Performance Management, Reports & Analytics, Service Request, Timesheet Management.
2. **No UI changes.** Do not touch the Create Role screen, sidebar, routes or styles. Data and a seed script only.
3. **Do not invent the schema.** Find how roles and permissions are stored (section 2) and follow it. If you cannot find it, stop and report. Do not create tables or columns to fit the seed.
4. **Idempotent.** Running twice gives the same result. Match on stable keys (role name, permission name); insert only what is missing.
5. **Never overwrite an existing role.** If a role name already exists, skip it and report the differences from this file.
6. **Dry run first.** `--dry-run` prints exactly what would be inserted and changes nothing. Show the output, then run for real.
7. **Development database only.**
8. **The app wins.** If this file conflicts with how the app actually works, report the conflict. Do not force the data.
9. **Do not create or assign users.** The people named below are examples from the screens.

---

## 2. Discovery (do first, report before seeding)

1. Find the Create Role screen and its API. Search: "Role Name", "Copy all permissions from", "Select a module", "Viewer", "Editor", "Administrator".
2. Find the Performance Management permission list. Existing 21 rows (use the stored names exactly): Appraisal History, Appraisal Review, Competency Master, Create Resource, Cycle Closure, Goal Approval, Goal Template, Kpi Master, Kra Master, Mid Year Review, My Goals, My Rating, Pms Cycle, Progress, Rating Normalization, Rating Scale, Self Appraisal, Target Revision, Team Appraisal, Team Goals, Team Progress.
3. Find how levels are stored (three booleans, one enum, or a bitmask). Check what the screen stores when only **Editor** is ticked.
4. Find how a role links to a module. Performance Management must be selected; **Core HR is mandatory**.
5. Follow the project's migration/seed conventions and put the seed where other seeds live.
6. Check whether any of the seven role names already exist.
7. **Sidebar check:** find which permission row controls each PMS sidebar item (for example the item "Team Appraisal" and the item "Calibration"). Report it. Section 8, item D3 depends on it.

---

## 3. Level meanings (cumulative)

| Level | Can do |
|---|---|
| **V** Viewer | Open the screen, read, download |
| **E** Editor | V + save, submit, send, approve, return, acknowledge |
| **A** Administrator | E + create, delete, publish |

Ticks are cumulative (A includes E and V). If the app stores levels differently, mirror the app and note it.

**Permissions control which screens a role can open, not whose records appear.** Scope (own team, department, plant, all plants) comes from the reporting hierarchy and plant mapping (Assign Head, Employees, Business Units). Do not change that.

---

## 4. Hierarchy (from the index sheet)

- **Corporate Office:** GP → Corporate HR → Functional Head → Reporting Manager → Employee.
- **Plant:** GP → Plant Head → Plant HR → HOD / Functional Head → Section Head (GM/AGM) → Employee.

Corporate Office has no Plant HR or Plant Head. Corporate Office people use the **Reporting Manager = Section Head** set and the **Functional Head = HOD** set. No separate role is created. Trainee and Probationary staff use the **Employee** role (their Self Appraisal is closed by eligibility rules, not by permissions).

---

## 5. Final permission matrix (21 existing rows, default seed)

V = Viewer, E = Editor, A = Administrator, — = not granted.

| Permission row | Corp HR | GP | Employee | Section Head | HOD | Plant HR | Plant Head |
|---|---|---|---|---|---|---|---|
| Pms Cycle | A | — | — | — | — | — | — |
| Goal Template | A | V | — | — | — | — | — |
| Kra Master | A | V | — | — | — | — | — |
| Kpi Master | A | V | — | — | — | — | — |
| Competency Master | A | V | — | — | — | — | — |
| Rating Scale | A | V | — | — | — | — | — |
| Team Goals | — | — | — | E | E | E | E |
| Goal Approval | — | — | — | — | E | — | E |
| Target Revision | E | — | — | — | E | — | E |
| My Goals | E | — | E | E | E | E | E |
| Progress | — | — | E | — | — | — | — |
| Team Progress | — | — | — | V | V | V | V |
| Mid Year Review | E | — | — | E | E | E | E |
| Self Appraisal | E | — | E | E | E | E | E |
| Team Appraisal | E | — | — | E | see D3 | E | E |
| Appraisal Review | — | — | — | — | E | — | — |
| My Rating | — | — | V | — | — | — | — |
| Rating Normalization (Calibration) | A | — | — | — | — | — | — |
| Appraisal History | V | — | — | — | — | V | V |
| Cycle Closure | A | — | — | — | — | — | — |
| Create Resource | — | — | — | — | — | — | — |

Every role also gets the module **Performance Management** and the mandatory **Core HR**. No other module.

### Extra rows the screens need (default: SKIP, see section 7)

| New row | Corp HR | GP | Plant HR | Plant Head |
|---|---|---|---|---|
| HR Competency Rating | E | — | E | — |
| Verification | — | — | — | E |
| Transfers | — | — | E | — |
| Audit Trail | V | — | — | — |
| Version History | V | — | — | — |
| Appraisal Dashboard | — | V | — | — |

---

## 6. Role-by-role README

Each section: who, what the final menu map shows, exactly what to tick, what is not granted and why, open points.

### 6.1 Corporate HR  (example user: Lakshmi Prasanna)

**Scope:** all plants and Corporate Office.

**Menu → screens (from the final map)**

| Menu | Flow shown | Permission row |
|---|---|---|
| Configuration ▸ | Opens Goal Templates, KRA Master, KPI Master, Competency Master, Rating Scale (see 6.2 for the screens) | Goal Template, Kra Master, Kpi Master, Competency Master, Rating Scale |
| Initiate Appraisal | PMS Cycle → Create New Appraisal (Basic Details) → Timeline & Milestones → Applicability & Eligibility → Rating Scale & Publish → Cycle Activated | Pms Cycle |
| My Goals · Self Appraisal · Mid-Year Review · Team Appraisal | Her own goals and her own team. Same screens as Employee and Section Head. Not drawn separately | My Goals, Self Appraisal, Mid Year Review, Team Appraisal |
| Goal Approvals | **No screen.** Nothing is routed to Corporate HR for goal-sheet approval yet | — (open point D4) |
| Target Revisions | Target Revisions – Corporate Office → Review Revision → Approve / Return Revision. Approve → employee acknowledges the revised target. Return → back to the Functional Head. Corporate Office only (Functional Heads' direct reports) | Target Revision |
| HR Competency Rating | Corporate Office only. HR Competency Rating – Corporate Office → Rate → HR Competency Rating – Employee → Submit → ready for calibration (the 4 HR competencies) | HR Competency Rating (extra row) |
| Calibration | Calibration & Publish → Approve & Publish Ratings → employees can see the final rating. Plants arrive after Plant Head verification; Corporate Office after HR competency rating | Rating Normalization |
| Appraisal History | All plants. View → Employee Appraisal (view & download) → Version history (popup) | Appraisal History; Version History (extra row) |
| Audit Trail | Who changed what and when | Audit Trail (extra row) |
| Cycle Closure | Close Cycle & Prepare Next → Close & Archive (cycle closed, data archived); or Create Next Cycle → Create New Appraisal | Cycle Closure |

**Seed rows (default):** Pms Cycle A, Goal Template A, Kra Master A, Kpi Master A, Competency Master A, Rating Scale A, Rating Normalization A, Cycle Closure A, Target Revision E, My Goals E, Self Appraisal E, Mid Year Review E, Team Appraisal E, Appraisal History V.
**With extras flag:** HR Competency Rating E, Audit Trail V, Version History V.

**Not granted:** Goal Approval (no screen drawn), Team Goals and Team Progress (not in her menu), Progress, My Rating, Appraisal Review, Create Resource.

**Why A on Rating Normalization:** "Approve & Publish Ratings" is a cycle-level action that is hard to reverse. Use E if you want A kept for configuration only.

**Open:** D4.

---

### 6.2 GP – Group President  (example user: M. Raghunath)

**Scope:** all plants, read-only monitoring.

**Menu → screens**

| Menu | Flow shown | Permission row |
|---|---|---|
| Configuration ▸ | Same sub-menu and screens as Corporate HR: Goal Templates (Template List; Copy → Copy Template popup; Create Template → Basic Info → KRA & KPI Configuration → Competency Configuration → Save, template available for goal setting), KRA Master (Add KRA popup), KPI Master (Add KPI popup), Competency Master (type Manager / HR decides who rates), Rating Scale (All Scales; Add popup; Edit) | Goal Template, Kra Master, Kpi Master, Competency Master, Rating Scale |
| Appraisal Dashboard | Plant / Department Progress → Stage count → Stage Drill-down (Employees) → View → Employee Appraisal (view & download) → Download PDF. "Read-only monitoring across all plants" | Appraisal Dashboard (extra row) |

**Seed rows (default):** Goal Template V, Kra Master V, Kpi Master V, Competency Master V, Rating Scale V.
**With extras flag:** Appraisal Dashboard V.

**Not granted:** every workflow row (My Goals, Self Appraisal, Team rows, approvals, calibration, closure). GP is not shown in any workflow step. **Appraisal History is not in the GP menu**, so it is not granted by default (changed from the earlier README, see D2).

**Open:** D1 (V or A on configuration), D2 (how GP views and downloads an appraisal if the Appraisal Dashboard row is skipped), D5.

---

### 6.3 Employee  (example user: Suresh Babu N.)

Also used by Trainee and Probationary employees.

| Menu | Flow shown | Permission row |
|---|---|---|
| My Goals | Review Targets → Acknowledge → Acknowledge & Submit (back to manager). Or Request Change → Return for Change → Submit Request (manager revises). After a mid-year revision: Acknowledge Revised Target → revised target applied | My Goals |
| Progress Update | Update Progress → Submit to Manager (manager sees it). Opens only after the HOD approves the goals | Progress |
| Self Appraisal | Self Appraisal → Submit (manager rates). Trainee / Probationary: Self Appraisal Closed | Self Appraisal |
| My Rating | Final Rating & Rating Sheet → Download Rating Sheet (PDF). Visible only after Corporate HR publishes | My Rating |
| Appraisal History | **Not drawn for this role** | — |

**Seed rows:** My Goals E, Progress E, Self Appraisal E, My Rating V.
**Not granted:** Appraisal History (not drawn; changed from earlier README, see D2).

---

### 6.4 Section Head / Reporting Manager  (example user: Ravi Teja K.)

Corporate Office Reporting Managers use this role too.
**Scope:** own team.

| Menu | Flow shown | Permission row |
|---|---|---|
| My Goals · Self Appraisal | His own goals. Same screens as Employee | My Goals, Self Appraisal |
| Team Goal Setting | My Team → Set Goals → Role Template (select employee) → Goal Setting / Target Assignment → Validate → Save & Send to Employee (employee reviews). Validate with errors → Validation Invalid → Fix. Goal Status & Send to HOD: Review & Revise returned goals → Send to Employee; Send to HOD (HOD approves). Report Transfer popup → Send to Plant HR (Plant HR records it). Set Period 2 KRAs for a transferred-in employee. My Team and Goal Status are two views of the same menu | Team Goals |
| Team Progress | Team Progress Dashboard. View only | Team Progress |
| Mid-Year Review | My Team → Open Review. Revision needed Yes → Raise Target Revision Request → Send to HOD for approval. Revision needed No → review complete | Mid Year Review |
| Team Appraisal | All Employees → Rate → Manager Rating – Submit to HOD. Transfer cases: current manager rates Period 2; previous manager rates Period 1 | Team Appraisal |
| Appraisal History | **Not drawn for this role** | — |

**Seed rows:** Team Goals E, Team Progress V, Mid Year Review E, Team Appraisal E, My Goals E, Self Appraisal E.
**Not granted:** Appraisal History (not drawn, see D2), Progress, My Rating.

---

### 6.5 HOD / Functional Head  (example user: K. Venkata Ramana)

Corporate Office Functional Heads use this role too.
**Scope:** own department (Corporate Office: his direct reports).

| Menu | Flow shown | Permission row |
|---|---|---|
| My Goals · Self Appraisal | His own goals. Same as Employee; approved by the Plant Head | My Goals, Self Appraisal |
| Team Goal Setting (two tabs: My Team – Goals, Goal Approvals) | **My Team:** Set Goals, using the same goal-setting screens as the Section Head (for his Section Heads). **Goal Approvals:** Review → Review & Approve Goals → Approve (goals frozen, progress tracking opens) or Return for Target Revision (back to manager). Review Revision → Approve / Return Revision → Approve (employee acknowledges) or Return (back to manager) | Team Goals, Goal Approval, Target Revision |
| Team Progress · Mid-Year Review | Same as Section Head, for his direct reports | Team Progress, Mid Year Review |
| Team Appraisal | Team Appraisal – Review Assessment → Review & Rate → HOD Rating & Recommendations → Submit → Send to Plant HR (Plant HR rates the HR competencies). Corporate Office: goes to Corporate HR | Appraisal Review (see D3) |
| Appraisal History | **Not drawn for this role** | — |

**Seed rows:** Team Goals E, Goal Approval E, Target Revision E, Team Progress V, Mid Year Review E, Appraisal Review E, My Goals E, Self Appraisal E.
**Not granted:** Appraisal History (not drawn, see D2), Progress, My Rating.

**Open:** D3.

---

### 6.6 Plant HR  (example user: Sunitha Rao)

**Scope:** own plant.

| Menu | Flow shown | Permission row |
|---|---|---|
| Own menus (My Goals … Team Appraisal) | Same as Section Head / Employee for her own goals and team. Not drawn separately (the map shows "…", so the full list is assumed to equal the Section Head set, see D6) | My Goals, Self Appraisal, Team Goals, Team Progress, Mid Year Review, Team Appraisal |
| Transfers | Manager's report → Record Transfer (Department / Manager Change) → Record Transfer. Old goals frozen as period 1; new manager sets period 2 | Transfers (extra row) |
| HR Competency Rating | HR Competency Rating – All Employees → Rate → Employee → Submit HR Ratings → Send Rated to Plant Head (Plant Head verifies). No Return, ratings only move forward | HR Competency Rating (extra row) |
| Appraisal History | Appraisal History – My Plant → View → Employee Appraisal → Download (PDF). Her plant only | Appraisal History |

**Seed rows (default):** Team Goals E, Team Progress V, Mid Year Review E, Team Appraisal E, My Goals E, Self Appraisal E, Appraisal History V.
**With extras flag:** HR Competency Rating E, Transfers E.

**Do not** grant Appraisal Review as a workaround for HR Competency Rating. That would also give her the HOD's rating and approval rights.
Without the extra rows, Plant HR cannot rate HR competencies or record transfers.

---

### 6.7 Plant Head  (example user: Rajesh Varma)

**Scope:** own plant.

| Menu | Flow shown | Permission row |
|---|---|---|
| My Goals · Self Appraisal · Team Progress · Mid-Year Review · Team Appraisal | Same as Employee / Section Head. Not drawn separately | My Goals, Self Appraisal, Team Progress, Mid Year Review, Team Appraisal |
| Team Goal Setting | My Team → Set Goals (same goal-setting screens, for his HODs). Goal Approvals → Review & Approve Goals → Approve / Return to HOD. Review Revision → Approve / Return Revision → Approve (employee acknowledges). Approves goal sheets and revisions that HODs send for their own direct reports | Team Goals, Goal Approval, Target Revision |
| Verification | Verification – All Employees → View → Verification – Employee → Verify & Send to Corporate HR (goes to Calibration). Or Verify & Send Selected. **No Return** | Verification (extra row) |
| Appraisal History | Appraisal History – My Plant → View → Employee Appraisal (view & download). His plant only | Appraisal History |
| (open) Who approves the HODs' own goals? | **Not decided. GP has no approval screen** | — (D5) |

**Seed rows (default):** Team Goals E, Goal Approval E, Target Revision E, Team Progress V, Mid Year Review E, Team Appraisal E, My Goals E, Self Appraisal E, Appraisal History V.
**With extras flag:** Verification E.

**Do not** grant Appraisal Review to Plant Head. Without the Verification row he cannot verify and send to Corporate HR.

---

## 7. Extra permission rows (default: SKIP)

Adding rows changes the existing permission list, so **do not add them by default.**

- Without the flag: seed section 6 "Seed rows (default)" only. Report what is therefore uncovered: Corporate HR cannot rate HR competencies for Corporate Office and has no Audit Trail or Version History right; Plant HR cannot rate HR competencies or record transfers; Plant Head cannot verify; GP has no dashboard row.
- With `--with-extra-permissions` **and only after the user approves**: add the six rows (HR Competency Rating, Verification, Transfers, Audit Trail, Version History, Appraisal Dashboard) to Performance Management as **new rows at the end**. Do not change the order, names or IDs of the existing 21. Then grant them as in the section 5 table and the "With extras flag" lines in section 6.
- Do not map these onto existing rows.

---

## 8. Open decisions (confirm with the user; defaults are used meanwhile)

| # | Open point | Default used |
|---|---|---|
| D1 | GP "Configuration" shows the same screens as Corporate HR, including Add / Edit / Copy buttons. Should GP only view, or also change masters and templates? | **V** (least privilege). Change those five rows to A if GP must edit |
| D2 | Appraisal History is "not drawn" for Employee, Section Head and HOD, and is not in the GP menu | **Not granted.** Add V if they should see history. For GP, if the Appraisal Dashboard row is skipped, Appraisal History V is the nearest way to view and download an appraisal |
| D3 | The HOD sidebar item is called "Team Appraisal" but its screens (Review Assessment, HOD Rating & Recommendations) were mapped to **Appraisal Review** | Appraisal Review E only. Using the sidebar check from section 2 step 7: if the HOD still does not see "Team Appraisal", also tick **Team Appraisal E** for HOD and report it |
| D4 | Corporate HR: Goal Approvals has no screen, and her menu has no Team Goal Setting or Team Progress. So nobody is routed to approve or set goals for Functional Heads | **Goal Approval, Team Goals, Team Progress not granted.** Decide who approves Functional Heads' direct reports' goals, or remove the menu item |
| D5 | Who approves the Plant Head's own goals (and the HODs' own goals, per the open row)? GP has no approval screen | Nothing granted to GP |
| D6 | Plant HR menu shows "Own menus (My Goals … Team Appraisal)" with an ellipsis | Section Head set assumed |
| D7 | Version History is a popup inside Appraisal History | Separate extra row, skipped by default |
| D8 | Managers' own monthly Progress and My Rating are not in any manager menu | Not granted. Add Progress E / My Rating V if managers' own goals need progress and rating views |

---

## 9. What changed from the earlier READMEs

| Role | Change | Reason (final map) |
|---|---|---|
| Corporate HR | **+** Target Revision E, Mid Year Review E, Team Appraisal E | Target Revisions (Corporate Office) is drawn; her menu lists Mid-Year Review and Team Appraisal |
| GP | **−** Appraisal History V | Not in the GP menu; dashboard drill-down only |
| Employee | **−** Appraisal History V | Marked "Not drawn for this role" |
| Section Head | **−** Appraisal History V | Marked "Not drawn for this role" |
| HOD | **−** Appraisal History V; **+** Team Goals E, Team Progress V, Mid Year Review E | "Not drawn"; HOD sets goals for his Section Heads and has Team Progress and Mid-Year Review |
| Plant Head | **+** Goal Approval E, Target Revision E | He approves goal sheets and revisions that HODs send |
| Plant HR | no change | |

---

## 10. Deliverables for Claude Code

1. A seed script (or migration, matching the project) with `--dry-run` and `--with-extra-permissions`.
2. The dry-run output pasted in your reply.
3. After a real run, a verification script that prints, for each of the seven roles, every granted permission with its level.
4. A report: where roles and permissions are stored and how levels are encoded; the sidebar-to-row mapping (section 2 step 7); roles created, roles skipped and their differences; gaps left uncovered (section 7); how D1–D8 were applied; confirmation that no existing record or UI file was modified.

## 11. Verification checklist

- [ ] Row counts for existing modules, permission rows and roles are identical before and after (capture first).
- [ ] `git diff` shows only the new seed file(s). No UI, route or style change.
- [ ] A second run changes nothing.
- [ ] Each role's granted rows match section 6 exactly. Nothing extra.
- [ ] Create Role still shows the same six module cards and the same 21 rows (unless the extras flag was used with approval).
- [ ] Create Resource is not granted to any role.
- [ ] Appraisal Review is granted only to HOD. Plant HR and Plant Head do not have it.
- [ ] Sidebar check done for HOD "Team Appraisal" (D3).

## 12. Assumptions

- Level meanings in section 3 are assumptions; the screen does not define them.
- Sidebar items map to permission rows as in section 6 (for example Calibration → Rating Normalization). Confirm in discovery.
- The sample screens contain mock data. This file reflects the **designed** menus and flow, not tested permission behaviour.
- Index sheet pages 1 (stage-wise) and 2 (MoM) were not shared and may change some assignments.