# Sagarsoft — Leave HISTORY migration report

- Generated: 2026-08-03 16:44:11  (mode: **COMMIT**)
- Target DB: `sentrifugo_lms`  ·  org_id: `6a481cbeefd9f278b3708209`  ·  import_batch: `import_sagarsoft_leave_history_2026`
- Source: legacy leave-history export

## What this does
Imports the legacy leave/attendance applications into `leave_requests` (for viewing). Each record
is attached to a leave type that **already exists** in the org — no leave type is created, edited
or deleted, and `--revert` removes only the imported requests. Records carry `leave_plan_id = null`
(no plan yet) and are written by **direct insert**, so the seeded balances are NOT touched.

## 1. Summary

| Item | Count |
|---|---|
| Source rows | 55900 |
| **Imported** (leave_requests) | **55717** |
| **Skipped** (could not handle) | **183** |
| Legacy types matched to an existing type | 21 |
| **Legacy types MISSING in the org** | **0** |

## 2. Leave-type mapping  (legacy name → existing type)

| Legacy type | Existing type used | Code | Active | Records imported |
|---|---|---|---|---|
| Earned Leave | Earned Leave | EARNED_LEAVE | yes | 14755 |
| Compensatory Days | Compensatory Days | COMPENSATORY_DAYS | yes | 1375 |
| Loss Of Pay | Loss of Pay | LOSS_OF_PAY | yes | 995 |
| Work From Home | Work From Home | WORK_FROM_HOME | yes | 31159 |
| Wedding | Wedding Leave | WEDDING | yes | 80 |
| Paternity | Paternity Leave | PATERNITY | yes | 72 |
| Work from client location | Work from Customer Location | WORK_FROM_CLIENT_LOCATION | yes | 44 |
| Maternity Upto first 2 Kids | Maternity Leave =< 2 Kids | MATERNITY_UPTO_FIRST_2_KIDS | yes | 23 |
| Optional Holiday 1 | Optional Holiday 1 | OPTIONAL_HOLIDAY_1 | yes | 302 |
| Business Travel or Meeting | Business Travel/Meeting/ Official Work | BUSINESS_TRAVEL_OR_MEETING | yes | 82 |
| Official Work | Official Work | OFFICIAL_WORK | yes | 19 |
| Bereavement Leave | Bereavement Leave | BEREAVEMENT_LEAVE | yes | 43 |
| Forgot ID Card | Forgot ID Card | FORGOT_ID_CARD | yes | 37 |
| Weekly Off | Weekly Off | WEEKLY_OFF | yes | 9 |
| Garden Leave | Garden Leave | GARDEN_LEAVE | yes | 6568 |
| Optional Holiday 2 | Optional Holiday 2 | OPTIONAL_HOLIDAY_2 | yes | 3 |
| MTP | Miscarriage and Medical Termination of Pregnancy (MTP) Leave | MTP | yes | 1 |
| Maternity leave for 3rd kid onwards | Maternity Leave > 2 Kids | MATERNITY_LEAVE_FOR_3RD_KID_ONWARDS | yes | 1 |
| Wellness leave | Wellness Leave | WL | yes | 55 |
| Remote Work | Work From Home | WORK_FROM_HOME | yes | 57 |
| Hybrid Work - WFH | Work From Home | WORK_FROM_HOME | yes | 37 |

## 3. Status mapping  (legacy → new)

Approved → APPROVED · Cancel → CANCELLED · Pending for approval → PENDING · Rejected → REJECTED

| New status | Records |
|---|---|
| APPROVED | 51446 |
| PENDING | 2532 |
| CANCELLED | 1489 |
| REJECTED | 250 |

## 4. Skipped — records we could NOT import, and WHY  ⚠️

**183** records were not imported. Each code below states the exact reason.
Full per-row list in `sagarsoft_leave_history_skipped.csv`.

| Emp code | Records | Why not imported |
|---|---|---|
| SIT-0159 | 173 | employee deliberately SKIPPED at import — their SIL number already belongs to a different person (SIL-0158 Gopi Mora / SIL-0159 Vishwanth Gunna), so importing would credit the wrong account |
| (blank) | 8 | row has NO employee code — nobody to attach the record to |
| SIL-1026 | 2 | emp-code not in the employee export — this person was never migrated |

## 5. Reversibility
`python -m scripts.migrate_leave_history --revert` — deletes ONLY the `leave_requests` tagged
`import_sagarsoft_leave_history_2026`. Leave types are never created or deleted by this script.

## 6. Output files
- `scripts/sagarsoft_leave_history_clean.csv` — one row per imported leave record
- `scripts/sagarsoft_leave_history_skipped.csv` — records we could NOT handle, with the reason
- `scripts/leave_history_import_report.md` — this report