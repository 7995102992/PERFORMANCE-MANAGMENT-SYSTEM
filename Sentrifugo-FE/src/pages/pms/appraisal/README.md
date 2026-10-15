# Manager appraisal pages (screens 3.13 - 3.14)

Year-end flow for the reporting manager (permission `team_appraisal`). The employee self appraisal (4.6)
must be submitted first; after the manager submits, the appraisal goes to the HOD.

## TeamAppraisalPage.tsx - 3.13 "Team Appraisal"

| | |
|---|---|
| Route | `/pms/team-appraisal/:fy` |
| Data | `useGetPmsTeamAppraisalQuery(financialYear)` (GET `/pms-appraisal/get/team`) |
| Shows | Employee, role, self appraisal status (submitted / not submitted / not applicable) and score, and the manager rating status (`waiting`, `pending`, `draft`, `submitted_to_hod`) |
| Actions | Row button: **Rate** (pending), **Continue** (draft), **View** (submitted); none while waiting for the self appraisal |
| Notes | A blue banner names the employees who submitted a self appraisal and are waiting for your rating. |

## ManagerAppraisalPage.tsx - 3.14 "Manager Appraisal"

| | |
|---|---|
| Route | `/pms/team-appraisal/:fy/employee/:employeeUserId` |
| Data | `useGetPmsManagerAppraisalQuery`, `useSavePmsManagerAppraisalMutation`, `useSubmitPmsManagerAppraisalMutation` |
| Shows | KRA table (target, unit, actual, self rating, **manager rating**, attachment, comment); manager competencies (self rating, manager rating, comment); HR competencies for context (self rating only); average of the competency ratings; recommended rating; comments |
| Actions | **Save Draft** (ratings may be empty), **Submit to HOD** |
| Validation | `appraisal.schema.ts`: on submit every KRA and manager competency has a rating 1-5; a rating **two or more points from the self rating needs a comment of 5+ characters**; a recommended rating is required; comments up to 300 characters per row, 500 overall |
| Notes | The API returns 409 `PMS_SELF_APPRAISAL_PENDING` until the employee has submitted. Once submitted to the HOD the page is read-only. HR competencies are rated later by Corporate HR (screen 1.8). |

## Schema file

`appraisal.schema.ts`: `appraisalLineSchema`, `managerAppraisalSchema`, `draftAppraisalSchema`.
