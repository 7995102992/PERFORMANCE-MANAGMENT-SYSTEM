import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { API_BASE, authHeader, goto, testEmail } from '../fixtures/ui'
import {
  activateOrganisation,
  createOrganisation,
  deactivateOrganisation,
  editOrganisationName,
  gotoOrgList,
  openAddOrg,
  openEditOrg,
  searchOrgs,
} from './organisations.helpers'

async function fetchOrgByName(page: import('@playwright/test').Page, name: string) {
  const res = await page.request.get(`${API_BASE}/super-admin/organisations`, {
    params: { search: name },
    headers: await authHeader(page.context()),
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const items: Array<{ legal_name: string; is_active: boolean }> = body.items ?? body
  return items.find((o) => o.legal_name === name)
}

test.describe('IAM — Super Admin / Organisations @iam @organisations', () => {
  // 1. Create an organisation → verify it appears in the list AND via the API.
  //    The admin email is sethu_<runId>@yopmail.com, so the activation link is
  //    delivered to a checkable yopmail inbox. There is no delete UI, so
  //    `_test_` orgs persist on the target environment.
  test('super admin creates an organisation, visible in list and API', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Org`

    await login(page, personas.superAdmin)
    await createOrganisation(page, { name, runId })

    await searchOrgs(page, name)
    await expect(page.getByText(name, { exact: true })).toBeVisible()

    const created = await fetchOrgByName(page, name)
    expect(created, 'created org should be returned by the API').toBeTruthy()
  })

  // 2. Create → then ACTIVATE the organisation from its edit page, and verify
  //    the active status persisted (API is_active === true).
  test('super admin creates and activates an organisation', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Activate`

    await login(page, personas.superAdmin)
    await createOrganisation(page, { name, runId })

    await openEditOrg(page, name)
    await activateOrganisation(page)

    const org = await fetchOrgByName(page, name)
    expect(org?.is_active, 'organisation should be active after activation').toBe(true)
  })

  // 3a. Edit — rename an organisation and verify the change persisted.
  test('super admin edits an organisation name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const original = `_test_${runId}_OrgEdit`
    const renamed = `_test_${runId}_OrgRenamed`

    await login(page, personas.superAdmin)
    await createOrganisation(page, { name: original, runId })

    await openEditOrg(page, original)
    await editOrganisationName(page, renamed)

    await searchOrgs(page, renamed)
    await expect(page.getByText(renamed, { exact: true })).toBeVisible()
    const org = await fetchOrgByName(page, renamed)
    expect(org, 'renamed org should be returned by the API').toBeTruthy()
  })

  // 3b. Deactivate — activate first, then turn the org off and verify is_active=false.
  test('super admin deactivates an organisation', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_OrgDeact`

    await login(page, personas.superAdmin)
    await createOrganisation(page, { name, runId })

    // Ensure it's active first so we exercise the ON → OFF transition.
    await openEditOrg(page, name)
    await activateOrganisation(page)

    await openEditOrg(page, name)
    await deactivateOrganisation(page)

    const org = await fetchOrgByName(page, name)
    expect(org?.is_active, 'organisation should be inactive after deactivation').toBe(false)
  })

  // 3. Required-field validation — empty submit surfaces each error and the
  //    page stays on the create form (no navigation back to the list).
  test('add organisation validates required fields', async ({ page }) => {
    await login(page, personas.superAdmin)
    await gotoOrgList(page)
    await openAddOrg(page)

    await page.getByRole('button', { name: 'Create & Send Activation Link' }).click()
    await expect(page.getByText('Organisation name is required.')).toBeVisible()
    await expect(page.getByText('Admin name is required.')).toBeVisible()
    await expect(page.getByText('Admin email is required.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Add New Organisation' })).toBeVisible()
  })

  // 4. Email-format validation — a malformed admin email is rejected.
  test('add organisation rejects a malformed admin email', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    await login(page, personas.superAdmin)
    await gotoOrgList(page)
    await openAddOrg(page)

    await page.getByLabel('Organisation Name').fill(`_test_${runId}_BadEmail`)
    await page.getByLabel('Full Name').fill(`_test_${runId}`)
    await page.getByLabel('Email Address').fill('not-an-email')
    await page.getByRole('button', { name: 'Create & Send Activation Link' }).click()

    await expect(page.getByText('Enter a valid email address.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Add New Organisation' })).toBeVisible()
  })

  // 5. Duplicate name on create is rejected (backend 409) — the form stays open
  //    and exactly one org with that name persists.
  test('rejects a duplicate organisation name on create', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Dup`

    await login(page, personas.superAdmin)
    await createOrganisation(page, { name, runId }) // first one succeeds

    // Second attempt — same name, different (unique) admin email.
    await gotoOrgList(page)
    await openAddOrg(page)
    await page.getByLabel('Organisation Name').fill(name)
    await page.getByLabel('Full Name').fill(`_test_${runId}`)
    await page.getByLabel('Email Address').fill(testEmail(`${runId}b`))
    await page.getByRole('button', { name: 'Create & Send Activation Link' }).click()

    // Rejected → still on the create form (no navigation back to the list).
    await expect(page.getByRole('heading', { name: 'Add New Organisation' })).toBeVisible()

    // Exactly one org with this name exists in the DB.
    const res = await page.request.get(`${API_BASE}/super-admin/organisations`, {
      params: { search: name },
      headers: await authHeader(page.context()),
    })
    const body = await res.json()
    const items: Array<{ legal_name: string }> = body.items ?? body
    expect(items.filter((o) => o.legal_name === name)).toHaveLength(1)
  })

  // 6. Renaming an org onto an existing name is rejected (backend 409) — the edit
  //    page stays and both organisations survive.
  test('rejects renaming an organisation onto an existing name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const first = `_test_${runId}_Keep`
    const second = `_test_${runId}_Rename`

    await login(page, personas.superAdmin)
    await createOrganisation(page, { name: first, runId })
    await createOrganisation(page, { name: second, runId: `${runId}b` })

    await openEditOrg(page, second)
    await page.getByLabel('Organisation Name').fill(first)
    await page.getByRole('button', { name: 'Save Changes' }).click()

    // Rejected → still on the edit page (not back on the list).
    await expect(page.getByRole('heading', { name: 'Organisations' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible()

    // Both originals still exist.
    expect(await fetchOrgByName(page, first)).toBeTruthy()
    expect(await fetchOrgByName(page, second)).toBeTruthy()
  })

  // 7. RBAC — an org admin cannot reach the super-admin organisations area;
  //    the route guard redirects them away from /super-admin/*.
  test('org admin cannot access the super-admin organisations area', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await goto(page, '/super-admin/organisations')
    await expect(page).not.toHaveURL(/\/super-admin/)
  })
})
