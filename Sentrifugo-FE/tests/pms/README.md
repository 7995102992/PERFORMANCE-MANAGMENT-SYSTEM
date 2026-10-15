# PMS end-to-end tests (Playwright)

101 test cases for the Performance Management module. IDs: `P` = positive flow, `N` = negative flow.

Last full run (against DEV): **93 passed, 7 skipped (no data / gated), 1 flaky login that passed on re-run.**

| File | Covers | Cases |
|---|---|---|
| `hr.spec.ts` | Corporate HR: cycle list, step 1 validation, configuration masters | 17 |
| `wizard.spec.ts` | Corporate HR: all four steps of the Initiate Appraisal wizard | 27 |
| `manager.spec.ts` | Manager: My Team, Select Employee, Target Assignment, validation, draft | 17 |
| `employee.spec.ts` | Employee: My Goals, request change, acknowledge, self appraisal | 11 |
| `hod.spec.ts` | HOD: Goal Approvals, review, return rules | 8 |
| `menu-and-screens.spec.ts` | Side menu per role, other screens open, stage-window banners | 19 |
| `lifecycle.spec.ts` | Flows that change shared data (off by default) | 2 |
| | **Total** | **101** |

## How to run

From the `Sentrifugo-FE` folder (not the repo root):

```
npx playwright test tests/pms                  # all, headless
npx playwright test tests/pms --headed         # watch in the browser
npx playwright test tests/pms/wizard.spec.ts   # one file
npx playwright test tests/pms -g "WIZ-N"       # by ID prefix
npm run test:e2e:report                        # HTML report
```

To run the flows that change data (they notify users and write to the DB):

```
E2E_PMS_SEND=1 npx playwright test tests/pms/lifecycle.spec.ts      # manager sends a sheet
E2E_PMS_PUBLISH=1 npx playwright test tests/pms/lifecycle.spec.ts   # HR publishes a cycle
```

Requirements:

- PMS backend (port 8080) and IAM running. The backend allows the origins in `pms.cors.allowed-origins` (5173 and 5174).
- Logins in `.env` (gitignored): `E2E_PMS_<ROLE>_EMAIL` / `_PASSWORD` for `HR`, `MANAGER`, `MANAGER2`, `MANAGER3`, `EMPLOYEE`, `HOD`. Optional `E2E_PMS_FY` (default `2026`), `E2E_BASE_URL`.
- Tests run one at a time against the shared stack.

A test marked **needs data** skips itself (it is not a failure) when the login has no suitable record.

## Logins used

| Key | User | Used for |
|---|---|---|
| HR | pms.corporate.hr@sagarsoft.com | Cycle wizard, masters |
| MANAGER | sureshbabu.baisani | Read-only sheet (report already approved) |
| MANAGER2 | ananth.seetharamaiah | Editable sheet (report is Not Started) |
| MANAGER3 | venkatakrishnareddy.vaddi | Manager menu and screens |
| EMPLOYEE | bhagath.jadigam | My Goals, self appraisal |
| HOD | venkatapati.uddaraju | Goal approvals |

## Corporate HR: cycle list and masters (`hr.spec.ts`)

| ID | Type | What it checks |
|---|---|---|
| HR-P01 | P | PMS Cycle list loads with the Initiate button, no 5xx |
| HR-P02 | P | Wizard opens on Basic Details, empty name, dates not auto-filled |
| HR-P03 | P | Typing a cycle name clears its required error |
| HR-P04 | P | Cancel returns to the cycle list |
| HR-P05 to P08 | P | KRA Master, KPI Master, Goal Templates, Rating Scale load without 5xx |
| HR-P09 | P | KRA Master: add a KRA and see it in the list |
| HR-P10 | P | Competency Master and Approval Workflow load |
| HR-N01 | N | Next on an empty step 1 is blocked |
| HR-N02 | N | Cycle name over 120 characters rejected |
| HR-N03 | N | Description over 500 characters rejected |
| HR-N04 | N | KRA name empty: "KRA is required" |
| HR-N05 | N | KRA name over 100 characters rejected |
| HR-N06 | N | KRA dialog Cancel adds nothing |
| HR-N07 | N | Duplicate KRA name refused, dialog stays open |

## Corporate HR: wizard (`wizard.spec.ts`), nothing is saved or published

| ID | Type | What it checks |
|---|---|---|
| WIZ-P01 | P | Valid name and period move to the timeline |
| WIZ-N01 | N | Past dates are disabled in the start picker |
| WIZ-N02 | N | Days before the start are disabled in the end picker |
| WIZ-N03 | N | Period over 12 months rejected |
| WIZ-N04 | N | End date required |
| WIZ-P02 | P | Timeline lists the 9 stages with a notify switch each |
| WIZ-P03 | P | Stage dates start empty |
| WIZ-P04 | P | A valid, non-overlapping timeline moves to Applicability |
| WIZ-P05 | P | A notify switch toggles |
| WIZ-N05 | N | Empty stage dates show "Required" |
| WIZ-N06 | N | L1 Rating starting inside Self Appraisal: overlap |
| WIZ-N07 | N | Self Appraisal starting before Goal Approval closes: overlap |
| WIZ-N08 | N | Acknowledgement starting before Goal Setting: rejected |
| WIZ-N09 | N | Stage end before its start is disabled |
| WIZ-N10 | N | Previous keeps the entered values |
| WIZ-P06 | P | All Plants and All Departments are valid |
| WIZ-P07 | P | Appraisal initiation date is shown read-only |
| WIZ-N11 | N | No plant: "Select at least one plant" |
| WIZ-N12 | N | Select Departments with none: "Select at least one department" |
| WIZ-N13 | N | Minimum service below 0: "Cannot be negative" |
| WIZ-N14 | N | Minimum service above 600: "Too large" |
| WIZ-N15 | N | Minimum service 1.5: "Whole months only" |
| WIZ-N16 | N | No employment type: "Select at least one employment type" |
| WIZ-P08 | P | Final step lists the five notification choices and Publish |
| WIZ-P09 | P | Choosing a rating scale shows its levels |
| WIZ-N17 | N | Publish without a rating scale is blocked, no cycle created |
| WIZ-N18 | N | Cancel from the last step saves nothing |

