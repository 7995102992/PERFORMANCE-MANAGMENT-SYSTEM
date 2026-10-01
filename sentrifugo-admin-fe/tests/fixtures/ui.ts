import { expect, type Page, type Locator, type BrowserContext } from '@playwright/test'

/**
 * Shared, app-agnostic UI helpers for the Admin-FE E2E suite.
 *
 * These encode the handful of cross-cutting interaction patterns that every
 * feature spec needs: navigating under the `/admin` base path, reading the
 * auth token, driving the Base-UI combobox (SearchableSelect), and confirming
 * actions through the global `useConfirm` AlertDialog.
 */

/** App origin + base path. The Vite/router base is `/admin`. */
export const APP_BASE = process.env.E2E_BASE_URL || 'http://localhost:5174/admin'
/** IAM backend base URL (for direct API verification calls). */
export const API_BASE = process.env.E2E_API_URL || 'http://localhost:8000'

// Cleanup is OPT-IN: by default created records are left in place for
// inspection. Pass E2E_CLEANUP=1 to enable defensive teardown where the UI
// supports deletion. (Several IAM entities have no delete UI — see specs.)
export const CLEANUP =
  process.env.E2E_CLEANUP === '1' || process.env.E2E_CLEANUP === 'true'

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Email for test-created users/admins: `sethu_<runId>@yopmail.com`.
 * Uses yopmail so the activation/notification mail the backend triggers can be
 * opened and checked in the throwaway inbox at https://yopmail.com.
 */
export function testEmail(runId: string): string {
  return `sethu_${runId}@yopmail.com`
}

/** Absolute URL for an in-app route, preserving the `/admin` base. */
export function appUrl(route: string): string {
  return `${APP_BASE}${route.startsWith('/') ? route : `/${route}`}`
}

/** Navigate to an in-app route (always via an absolute, base-prefixed URL). */
export async function goto(page: Page, route: string): Promise<void> {
  await page.goto(appUrl(route))
}

/**
 * Read the `access_token` cookie the FE persists after login.
 *
 * The token lives in Redux at runtime, but `store.subscribe` mirrors it into a
 * (non-HttpOnly) `access_token` cookie — see src/store/index.ts — which is what
 * the axios interceptor and these tests reuse as the Bearer credential.
 */
export async function getAccessToken(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  const token = cookies.find((c) => c.name === 'access_token')?.value
  expect(token, 'access_token cookie should be set after login').toBeTruthy()
  return token as string
}

/** Authorization header built from the logged-in session's access token. */
export async function authHeader(
  context: BrowserContext,
): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await getAccessToken(context)}` }
}

// ─── Base-UI Combobox (SearchableSelect) ──────────────────────────────────────
// SearchableSelect renders a Base-UI Combobox (NOT Radix), so there is no
// `[data-radix-popper-content-wrapper]`. The popup is `[data-slot=combobox-content]`
// and each option is `[data-slot=combobox-item]`. The trigger is the input that
// carries the given placeholder.

/** Dismiss any open combobox popup and WAIT until it's fully gone, so the next
 *  field's pick can't accidentally target a stale, still-closing popup. */
export async function closeComboboxPopups(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {})
  await expect(page.locator('[data-slot="combobox-content"]')).toHaveCount(0)
}

/** Open the combobox whose input shows `placeholder`; returns the popup (latest). */
export async function openCombobox(
  page: Page,
  placeholder: string | RegExp,
): Promise<Locator> {
  await page.getByPlaceholder(placeholder).click()
  const content = page.locator('[data-slot="combobox-content"]').last()
  await expect(content).toBeVisible()
  return content
}

/** Open a combobox by placeholder and pick its FIRST option (no hardcoded names). */
export async function pickComboboxFirst(
  page: Page,
  placeholder: string | RegExp,
): Promise<void> {
  const content = await openCombobox(page, placeholder)
  await content.locator('[data-slot="combobox-item"]').first().click()
  await closeComboboxPopups(page)
}

/** Open the combobox at `inputLocator` (already resolved) and pick its first option.
 *  Use when a placeholder is ambiguous and you scope it with .first()/.last()/.nth(). */
export async function pickFirstOptionOf(page: Page, inputLocator: Locator): Promise<void> {
  await inputLocator.click()
  const content = page.locator('[data-slot="combobox-content"]').last()
  await expect(content).toBeVisible()
  await content.locator('[data-slot="combobox-item"]').first().click()
  await closeComboboxPopups(page)
}

/** Open a combobox by placeholder and pick the option whose label matches. */
export async function pickComboboxByText(
  page: Page,
  placeholder: string | RegExp,
  label: string,
): Promise<void> {
  const content = await openCombobox(page, placeholder)
  await content
    .locator('[data-slot="combobox-item"]')
    .filter({ hasText: label })
    .first()
    .click()
  await closeComboboxPopups(page)
}

// ─── Confirm AlertDialog (useConfirm) ─────────────────────────────────────────
// Create/update/delete actions route through a global Radix AlertDialog
// (role="alertdialog"). Its action button text is the caller's `confirmText`
// (e.g. "Save", "Update", "Delete"); the cancel button is "Cancel".

/** Click the confirm button (by its label) in the global confirm AlertDialog. */
export async function confirmAction(page: Page, confirmText: string): Promise<void> {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: confirmText, exact: true }).click()
}
