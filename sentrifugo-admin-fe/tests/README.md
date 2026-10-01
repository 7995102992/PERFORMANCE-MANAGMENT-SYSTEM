# Admin-FE E2E tests (Playwright)

End-to-end UI tests for the Sentrifugo **IAM admin** frontend, mirroring the
Service-Request E2E suite in `Sentrifugo-FE`. Tests drive the real admin UI and
the real **IAM backend** (no mocking) so they verify behaviour end to end.

## Layout

```
tests/
├── fixtures/
│   ├── personas.ts   # test users (super admin, org admins, employee)
│   ├── auth.ts       # login() / logout() via the real login UI
│   ├── ui.ts         # base-path nav, token cookie, Base-UI combobox, confirm dialog
│   ├── activation.ts # read the Valkey activation token + redeem it (account activation)
│   ├── bulk.ts       # build an in-memory employee xlsx for bulk import
│   ├── upload.ts     # uploadLogo() — drives the ImageUploader crop dialog
│   └── files/        # seed upload fixtures: logo.png (600x350), sample.csv, test_org_policy.pdf
├── auth/
│   └── auth.spec.ts          # login, forgot/reset password, activation, change password, logout
├── super-admin/
│   ├── organisations.{helpers,config.spec}.ts   # create / activate / validate / RBAC for organisations
│   ├── organisation-activation.spec.ts          # new admin activates via the emailed token + logs in
│   ├── org-setup-journey.helpers.ts             # org-profile step, structure chooser, finish, status check
│   └── organisation-onboarding.spec.ts          # wizard ENTRY smoke + FULL setup-wizard journey (@journey)
├── org-setup/
│   ├── departments.{helpers,config.spec}.ts    # create / validate / edit / BU association
│   ├── designations.{helpers,config.spec}.ts   # create / validate / edit (needs seeded pay grades)
│   ├── bands.{helpers,config.spec}.ts          # create / validate / edit
│   ├── pay-grades.{helpers,config.spec}.ts     # create (needs a band) / validate
│   ├── business-units.config.spec.ts           # structure chooser + manage view + create validation
│   ├── org-documents.config.spec.ts            # upload a document + empty-state
│   ├── assign-heads.config.spec.ts             # render + assign organisation head
│   └── employees.{helpers,config.spec}.ts      # full create + validation + bulk import
└── users-policies/
    ├── roles.{helpers,config.spec}.ts          # create / validate / edit + permission grid + copy-from
    └── org-admins.config.spec.ts               # add org admin + validation
```

## Prerequisites

- The IAM backend running at `http://localhost:8000` (override `E2E_API_URL`),
  pointed at the target environment (currently **DEV**), with the seed data
  applied — see `Sentrifugo-IAM-Admin-BE/scripts/seed_superadmin.py` and
  `seed_org_via_api.py`.
- The admin FE dev server. Playwright starts it automatically (`npm run dev`,
  served under `/admin`) and reuses an already-running one.

First-time setup:

```bash
npm install
npx playwright install chromium
```

## Running

```bash
npm run test:e2e                 # all specs, headless
npm run test:e2e -- --headed     # watch in a browser (auto-slowed 400ms/action)
npm run test:e2e:ui              # interactive UI mode
npx playwright test tests/auth   # one folder
npx playwright test --grep @organisations
npm run test:e2e:report          # open the HTML report
```

## Conventions (mirrored from the SR suite)

- **Unique run IDs** — every created record carries `<runId>` and is purgeable
  by one of two keys: entity **names** (orgs, depts, designations, bands, pay
  grades, roles, BUs) and **person names** (employees, org/primary admins) use
  `_test_<runId>…`; **emails** use `sethu_<runId>@yopmail.com`. (BU employee-code
  prefix is `T<runId>` — that field only allows letters/digits.) Verified: no
  name field has a charset/pattern constraint, only length, in FE and IAM BE.
- **Role/label/placeholder locators** — no CSS/XPath. Forms whose `<label>` is
  not associated with its input are targeted by placeholder (e.g. Departments)
  or by ordered inputs (e.g. the Profile → Security password fields).
- **Web-first assertions** — `expect(...).toBeVisible()` etc. auto-wait; no
  fixed `waitForTimeout`s.
- **API verification** — after a UI create, the logged-in session's
  `access_token` cookie is reused as a Bearer token to confirm the write
  (`getAccessToken` / `authHeader` in `ui.ts`).
- **Triggerable emails** — every test-created user/admin email is
  `sethu_<runId>@yopmail.com` (`testEmail()` in `ui.ts`). The backend sends the
  activation mail to that throwaway inbox, so it can be opened at
  <https://yopmail.com> (search `sethu_<runId>`) to complete activation manually.

### Admin-FE specifics worth knowing

- The app is under the **`/admin`** base path — always navigate via `goto()` /
  `appUrl()` from `ui.ts`, never a bare relative path.
- `SearchableSelect` is a **Base-UI Combobox** (not Radix): the popup is
  `[data-slot="combobox-content"]` and options are `[data-slot="combobox-item"]`.
