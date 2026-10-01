import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { testEmail } from '../fixtures/ui'
import {
  createEmployee,
  gotoCreateEmployee,
  gotoEmployeesList,
  searchEmployees,
} from './employees.helpers'
import { buildBulkWorkbook, resolveBulkRefs } from '../fixtures/bulk'

test.describe('IAM — Org Setup / Employees @iam @org-setup', () => {
  // 1. List renders and "Add Employee" routes to the create form.
  test('employees list renders and opens the create form', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoEmployeesList(page)

    await page.getByRole('button', { name: 'Add Employee' }).click()
    await expect(page).toHaveURL(/\/employees\/create/)
  })

  // 2. A search with no match shows the filtered empty state.
  test('employees search shows an empty state for no matches', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    await login(page, personas.orgAdmin)
    await gotoEmployeesList(page)

    await searchEmployees(page, `zzz_nomatch_${runId}`)
    await expect(page.getByText('No employees match your filters.')).toBeVisible()
  })

  // 3. Required-field validation — an empty submit surfaces errors and does not
  //    reach the confirm dialog or create anything.
  test('employee form validates required fields', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoCreateEmployee(page)

    await page.getByRole('button', { name: 'Save Employee', exact: true }).click()
    await expect(page.getByText('First name is required')).toBeVisible()
    await expect(page.getByText('Work email is required')).toBeVisible()
    await expect(page.getByText('Designation is required')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Employee created successfully')).toHaveCount(0)
  })

  // 4. Full create — fills every required field (first option per select) and
  //    verifies the new employee lands in the list. Requires a seeded org
  //    (BUs, departments, designations, roles, master data).
  test('org admin creates an employee', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    await login(page, personas.orgAdmin)
    await createEmployee(page, runId)

    await searchEmployees(page, testEmail(runId))
    await expect(page.getByText(testEmail(runId))).toBeVisible()
  })

  // 5. The page header exposes the "Download Template" action. (Capturing the
  //    actual file download is environment-dependent — the template is generated
  //    via a library/API path Playwright can't reliably intercept here — so we
  //    assert the control is available; the import-dialog test covers the rest.)
  test('employee template download is available', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoCreateEmployee(page)
    await expect(page.getByRole('button', { name: 'Download Template' })).toBeEnabled()
  })

  // 6. Bulk import — download the real template, fill it with 3 `_test_`/yopmail
  //    users (valid reference values sourced from the org via API), upload it,
  //    review, and import. Creates 3 real employees in the org.
  test('org admin bulk-imports employees from a filled template', async ({ page }) => {
    test.setTimeout(120_000)
    const runId = randomUUID().slice(0, 8)

    await login(page, personas.orgAdmin)
    const refs = await resolveBulkRefs(page)
    const users = [1, 2, 3].map((n) => ({
      firstName: `_test_${runId}`,
      lastName: `_test_${runId}_Bulk${n}`,
      email: `_test_${runId}_bulk${n}@yopmail.com`,
    }))
    const fileObj = buildBulkWorkbook(users, refs)

    await gotoCreateEmployee(page)
    await page.getByRole('button', { name: 'Import Employees' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Import Employees')).toBeVisible()

    // The FileUploader checks file.type — pass an explicit xlsx mimeType.
    await dialog.locator('input[type="file"]').setInputFiles(fileObj)
    await dialog.getByRole('button', { name: 'Next: Review' }).click()

    // Review step: select all valid rows, then upload.
    await expect(dialog.getByText('Review & Upload')).toBeVisible()
    await dialog.getByRole('checkbox').first().check()
    await dialog.getByRole('button', { name: /Upload \d+ Row/ }).click()

    await expect(page.getByText(/employee[s]? imported successfully/i)).toBeVisible()
  })
})
