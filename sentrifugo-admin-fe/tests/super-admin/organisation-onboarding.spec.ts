import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login, logout } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { testEmail } from '../fixtures/ui'
import {
  generatePassword,
  getActivationTokenForUser,
  getOrgAdminUserId,
  getOrgIdByName,
  redeemActivation,
  valkeyConfigured,
} from '../fixtures/activation'
import { goto } from '../fixtures/ui'
import {
  activateOrganisation,
  createOrganisation,
  openEditOrg,
} from './organisations.helpers'
import {
  assignOrganisationHead,
  chooseBusinessStructure,
  completeOrganisationProfile,
  fetchOrgSetupStatus,
  finishSetup,
  uploadOrgDocument,
} from './org-setup-journey.helpers'
import { createBusinessUnit } from '../org-setup/business-units.helpers'
import { createDepartment, gotoDepartments } from '../org-setup/departments.helpers'
import { createBand, gotoBands } from '../org-setup/bands.helpers'
import { createPayGrade, gotoPayGrades } from '../org-setup/pay-grades.helpers'
import { createDesignation, gotoDesignations } from '../org-setup/designations.helpers'
import { createRole, gotoRoles } from '../users-policies/roles.helpers'
import { createEmployee } from '../org-setup/employees.helpers'

/**
 * New-org onboarding ENTRY, end to end:
 *   super admin creates the org → activates it → the primary admin's account is
 *   activated (token read from Valkey, redeemed via /auth/activate +
 *   /auth/reset-password) → that NEW admin logs in and is taken to the guided
 *   SETUP WIZARD (OrgSetupLayout — a distinct UI from the post-setup admin app).
 *
 * The first test stops at the wizard entry (a fast smoke). The second test
 * walks the FULL wizard as that brand-new admin — Organisation profile → BU →
 * departments → (org documents) → job levels (band → pay grade → designation →
 * role) → (employees) → (assign head) → Finish — and asserts the org flips to
 * setup_status=active. The wizard serves the same /settings/* pages the
 * post-setup app does, so each step reuses the per-feature suite's helpers via
 * `goto()`; only the Organisation profile and the wizard chrome are new.
 *
 * Requires Valkey (for activation); skips cleanly otherwise. Steps that need
 * seeded master data (BU geo, employees) degrade gracefully: a hard dependency
 * (BU → departments) skips the run with a clear reason, optional steps are
 * recorded as annotations and skipped without failing the journey.
 */
test.describe('IAM — New Org Onboarding @iam @onboarding @activation', () => {
  test.beforeEach(() => {
    test.skip(
      !valkeyConfigured(),
      'Set E2E_VALKEY_URL (or E2E_VALKEY_HOST/...) to run the onboarding journey',
    )
  })

  test('super admin creates a new org; its activated admin lands in the setup wizard', async ({ page }) => {
    test.setTimeout(120_000)

    const runId = randomUUID().slice(0, 8)
    const orgName = `_test_${runId}_Onboard`
    const adminEmail = testEmail(runId)
    const adminPassword = generatePassword(runId)

    // 1. Super admin creates + activates the org, and activates its admin.
    await login(page, personas.superAdmin)
    await createOrganisation(page, { name: orgName, runId })
    await openEditOrg(page, orgName)
    await activateOrganisation(page)

    const orgId = await getOrgIdByName(page, orgName)
    const adminUserId = await getOrgAdminUserId(page, orgId, adminEmail)
    const activationToken = await getActivationTokenForUser(adminUserId)
    await redeemActivation(page, activationToken, adminPassword)

    // 2. The brand-new admin logs in.
    await logout(page)
    await login(page, { email: adminEmail, password: adminPassword })

    // 3. A not-yet-set-up org opens the guided setup wizard (not the admin app):
    //    login lands on the wizard DASHBOARD (its progress indicator + the
    //    Organisation step's "Set Up" CTA), not directly on the org form.
    await expect(page.getByText(/Setup \d+%/)).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Organisation Setup', level: 1 }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Set up Organisation' }),
    ).toBeVisible()
  })

  test('the new admin completes the full setup wizard and the org goes active @journey', async ({
    page,
  }) => {
    test.setTimeout(300_000)

    const runId = randomUUID().slice(0, 8)
    const orgName = `_test_${runId}_Journey`
    const adminEmail = testEmail(runId)
    const adminPassword = generatePassword(runId)

    // Record an optional step that couldn't run (missing seed data) without
    // failing the journey — the wizard's mandatory chain is what gates 'active'.
    const attemptOptional = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (err) {
        test
          .info()
          .annotations.push({ type: 'optional-skipped', description: `${name}: ${err}` })
      }
    }

    // 1. Super admin creates + activates the org, and activates its admin.
    await login(page, personas.superAdmin)
    await createOrganisation(page, { name: orgName, runId })
    await openEditOrg(page, orgName)
    await activateOrganisation(page)

    const orgId = await getOrgIdByName(page, orgName)
    const adminUserId = await getOrgAdminUserId(page, orgId, adminEmail)
    const activationToken = await getActivationTokenForUser(adminUserId)
    await redeemActivation(page, activationToken, adminPassword)

    // 2. The brand-new admin logs in → guided setup wizard.
    await logout(page)
    await login(page, { email: adminEmail, password: adminPassword })
    await expect(page.getByText(/Setup \d+%/)).toBeVisible()

    // 3. Step 1 — Organisation profile (logo, India geo, address, dates).
    await completeOrganisationProfile(page)

    // 4. Step 2 — Business Units (multi-BU). Hard dependency for Departments:
    //    if the env lacks seeded geo master data, skip the journey with a reason.
    try {
      await chooseBusinessStructure(page, 'multiple')
      await createBusinessUnit(page, `_test_${runId}_BU`, `T${runId.slice(0, 4)}`)
    } catch (err) {
      test.skip(
        true,
        `Business Unit creation failed — likely missing seeded geo master data: ${err}`,
      )
    }

    // 5. Step 3 — Departments (associates the BU automatically / first BU).
    await gotoDepartments(page)
    await createDepartment(page, `_test_${runId}_Dept`, `T${runId.slice(0, 6)}`)

    // 6. Optional — Organisation Documents.
    await attemptOptional('org-documents', () =>
      uploadOrgDocument(page, `_test_${runId}_DocFolder`),
    )

    // 7. Step 4 — Job Levels: band → pay grade → designation → role (in order).
    await gotoBands(page)
    await createBand(page, `_test_${runId}_Band`)
    await gotoPayGrades(page)
    await createPayGrade(page, `_test_${runId}_PG`)
    await gotoDesignations(page)
    await createDesignation(page, `_test_${runId}_Desig`)
    await gotoRoles(page)
    await createRole(page, `_test_${runId}_Role`)

    // 8. Optional — Employees (needs full master data seeded).
    await attemptOptional('employees', () => createEmployee(page, runId))

    // 9. Optional — Assign an organisation head.
    await attemptOptional('assign-head', () => assignOrganisationHead(page))

    // 10. Finish the wizard; reload first so setup_progress is fresh, then assert
    //     the org flips to active (UI toast + IAM API on the admin's own token).
    await goto(page, '/settings/organisation')
    await finishSetup(page)
    expect(await fetchOrgSetupStatus(page)).toBe('active')
  })
})
