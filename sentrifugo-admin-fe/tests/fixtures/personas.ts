/**
 * Test personas (DEV environment).
 *
 * Human-readable mapping lives in E2E-TEST-CREDENTIALS.md in the workspace root
 * (intentionally NOT copied into this repo) — keep the two in sync. Passwords
 * can be overridden via env so secrets need not live in git:
 *   - E2E_PASSWORD            (org-admin / employee password, default test@123)
 *   - E2E_SUPERADMIN_PASSWORD (super-admin password, default SuperAdmin@2026)
 *
 * Only org admins and super admins may enter the admin portal — the router
 * guard bounces plain employees/managers back to /login (see src/router.tsx).
 * The `employee` persona below exists only to exercise that negative path.
 *
 * SECRETS: passwords are NOT hard-coded here. Supply them via env before running
 * (see tests/README.md):
 *   - E2E_PASSWORD             — org-admin / employee password
 *   - E2E_SUPERADMIN_PASSWORD  — super-admin password
 * `login()` throws a clear error if the required password env var is unset, so
 * `playwright test --list` still works without any secrets present.
 */
export interface Persona {
  email: string
  password: string
}

const PASSWORD = process.env.E2E_PASSWORD ?? ''
const SUPERADMIN_PASSWORD = process.env.E2E_SUPERADMIN_PASSWORD ?? ''

export const personas = {
  // Super admin — cross-org; the only persona allowed in /super-admin/*.
  superAdmin: {
    email: process.env.E2E_SUPERADMIN ?? 'sysadmin@sagarsoft.in',
    password: SUPERADMIN_PASSWORD,
  },
  // Org admin (Zenith Digital) — default for org-setup flows (departments, etc.).
  orgAdmin: {
    email: process.env.E2E_ORG_ADMIN ?? 'orgadmin.zenith@yopmail.com',
    password: PASSWORD,
  },
  // Org admin (NexaGen) — secondary org, for cross-org isolation checks.
  orgAdminNexa: { email: 'orgadmin@yopmail.com', password: PASSWORD },
  // Plain employee — NOT permitted in the admin portal; used for RBAC negatives.
  employee: { email: 'aarti.verma@yopmail.com', password: PASSWORD },
} satisfies Record<string, Persona>