## Manager (`manager.spec.ts`)

Read-only report (Suresh): MGR-P01 to P04, MGR-N06, MGR-N07. Editable report (Ananth, Not Started):

| ID | Type | What it checks |
|---|---|---|
| MGR-P01 | P | My Team loads |
| MGR-P02 | P | Select Employee: role, auto template, Assign Template, banner, columns, summary |
| MGR-P03 | P | Breadcrumb |
| MGR-P04 | P | Back returns to My Team |
| MGR-P05 | P | Sheet: header strip, KRA-only rows, Total weightage, Save Draft, Validate |
| MGR-P06 | P | Valid weights total 100% |
| MGR-P07 | P | Save Draft survives a reload |
| MGR-P08 | P | Validate on a valid sheet opens "Save and Send to Employee"; Cancel sends nothing |
| MGR-P09 | P | Previous-year targets panel or its empty message |
| MGR-N01 | N | Blank weights: Validation failed, no Save & Send |
| MGR-N02 | N | Weights not totalling 100: "must be 100%" |
| MGR-N03 | N | Weight above 100 rejected |
| MGR-N04 | N | Non-numeric target rejected |
| MGR-N05 | N | Missing target reported |
| MGR-N06 | N | Sent or approved sheet is read-only |
| MGR-N07 | N | No HR Initiate Appraisal entry |
| MGR-N08 | N | Validate Again shows the failure until fixed |

## Employee (`employee.spec.ts`), needs data: a sheet Sent to Employee

| ID | Type | What it checks | Needs data |
|---|---|---|---|
| EMP-P01 | P | My Goals loads, no 5xx | |
| EMP-P02 | P | Table or "manager has not set goals" | |
| EMP-P03 | P | Request Change dialog fields | yes |
| EMP-P04 | P | Acknowledge dialog opens and Cancel closes | yes |
| EMP-P05 | P | Self Appraisal loads | |
| EMP-N01 | N | Request without reason refused | yes |
| EMP-N02 | N | Non-numeric proposed target refused | yes |
| EMP-N03 | N | Negative proposed target refused | yes |
| EMP-N04 | N | Acknowledge & Submit disabled until ticked | yes |
| EMP-N05 | N | No HR, HOD or team menu entries | |
| EMP-N06 | N | Approvals URL shows nothing to review | |

## HOD (`hod.spec.ts`), nothing approves or returns for real

| ID | Type | What it checks | Needs data |
|---|---|---|---|
| HOD-P01 | P | Goal Approvals loads with toolbar | |
| HOD-P02 | P | List columns | |
| HOD-P03 | P | Approval History opens | |
| HOD-P04 | P | Review shows Return and Approve | yes |
| HOD-N01 | N | Approve Selected disabled until ticked | |
| HOD-N02 | N | Return without remarks refused | yes |
| HOD-N03 | N | Remarks capped at 500 | yes |
| HOD-N04 | N | Cancel leaves sheet pending | yes |

## Menu, screens, banners (`menu-and-screens.spec.ts`)

| ID | What it checks |
|---|---|
| MENU-01 to 04 | PMS side menu per login (employee, manager, HOD, HR) has the right entries and none it must not |
| MENU-05 | HR sees the Configuration masters |
| SCR-01 to 12 | My Progress, Team Progress, Mid-Year Review, Team Appraisal, Target Revisions, Approve Appraisal, Goal Approvals, HR Competency Rating, Calibration, Status Tracker, Appraisal History, Cycle Closure open without 5xx |
| BAN-01 / 02 | Employee Acknowledgement and HOD Approval stage-window banners |

## Gated lifecycle (`lifecycle.spec.ts`), off by default

| ID | Gate | What it does |
|---|---|---|
| LIFE-01 | `E2E_PMS_SEND=1` | Manager assigns the template, fills a valid sheet, validates, sends; status becomes Sent to Employee |
| LIFE-02 | `E2E_PMS_PUBLISH=1` | HR fills all four wizard steps and publishes; Activated page and list show the cycle |

## Not covered yet

- Employee acknowledge/request-change submit, manager revise after change request, HOD approve/return, revised-target acknowledgement: the DEV timeline windows (Acknowledgement opens 01-Dec-2026, HOD approval 01-Jan-2027) block them until the dates are reached or the cycle dates are changed.
- Progress Update submit, Self Appraisal submit, Mid-Year Review, Team Appraisal, My Rating.
- Bell notification delivery after publish.
- API-level permission checks (one role calling another role's endpoint).

## Helpers

- `helpers.ts`: `login`, `openPms`, `failOnServerErrors`, `FY`.
- `wizard.helpers.ts`: `pickDate`, `fillBasics`, `fillTimeline`, `fillApplicability`, `next`, `isoIn`.