- Create/update/delete actions confirm through a global **AlertDialog**
  (`role="alertdialog"`); click its action button via `confirmAction()`.
- Several IAM entities (**organisations, departments**) have **no delete UI**,
  so `_test_` records persist. `E2E_CLEANUP=1` is wired for future entities that
  do support deletion; deactivate-via-edit is used where available.

## Environment variables

Secrets (passwords, Valkey creds) are **never stored in the test files** — they
come from env. `--list` needs none of them; running needs the password vars.

**Recommended:** put them in a git-ignored `.env.e2e` (the config auto-loads it):

```bash
cp .env.e2e.example .env.e2e   # then fill in E2E_PASSWORD + E2E_SUPERADMIN_PASSWORD
npm run test:e2e
```

`.env.e2e` is in `.gitignore`. Real shell exports / CI secrets still override the
file (Node's env-file loader doesn't clobber existing env vars), so CI can inject
them the usual way and never needs the file.

| Variable                  | Default                          | Purpose                                  |
| ------------------------- | -------------------------------- | ---------------------------------------- |
| `E2E_BASE_URL`            | `http://localhost:5174/admin`    | Admin app origin + base path             |
| `E2E_API_URL`             | `http://localhost:8000`          | IAM backend base URL                     |
| `E2E_PASSWORD`            | _(required)_                     | Org-admin / employee password            |
| `E2E_SUPERADMIN_PASSWORD` | _(required)_                     | Super-admin password                     |
| `E2E_SUPERADMIN`          | seed super-admin email           | Override super-admin login email         |
| `E2E_ORG_ADMIN`           | `orgadmin.zenith@yopmail.com`    | Override default org-admin login email   |
| `E2E_VALKEY_URL`          | _(unset)_                        | Valkey URL for the activation spec       |
| `E2E_VALKEY_HOST/_PORT/_PASSWORD/_DB` | _(unset)_            | Valkey conn parts (alt to the URL)       |
| `E2E_SLOWMO`              | `0` (headless) / `400` (headed)  | Per-action slow-down (ms)                |
| `E2E_CLEANUP`             | `0`                              | Opt-in teardown where supported          |

## Org-setup wizard coverage notes

- **Bands / Pay Grades**: standalone routes `/settings/bands`, `/settings/pay-grades`.
  A **pay grade requires an active band**, so that spec creates a band first.
- **Designations & Roles**: tabs under `/settings/designations` (helpers click the
  tab first). Designation create needs a seeded **pay grade**; role create needs
  only a name. Roles also cover the **permission grid** (grant-all-Viewer, always
  allowed) and **copy-from another role**, verified via `GET /policies/{id}/permissions`.
  Modules: `core_hr, leave_management, service_request, timesheet_management,
  reports_and_analytics`; ACL `admin/editor/viewer` (reports = viewer-only).
- **Business Units**: structure chooser + manage view + create-form validation +
  **full create** (India geo so currency/timezone/fiscal auto-fill; first enabled
  day in the DatePicker; needs seeded country/state/city; multi-BU mode).
- **Employees**: full multi-section create fills the first option of every required
  select (needs a seeded org); bulk import downloads the template, re-uploads it,
  and asserts the "no data rows" review state.
- **Assign Heads / Org Admins**: create real records + send activation mail; no
  delete UI, so `_test_`/`sethu_` records persist. The assign-head test self-skips
  if the first employee yields no change.
- **Full onboarding journey** (`organisation-onboarding.spec.ts`, `@journey`):
  the only test that drives the wizard as a BRAND-NEW admin end to end — super
  admin creates + activates the org and its admin (Valkey token), then that admin
  logs in and walks every step: **Organisation profile → Business Unit →
  Departments → (Org Documents) → Job Levels (band → pay grade → designation →
  role) → (Employees) → (Assign Head) → Finish**, asserting `setup_status` flips
  to `active` (UI toast + `GET /organisations/` on the admin's own token). It
  navigates with `goto()` per step (the wizard serves the same `/settings/*`
  pages), reusing each feature suite's create helpers. Requires Valkey; the
  mandatory chain skips the run with a reason if seeded **geo master data** is
  missing (BU create), and optional steps (org docs, employees, assign head)
  degrade to test annotations rather than failing the journey.
- **Logo upload**: the Organisation profile (and any avatar) field is a shared
  `ImageUploader` with a fixed aspect, so selecting a file opens a **"Crop
  Image"** dialog whose "Save Crop" stays disabled until the crop is touched.
  `uploadLogo()` in `fixtures/upload.ts` handles this (set file → nudge crop →
  Save Crop) using the bundled `fixtures/files/logo.png` (600x350).

## Still to add (next increments)

- **Business Units**: duplicate-name/prefix guards, and the destructive
  single↔multiple structure toggle (best in an isolated org).
- **Org Documents**: edit + delete (delete confirm "Delete Document").
- **Full journey**: run the `@journey` test in CI once a DEV env with seeded geo
  master data + Valkey is wired up, and capture the single-BU structure variant.
