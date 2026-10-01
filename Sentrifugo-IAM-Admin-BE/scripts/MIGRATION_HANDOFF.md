# Sagarsoft Data Migration — Handoff / Continuation Doc

**Give this file to Claude Code on another machine to continue the work.** It captures the
goal, environment, every decision, the live DB state, gotchas, and next steps. (It is a
structured summary of a long working session, not a raw transcript.)

> ⚠️ All of this depends on a **local environment** (local MongoDB + local repos). It cannot
> run on Claude web (cloud) — it needs the local DBs and the `D:\Sentrifugo\…` repos.

---

## 1. Goal
Migrate the **Sagarsoft** organisation from an old HR system into the new Sentrifugo platform
(multi-microservice, MongoDB). Done so far: org structure + employees (IAM), holidays + plans +
work calendar (Leave/LMS). **Leave allocation (types/plans/balances) is NOT done yet** — see §7.

## 2. Environment (all LOCAL)
- **IAM repo (run scripts from here):** `D:\Sentrifugo\Sentrifugo-IAM-Admin-BE` (FastAPI + Beanie/Mongo)
- **Leave service repo:** `D:\Sentrifugo\sentrifugo-leave-management-be` (LMS — separate microservice, own Mongo DB)
- **FE:** `D:\Sentrifugo\Sentrifugo-FE` (tenant app: holidays/leave/work-calendar), `D:\Sentrifugo\Sentrifugo-Admin-FE`
- **MongoDB** (one cluster, many DBs): `sentrifugo_iam`, `sentrifugo_lms` (+ `sentrifugo_srm`, `sentrifugo_tsm`, `sentrifugo_payroll`, `schedule_service_db`, …)
- **Source files** in `D:\Data for the Sentrifugo\`:
  - `employees_data_with_holiday_group_export.2026-06-26 (1).xlsx` — employees + Department + L2 manager + **HolidayGroup** (latest, 745 rows; used by holiday/work-calendar scripts)
  - `employees_data_export.2026-06-26 new with the dept.csv` — employee CSV used by the committed IAM run (745 rows)
  - `holiday_export.2026-06-25.csv` — holidays (456 rows: `HolidayName, DATE, holidayyear, DESCRIPTION, GroupName`)
- **Org:** "Sagarsoft (India) Limited", `org_id = 6a3e05a5c0470e0bdd9ce9a9`, org admin `pavan.somepalli+sagarsoft@sagarsoft.in` (user `_id 6a3e05a5c0470e0bdd9ce9aa`)
- **Running scripts:** `cd D:\Sentrifugo\Sentrifugo-IAM-Admin-BE` then `PYTHONIOENCODING=utf-8 python -m scripts.<name>` (the env var avoids Windows cp1252 errors on box-drawing chars).

## 3. Scripts built (all in `Sentrifugo-IAM-Admin-BE/scripts/`)
| Script | What it does | Flags |
|---|---|---|
| `migrate_all.py` | **Orchestrator** — runs IAM → LMS sync → holidays in order | `--commit` / `--revert` / (none = dry run) |
| `migrate_employees_active.py` | IAM engine: org/BUs/depts/designations/employees in `sentrifugo_iam`; writes reports + clean CSV | `--commit` `--revert` `--emit-events` |
| `migrate_employees_activation.py` | Same, but active employees created PENDING + activation email via outbox→RabbitMQ→schedule service | `--commit` `--revert` |
| `sync_org_to_lms.py` | Dev bridge: copy org/BUs/depts/employees/employment-statuses `sentrifugo_iam` → `sentrifugo_lms` | `--commit` `--revert` |
| `lms_holidays.py` | Classification + holiday plans + holidays + assignments in LMS | `--commit` `--revert` |
| `lms_work_calendar.py` | 1 work calendar + 1 shift + assign all active employees | `--commit` `--revert` |

Outputs (on commit): `scripts/sagarsoft_import_report.{md,csv}`, `scripts/sagarsoft_employees_clean.csv`, `scripts/holiday_import_report.md`.

## 4. Decisions baked into the scripts (the rules)

### Employees (IAM)
- Two BUs: **Sagarsoft** (prefix `SIL`), **Sapplica** (prefix `SIT`). `SIT-*` → Sapplica; everything else → Sagarsoft; `SSI-0110` → Sagarsoft `SIL-0110`.
- **emp_code = exact number from the sheet**: full-time `SIL-<num>` (no `-F-`), contract `SIL-C-<num>`. (Gaps OK.)
- **Code change in the IAM app:** `src/modules/organisation/employees/utils/tools.py::_generate_emp_code` now omits `-F-` for full-time (`PREFIX-NUMBER`); contract/intern keep `-C-`/`-I-`. Mirrored in `seed_employees.py`/`seed_org_full.py`. Added `Direct Contract` + `Third Party Contract` to `src/master_data/data/employment_statuses.json`.
- employment_type: Permanent/Probation/blank → full-time; Direct/Third Party Contract → contract.
- employment_status: active → from type (permanent/probation/direct-contract/third-party-contract); **LEFT → Exit**.
- **Active rule:** `EmployeeStatus==1 AND no DateOfLeaving` → ACTIVE + password `test@123`. Else → EXIT, no password, `date_of_exit = DateOfLeaving`.
- `admin` + `SIL-01` → **org-admin users** (is_org_admin, ACTIVE/test@123), NOT employees.
- Skipped junk: `1234`, `SIL-099999`, `BGCK273`.
- **Duplicate emails:** keep BOTH records; the older/inactive one gets a `+<empid>` tagged email (email is globally unique). 11 pairs; winners hardcoded in `DUP_WINNERS`. `SIL-1009` (sethunarayanan.valaparambil@) collided with a pre-existing DB super-admin — the user moved that super-admin to `sysadmin@sagarsoft.in`, freeing the email; SIL-1009 now uses its real email.
- 199 designations (verbatim). 12 departments (from `Department` col, `&`→`and`), each mapped to the BU(s) its employees fall in; each employee → its department.
- **Robust date parsing** (`dateutil`, any format incl. Excel datetime cells) on every date column.
- **Result:** 740 employees (Sagarsoft 726 / Sapplica 14; **188 active, 552 left**), 2 BUs, 12 depts, 199 designations, 2 org admins.

### Cross-service sync (IAM → other services)
- **Production = RabbitMQ domain events** (`business_unit.created` / `department.created` / `employee.created`) consumed by each service's `domain_events_consumer`. `migrate_employees_active.py --emit-events` publishes these via the IAM outbox (the live relay delivers them).
- **In THIS local env the events were published but NOT delivered to the LMS** (broker binding/topology issue — verified: none of ours in LMS `processed_domain_events`). So we used `sync_org_to_lms.py` as a **deterministic dev fallback** (direct cross-DB writes into `sentrifugo_lms`, mirroring the consumer's exact doc shapes, keyed by IAM `_id`). Prod should rely on events.

### Holidays (LMS)
- **1 plan per (GroupName, Year)** → 45 plans (e.g. "RPO 2026"), all years 2018–2026.
- Plan BU/dept scope **derived from each group's active full-time members** (memberless client groups → all BUs+depts).
- **1 classification "Holiday"**; all 456 holidays use it. `holidays.date` stored as **ISO string** ("YYYY-MM-DD").
- **Assignment** (`holiday_plan_employees`, key = plan_id+user_id): **ACTIVE + FULL-TIME + has a HolidayGroup** → that group's plan for EVERY year. **Contractors EXCLUDED**, inactive excluded, blank-group excluded.
- **Result:** 1 classification, 45 plans, 456 holidays, ~1482 assignments (167 assignable). Source verified clean (0 dups, 0 year-mismatches, 0 blanks).

### Work calendar (LMS)
- 1 calendar "General Work Calendar" (2018-01-01..2030-12-31, **default**, company-wide).
- **`weekend_matrix = [1,1,1,1,1,0,0]` per week → `1`=WORKING, `0`=off** (Mon–Fri work, Sat/Sun off). ⚠️ The schema's code comment says "0=full day" but that is **WRONG**; the resolver + real FE calendars use `1`=working (we initially inverted this and fixed it).
- 1 shift "Morning Shift" 09:30–18:30, 60-min break. Shift `_id` = string UUID; `calendar_id` stored as a string.
- Assigned calendar + shift to all **188 active employees** (`work_calendar_employees` + `work_calendar_shift_assignments`).

## 5. LMS stored doc shapes (for direct inserts — mirror the consumers/services)
- `business_units`: `{_id, name, org_id(oid), currency, time_zone, is_subsidiary, is_active, head_user_id, is_deleted}`
- `departments`: `{_id, name, org_id, business_unit_id(primary), business_unit_ids[], is_active, department_head, department_code, is_deleted}`
- `employees`: `{_id, user_id, organisation_id, emp_code, work_email, name, first_name, last_name, l1_manager_id, l2_manager_id, designation_id, department_id, business_unit_id, employment_status, employment_type, project_status, date_of_joining, is_deleted}`
- `employment_statuses`: `{_id, key, value, is_active}` (global; we added direct-contract + third-party-contract)
- `holiday_classifications`: `{_id, org_id, name, color, +audit}`
- `holiday_plans`: `{_id, name, year, business_unit_ids(oid[]), department_ids(oid[]), reminder_settings{enabled,days_before}, notify_employees, reprocess_leaves, org_id, is_active, +audit}`
- `holidays`: `{_id, name, date(ISO str), reminder{enabled,days_before}, description, classification_id, business_unit_ids(oid[]), applicable_department_ids(oid[]), plan_id, org_id, +audit}`
- `holiday_plan_employees`: `{_id, plan_id, org_id, user_id, +audit}`
- `work_calendars`: `{_id, org_id, name, year_type, start_date(ISO str), end_date(ISO str), is_active, is_default, business_unit_ids(oid[]), department_ids(oid[]), week_config{...}, weekend_matrix{"1".."5":[7 ints]}, statutory_config, +audit}`
- `work_calendar_shifts`: `{_id(STR uuid), calendar_id(STR), name, start_time, end_time, break_minutes, org_id, +audit}`
- `work_calendar_employees`: `{_id, work_calendar_id(oid), org_id, user_id, +audit}`
- `work_calendar_shift_assignments`: `{_id, calendar_id(oid), org_id, user_id, shift_id(STR), +audit}`
- `audit_fields_create` = `{created_on, created_by(oid), updated_on:None, updated_by:None, deleted_on:None, deleted_by:None, correlation_id(uuid)}`. Our scripts also add `import_batch=<marker>` to every doc for clean `--revert`.

## 6. Current LIVE state (verified)
- **IAM (`sentrifugo_iam`):** org active (setup_status=active, multi-BU), 2 BUs, 12 depts, 199 designations, 740 employees, 2 org admins. `setup_progress` set so data shows in the app.
- **LMS (`sentrifugo_lms`):** org + 2 BUs + 12 depts + 740 employees synced; 1 classification, 45 plans, 456 holidays, 1482 holiday assignments; 1 work calendar, 1 shift, 188+188 calendar/shift assignments; Direct/Third Party Contract statuses added (so all 188 active recognized as active).

## 7. NOT done yet (the next big piece)
**Leave allocation is entirely missing for our org** (all 0): `leave_types`, `leave_plans`, `leave_plan_assignments`, `leave_entitlement_configurations`, `employee_leave_balances`, ledgers, grant/approval/sandwich policies.
→ The **leave balance processor, year-end processing, and escalation crons have nothing to process** for these employees; **employees can't apply for leave yet**. (Holiday-reminder cron + working-day resolution DO work.)
→ **Next:** set up leave types → leave plan(s) → entitlement configs → assign employees → seed initial balances (build the same dry-run→commit way, or via the FE leave-configuration screens). Read shapes from `sentrifugo-leave-management-be/src/leave_types`, `leave_plans`, `leave_entitlements`, `leave_balance_processor`.

Other small gaps:
- Designations NOT synced to the LMS (employee.designation_id dangling there). Easy to add to `sync_org_to_lms.py`.
- Event delivery to LMS doesn't work in this local env (broker topology) — using the direct sync fallback.

## 8. Known FE limitations (for the FE team — NOT migration bugs)
- **Holiday-plan assignment picker** (`AddEmployeesToPlan.tsx`): max **50** results + search/filters, **no load-more pagination**. For 1000+ orgs you must search/filter. (BE employee endpoint supports `limit`+`skip`, so pagination is wire-able.)
- **Work-calendar assignment**: pages employees in 100-batches up to a **10,000 ceiling** (handles 1000s; truncates beyond 10k). The "188 of 100" seen in the UI was the 100 **batch size**, not a cap — all 188 were assigned.
- **Leave-management list**: paginates properly.

## 9. How to run / revert
```
cd D:\Sentrifugo\Sentrifugo-IAM-Admin-BE
PYTHONIOENCODING=utf-8 python -m scripts.migrate_all              # dry-run all
PYTHONIOENCODING=utf-8 python -m scripts.migrate_all --commit     # full migration
PYTHONIOENCODING=utf-8 python -m scripts.migrate_all --revert     # undo all (reverse order)
# Holidays + work calendar (LMS) are run separately:
PYTHONIOENCODING=utf-8 python -m scripts.lms_holidays --commit
PYTHONIOENCODING=utf-8 python -m scripts.lms_work_calendar --commit
```
Each script is idempotent and supports `--revert` (tagged by `import_batch`). The IAM migration cleans by `created_by="import_sagarsoft"`.

## 10. Suggested next steps
1. **Build the leave configuration** (types/plans/entitlements/balances) so the leave lifecycle + crons + year-end work for these employees.
2. Sync **designations** to the LMS.
3. (Prod) fix RabbitMQ event delivery to the LMS so the direct sync fallback isn't needed.
4. (FE) add pagination to the holiday-plan employee picker; revisit the 10k work-calendar ceiling.
