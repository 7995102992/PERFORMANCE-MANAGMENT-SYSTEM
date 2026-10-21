# Mid-year review pages (screens 3.10 - 3.12)

Manager flow, half-way through the year (permission `mid_year_review`).

```
MidYearTeamPage (3.10) ──open──▶ MidYearReviewPage (3.11) ──"revision required: yes"──▶ TargetRevisionRequestPage (3.12)
                                          └─ "no" → review completed
```

## MidYearTeamPage.tsx - 3.10 "Mid-Year Review - My Team"

| | |
|---|---|
| Route | `/pms/mid-year-review/:fy` |
| Data | `useGetPmsMidYearTeamQuery(financialYear)` (GET `/pms-mid-year/get/team`) |
| Shows | Employee, role, H1 achievement %, RAG dot, review status (`not_started`, `completed_no_revision`, `revision_requested`, `completed_with_revision`) |
| Actions | **Open Review** (not started) or **View** (done) opens 3.11 |

## MidYearReviewPage.tsx - 3.11 "Mid-Year Review"

| | |
|---|---|
| Route | `/pms/mid-year-review/:fy/employee/:employeeUserId` |
| Data | `useGetPmsMidYearReviewQuery`, `useSubmitPmsMidYearReviewMutation` |
| Shows | KRAs with target, unit, H1 actual and RAG; discussion notes; "Target revision required?" Yes / No |
| Actions | **Continue**: "No" completes the review; "Yes" saves it and opens 3.12 |
| Validation | `midYear.schema.ts`: a choice is required; notes up to 1000 characters and **10+ characters when a revision is requested** |
| Notes | Once the review is closed it is shown read-only. |

## TargetRevisionRequestPage.tsx - 3.12 "Target Revision Request"

| | |
|---|---|
| Route | `/pms/mid-year-review/:fy/employee/:employeeUserId/revision` |
| Data | `useGetPmsRevisionRequestQuery`, `useSubmitPmsRevisionRequestMutation` |
| Shows | Every KRA with its locked weight and current target; revised target and reason per row; an optional attachment |
| Actions | **Send to HOD** (only the changed rows are sent); **Back** to 3.11 |
| Validation | Revised target numeric and not negative; a changed target needs a reason of 5+ characters; at least one target must change; attachment PDF / Excel / PNG / JPEG up to 5 MB |
| Notes | Only the file **name** is kept (file storage is not connected). HOD approval happens on the shared goal-approvals queue (`src/pages/pms/goal-setting/hod`, `request_type: target_revision`) — an approved revision's targets apply immediately, with no separate employee acknowledgement step. |

## Schema file

`midYear.schema.ts`: `midYearReviewSchema`, `revisionRowSchema`, `revisionSchema`, `MAX_ATTACHMENT_BYTES`,
`ATTACHMENT_TYPES`.
