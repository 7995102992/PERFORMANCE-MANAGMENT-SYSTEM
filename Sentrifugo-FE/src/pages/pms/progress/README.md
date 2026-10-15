# Team progress (screen 3.9)

## TeamProgressPage.tsx - 3.9 "Team Progress Dashboard"

| | |
|---|---|
| Route | `/pms/team-progress/:fy` |
| Who | Reporting manager (permission `team_progress`) |
| Data | `useGetPmsTeamProgressQuery(financialYear)` (GET `/pms-progress/get/team`) |
| Shows | Three tiles (employees on track / at risk / off track) and a row per employee: KRAs on track, KRAs needing attention (with RAG), achievement %, employee comment, overall status |
| Notes | An employee whose goals the HOD has not approved yet is shown as **Locked - awaiting approval** (progress tracking has not opened). The dot beside "KRAs on track" shows the worst status among the KRAs that need attention. |

Read-only: no actions. Employees enter their progress on screen 4.4
([employee/README.md](../employee/README.md)).
