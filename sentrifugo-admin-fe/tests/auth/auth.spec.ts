import { test, expect } from '@playwright/test'
import { login, logout } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { goto, getAccessToken } from '../fixtures/ui'

test.describe('IAM — Auth @iam @auth', () => {
  // 1. Super admin logs in and lands on the super-admin home.
  test('super admin signs in and reaches /super-admin', async ({ page }) => {
    await login(page, personas.superAdmin)
    await expect(page).toHaveURL(/\/super-admin/)
    // The FE persisted the bearer token as a cookie for the API layer.
    await getAccessToken(page.context())
  })

  // 2. Org admin logs in and is NOT left on /login (lands on the org home).
  test('org admin signs in and leaves /login', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await expect(page).not.toHaveURL(/\/login/)
    await getAccessToken(page.context())
  })

  // 3. Invalid credentials surface an error and keep the user on /login.
  test('invalid credentials are rejected', async ({ page }) => {
    await goto(page, '/login')
    await page.getByLabel('Email', { exact: true }).fill('orgadmin.zenith@yopmail.com')
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-pw')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(
      page.getByText('Invalid email or password. Please try again.'),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  // 4. Forgot-password shows the neutral "check your email" confirmation that
  //    echoes the entered address (no account enumeration).
  test('forgot password shows the check-your-email confirmation', async ({ page }) => {
    const email = 'orgadmin.zenith@yopmail.com'
    await goto(page, '/forgot-password')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Send reset link', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    await expect(page.getByText(email)).toBeVisible()
  })

  // 5. Reset-password with no token renders the invalid-link state.
  test('reset password without a token shows the invalid-link state', async ({ page }) => {
    await goto(page, '/reset-password')
    await expect(
      page.getByRole('heading', { name: 'Invalid or expired link' }),
    ).toBeVisible()
  })

  // 6. Reset-password client validation (token present): min-length is enforced
  //    natively (the input has minLength=8, so the browser blocks a short submit
  //    before the JS check), and the mismatch check is a deterministic JS guard.
  test('reset password enforces length and match client-side', async ({ page }) => {
    await goto(page, '/reset-password?token=dummy-e2e-token')
    await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

    // Length guard is the input's native minLength.
    await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('minlength', '8')

    // Long enough but mismatched → JS match error.
    await page.getByLabel('New password', { exact: true }).fill('longenough1')
    await page.getByLabel('Confirm password', { exact: true }).fill('longenough2')
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await expect(page.getByText('Passwords do not match.')).toBeVisible()
  })

  // 7. Activation with no token reports the missing-token message.
  test('account activation without a token reports a missing token', async ({ page }) => {
    await goto(page, '/activate')
    await expect(
      page.getByText('No activation token found in the link. Please check your email and try again.'),
    ).toBeVisible()
  })

  // 8. Change-password client validation on the Profile → Security tab.
  //    (Password fields have no associated <label>, so target the three
  //    password inputs by order within the Security panel.)
  test('change password enforces length and match on the Security tab', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await goto(page, '/profile')
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
    await page.getByRole('tab', { name: 'Security' }).click()

    const pw = page.locator('input[type="password"]')
    await expect(pw).toHaveCount(3) // current, new, confirm

    // New password too short → length error.
    await pw.nth(0).fill('whatever-current')
    await pw.nth(1).fill('short')
    await pw.nth(2).fill('short')
    await page.getByRole('button', { name: 'Update Password', exact: true }).click()
    await expect(page.getByText('New password must be at least 8 characters.')).toBeVisible()

    // Mismatched new/confirm → match error.
    await pw.nth(1).fill('longenough1')
    await pw.nth(2).fill('longenough2')
    await page.getByRole('button', { name: 'Update Password', exact: true }).click()
    await expect(page.getByText('New passwords do not match.')).toBeVisible()
  })

  // 9. Logout clears the session; visiting a protected route bounces to /login.
  test('logout drops the session and protected routes redirect to login', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await logout(page)
    // A fresh navigation re-initialises the store as logged-out → guard redirect.
    await goto(page, '/settings/departments')
    await expect(page).toHaveURL(/\/login/)
  })
})
