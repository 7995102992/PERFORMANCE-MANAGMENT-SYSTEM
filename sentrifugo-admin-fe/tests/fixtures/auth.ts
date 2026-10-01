import { expect, type Page } from '@playwright/test'
import type { Persona } from './personas'
import { goto } from './ui'

/**
 * Log in through the real login UI and wait until we've left /login.
 * The app routes super admins to /super-admin and org admins to / on success.
 */
export async function login(page: Page, persona: Persona): Promise<void> {
  if (!persona.password) {
    throw new Error(
      `No password for ${persona.email}. Set E2E_PASSWORD / E2E_SUPERADMIN_PASSWORD ` +
        '(see tests/README.md) — passwords are not stored in the test files.',
    )
  }
  await goto(page, '/login')
  await page.getByLabel('Email', { exact: true }).fill(persona.email)
  await page.getByLabel('Password', { exact: true }).fill(persona.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // Leaving /login is the success signal (an async getMe() runs before the
  // redirect, so allow a little headroom).
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
}

/**
 * Log out so a different persona can log in within the same test.
 *
 * Prefer the real UI logout button (sidebar): its handler nulls the in-memory
 * Redux token AND deletes the auth cookies, then navigates to /login. Clearing
 * cookies alone is NOT enough — the live store re-persists the in-memory token
 * back into the access_token cookie on its next state change. We still hard-clear
 * cookies/storage afterwards as a belt-and-suspenders fallback.
 */
export async function logout(page: Page): Promise<void> {
  const logoutBtn = page.getByRole('button', { name: 'Log out' })
  if (await logoutBtn.count().catch(() => 0)) {
    await logoutBtn.first().click()
    await page.waitForURL((u) => u.pathname.includes('/login'), { timeout: 15_000 }).catch(() => {})
  }
  await page.context().clearCookies()
  await page
    .evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    .catch(() => {})
}
