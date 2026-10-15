# Corporate HR pages (screens 1.7 - 1.9)

HR competency rating and calibration. All calls need the `rating_normalization` permission (the code
Corporate HR holds), so only that role gets data back.

```
Manager submits appraisal ─▶ HrCompetencyRatingPage (1.7) ─open─▶ HrCompetencyEmployeePage (1.8)
                                         │ tick rated employees, "Send Rated to Calibration"
                                         ▼
                                   CalibrationPage (1.9) ──"Approve & Publish Ratings"──▶ ratings published
```

## HrCompetencyRatingPage.tsx - 1.7 "HR Competency Rating"

| | |
|---|---|
| Route | `/pms/hr-competency-rating/:fy` |
| Data | `useGetPmsHrQueueQuery(financialYear)`, `useSendPmsToCalibrationMutation`, `usePmsDepartments()` |
| Shows | Employee and code, department, functional head, HOD rated on, HR rating status (Pending / Draft / Rated) |
| Filters | Department, status, search by name or code (all applied in the browser) |
| Actions | **Rate** / **Continue** / **View** opens 1.8; tick **rated** employees and **Send Rated to Calibration** |
| Notes | Only employees whose manager has submitted the appraisal appear. Employees already sent show "In calibration" and cannot be ticked again. |

## HrCompetencyEmployeePage.tsx - 1.8 "HR Competency Rating - <employee>"

| | |
|---|---|
| Route | `/pms/hr-competency-rating/:fy/employee/:employeeUserId` |
| Data | `useGetPmsHrAppraisalQuery`, `useSavePmsHrAppraisalMutation`, `useSubmitPmsHrAppraisalMutation` |
| Shows | Employee details strip; **HR competencies** to rate (self rating, HR rating 1-5, comment); **manager competencies** read-only (self, manager, HOD); HR remarks |
| Actions | **Save Draft** (ratings may be empty), **Submit HR Ratings** |
| Validation | `hr.schema.ts`: on submit every HR competency has a rating; comments up to 300 characters; remarks up to 500 |
| Notes | Read-only once the employee has been sent to calibration. |

## CalibrationPage.tsx - 1.9 "Calibration & Normalization"

| | |
|---|---|
| Route | `/pms/calibration/:fy` |
| Data | `useGetPmsCalibrationQuery`, `useSavePmsCalibrationMutation`, `usePublishPmsCalibrationMutation` |
| Shows | **Rating distribution** per level: current %, guideline %, and an editable **HR normalization %** with a running total; **Employee ratings**: manager, HOD, HR competency average, calibrated rating, reason |
| Actions | **Save**; **Approve & Publish Ratings** (disabled until HR targets total 100%) |
| Validation | HR % are whole numbers 0-100; a calibrated rating that differs from the rating before calibration needs a reason of 5+ characters; every employee needs a rating |
| Notes | A warning shows how far the total is from 100%. After publishing the page is read-only. The "current rating" is the HOD rating, else the manager's recommendation. The distribution covers the whole organisation for the year (no plant filter). |

## Schema file

`hr.schema.ts`: `hrAppraisalSchema`, `draftHrAppraisalSchema`, `calibrationEmployeeSchema`, `calibrationSchema`,
`draftCalibrationSchema`.
