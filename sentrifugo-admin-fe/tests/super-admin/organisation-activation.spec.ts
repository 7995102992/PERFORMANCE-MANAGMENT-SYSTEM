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
import { createOrganisation } from './organisations.helpers'

/**
 * Full activation path: super admin creates an org → the primary admin's
 * activation token is read from Valkey (it never leaves the email/Valkey) →
 * redeemed via /auth/activate + /auth/reset-password → the new admin logs in.
 *
 * Requires Valkey connection env (E2E_VALKEY_URL or E2E_VALKEY_HOST/...); skips
 * cleanly otherwise so the rest of the suite is unaffected.
 */
test.describe('IAM — Org Admin Activation @iam @activation', () => {
  test.beforeEach(() => {
    test.skip(
      !valkeyConfigured(),
      'Set E2E_VALKEY_URL (or E2E_VALKEY_HOST/_PORT/_PASSWORD) to run activation tests',
    )
  })

  test('new org admin activates via the emailed token and can log in', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_ActOrg`
    const email = testEmail(runId) // sethu_<runId>@yopmail.com
    const password = generatePassword(runId) // generated per run — not a stored secret

    // 1. Super admin creates the org (fires the activation email/token).
    await login(page, personas.superAdmin)
    await createOrganisation(page, { name, runId })

    // 2. Resolve the new admin's user id, then pull its activation token from Valkey.
    const orgId = await getOrgIdByName(page, name)
    const userId = await getOrgAdminUserId(page, orgId, email)
    const activationToken = await getActivationTokenForUser(userId)

    // 3. Redeem activation + set the password via the real public endpoints.
    await redeemActivation(page, activationToken, password)

    // 4. Prove it end to end: the freshly activated admin can sign in.
    await logout(page)
    await login(page, { email, password })
    await expect(page).not.toHaveURL(/\/login/)
  })
})
