# Employee pages (screens 4.4 and 4.6)

My Goals review (4.1 - 4.3) and the revised-target view (4.5) are in
[`goal-setting/MyGoalsPage.tsx`](../goal-setting/README.md).

> **Static data:** the progress and self-appraisal **reads** have no endpoint in PMS_Java yet, so these two
> pages answer from `store/api/mocks/pmsEmployeeMock.ts` unless `VITE_PMS_STATIC_DATA=false`; then the
> read calls fail (404) until the backend adds them. The save calls exist.

## MyProgressPage.tsx - 4.4 "My Goals - Update Progress"

| | |
|---|---|
| Route | `/pms/my-progress/:fy` |
| Data | `useGetPmsMyProgressQuery`, `useSavePmsMyProgressMutation` (PUT `/pms-progress/update/my-progress`) |
| Shows | Per KRA: target and unit, **actual (YTD)**, **status** (On Track / At Risk / Off Track), evidence upload; comments |
| Actions | **Save Draft**, **Submit to Manager** (freezes the period; "Frozen" shows at the top) |
| Validation | Actual numeric and not negative; on submit every KRA needs an actual and a status; comments up to 500 |
| Notes | The evidence control keeps only the file name (`shared/EvidenceUpload.tsx`). |

## SelfAppraisalPage.tsx - 4.6 "Self Appraisal - FY ..."

| | |
|---|---|
| Route | `/pms/self-appraisal/:fy` |
| Data | `useGetPmsMySelfAppraisalQuery`, `useSavePmsMySelfAppraisalMutation` (PUT `/pms-appraisal/update/self-appraisal`) |
| Shows | KRA table: target, units, **actual**, **self rating** 1-5, achievement / evidence text, attachment; **competencies** with an HR or Manager tag, self rating and comment |
| Actions | **Save Draft**, **Submit Self Appraisal** (then read-only, "Submitted") |
| Validation | Text up to 300 characters; on submit every KRA and competency is rated |
| Notes | The save call has no field for the achievement text or competency comments yet; the page sends them and the API ignores them. Employees under the minimum service for the appraisal see goals but their self appraisal stays closed (rule from the cycle's Applicability step). |
