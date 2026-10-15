# PMS (Performance Management) - frontend

The PMS module lets HR run appraisal cycles, managers set and review goals, employees acknowledge goals,
report progress and self-appraise, HODs approve, and Corporate HR rate HR competencies and calibrate ratings.

The data comes from the **PMS_Java** service. How every call works is in
[`src/store/api/PMS-API-INTEGRATION.md`](../../store/api/PMS-API-INTEGRATION.md).

## Folder map

| Folder | Screens | README |
|---|---|---|
| `cycle/` | 1.1 cycle list, 1.2 - 1.5 cycle wizard, 1.6 cycle activated | [cycle/README.md](cycle/README.md) |
| `configuration/` | 2.1 - 2.4 goal templates, 2.5 KRA, 2.7 KPI, 2.9 competency, 2.10 rating scale | [configuration/README.md](configuration/README.md) |
| `goal-setting/` | 3.1 - 3.8 manager goal setting, 4.1 - 4.3 and 4.5 My Goals, 5.1 - 5.2 HOD approval | [goal-setting/README.md](goal-setting/README.md) |
| `progress/` | 3.9 team progress | [progress/README.md](progress/README.md) |
| `mid-year/` | 3.10 - 3.12 mid-year review and target revision | [mid-year/README.md](mid-year/README.md) |
| `appraisal/` | 3.13 - 3.14 team appraisal and manager rating | [appraisal/README.md](appraisal/README.md) |
| `employee/` | 4.4 progress update, 4.6 self appraisal | [employee/README.md](employee/README.md) |
| `hr/` | 1.7 - 1.9 HR competency rating and calibration | [hr/README.md](hr/README.md) |
| `shared/` | Components and helpers used by all of the above | [shared/README.md](shared/README.md) |
| `PmsComingSoon.tsx` | Placeholder for menu entries without a screen yet | - |

The screen numbers follow the PMS mockups (the number in the yellow header of each mockup).

## Who sees what

Routes are registered in `src/router.tsx`; menu entries are in `src/layouts/menu-config.ts` under "PMS Cycle".
The backend decides access with these `performance_management` actions:

| Action | Used for |
|---|---|
| `pms_cycle`, `goal_template`, `kra_master`, `kpi_master`, `competency_master`, `rating_scale` | Configuration and cycles (Corporate HR) |
| `team_goals`, `team_progress`, `mid_year_review`, `team_appraisal` | Manager screens |
| `my_goals`, `progress`, `self_appraisal` | Employee screens |
| `goal_approval` | HOD approval |
| `rating_normalization` | HR competency rating and calibration (Corporate HR) |

The sidebar shows the PMS items to everyone for now (permissions are not applied to the menu yet), but the
API still returns 403 for a screen the user is not allowed to use.

## Conventions used in every page

- **Route params:** the financial year is part of the path (`/pms/my-goals/2026`). `fyToApi(Number(fy))`
  turns it into the API form `2026-27`.
- **Loading and data:** pages call RTK Query hooks from `pmsApi.ts`; masters and lookups are cached for the
  session.
- **Loader plus form:** a page that edits loaded data is split into a loader component (fetch, show spinner or
  error) and a form component that starts from props, so the form state needs no "copy props into state" effect.
- **Validation:** Zod schemas in the `*.schema.ts` file next to the page; the first error per field is shown under
  the field. Server messages are shown as a toast.
- **Text while typing:** numbers are kept as strings in form state and parsed only when building the API body.
- **Unsaved changes:** wizards use `useNavigationGuard` and call the returned `releaseGuard()` before
  navigating away on purpose.
- **Static data:** some screens can run without the backend; see section 4 of the API integration guide.

## Adding a screen

1. Page component in the matching folder (or a new folder with its own README).
2. Route in `src/router.tsx` (use the `pmsRoute(path, component)` helper) and a menu entry in `menu-config.ts`.
3. API hook in `pmsApi.ts` (see "Adding an endpoint" in the integration guide).
4. Zod schema in `<name>.schema.ts`, with one comment per rule.
5. Add the page to the README of its folder: route, data, actions, validation.
