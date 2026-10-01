import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { goto } from '../fixtures/ui'

const DOC_FILE = 'tests/fixtures/files/test_org_policy.pdf' // relative to repo root

/**
 * Organisation Documents is folders-first: the landing manages document FOLDERS,
 * and documents live inside a folder. Coverage: create a folder, validation, and
 * upload a real PDF into a freshly-created folder.
 */
test.describe('IAM — Org Setup / Organisation Documents @iam @org-setup', () => {
  async function gotoOrgDocuments(page: import('@playwright/test').Page) {
    await goto(page, '/settings/org-documents')
    await expect(
      page.getByRole('heading', { name: 'Organisation Documents' }),
    ).toBeVisible()
  }

  // 1. Create a document folder → it appears in the list.
  test('org admin creates a document folder', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Folder`

    await login(page, personas.orgAdmin)
    await gotoOrgDocuments(page)

    await page.getByRole('button', { name: 'New Folder' }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByRole('heading', { name: 'New Document Folder' })).toBeVisible()
    await sheet.getByPlaceholder('e.g. Company Policies').fill(name)
    await sheet.getByRole('button', { name: 'Create Folder' }).click()

    // The new folder appears (its name renders in the card; use .first()).
    await expect(page.getByText(name).first()).toBeVisible()
  })

  // 2. Validation — the folder name is required.
  test('folder form requires a name', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoOrgDocuments(page)

    await page.getByRole('button', { name: 'New Folder' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Create Folder' }).click()
    await expect(sheet.getByText('Folder name is required')).toBeVisible()
  })

  // 3. Upload a real PDF into a freshly-created folder.
  test('org admin uploads a document into a folder', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const folder = `_test_${runId}_DocFolder`

    await login(page, personas.orgAdmin)
    await gotoOrgDocuments(page)

    // Create the folder — on save the app auto-opens its document view.
    await page.getByRole('button', { name: 'New Folder' }).click()
    const folderSheet = page.getByRole('dialog')
    await folderSheet.getByPlaceholder('e.g. Company Policies').fill(folder)
    await folderSheet.getByRole('button', { name: 'Create Folder' }).click()

    // Inside the folder (empty state shows two "Add Document" buttons).
    await page.getByRole('button', { name: 'Add Document' }).first().click()
    const docSheet = page.getByRole('dialog')
    await expect(docSheet.getByText('Add Documents')).toBeVisible()

    await docSheet.locator('input[type="file"]').setInputFiles(DOC_FILE)
    await docSheet.getByRole('button', { name: /Upload 1 File/ }).click()

    // Asset upload can take a few seconds; the title renders as "test org policy".
    await expect(page.getByText(/uploaded successfully|added successfully/i)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText(/test org policy/i).first()).toBeVisible()
  })
})
