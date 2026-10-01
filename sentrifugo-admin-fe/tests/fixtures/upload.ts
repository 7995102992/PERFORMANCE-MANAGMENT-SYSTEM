import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Image-upload helpers for the Admin-FE E2E suite.
 *
 * The org-profile (and any logo/avatar) field renders a shared `ImageUploader`
 * (src/components/shared/ImageUploader.tsx). When the uploader has a fixed
 * aspect (org logo = 600x350), selecting a file does NOT commit it directly —
 * it opens a **"Crop Image"** dialog and the "Save Crop" button stays DISABLED
 * until ReactCrop's `onComplete` fires (i.e. until the crop region is touched).
 * So a test must: set the hidden file input → nudge the crop → click Save Crop.
 *
 * A ready-made fixture image lives at `tests/fixtures/files/logo.png`
 * (600x350 PNG, < 2MB, image/png — within the uploader's allowed types/size).
 */

/** Repo-root-relative path to the seed logo (matches the org-documents convention). */
export const LOGO_FILE = 'tests/fixtures/files/logo.png'

interface UploadLogoOptions {
  /**
   * Path to the image to upload. Defaults to the bundled 600x350 `logo.png`.
   * Must be an allowed type (jpeg/png/jpg) and <= 2MB, else the uploader rejects it.
   */
  file?: string
  /**
   * Scope for the uploader's hidden `<input type="file">`. Pass the section/card
   * locator when the page has more than one file input; defaults to the page's
   * first file input (the logo on the Organisation Details form).
   */
  scope?: Page | Locator
}

/**
 * Drive the `ImageUploader` end to end for an aspect-cropped field (e.g. the org
 * logo): select the file, satisfy the crop dialog, and commit. After this
 * resolves the field holds a cropped File and shows its preview, so the parent
 * form's logo validation passes.
 */
export async function uploadLogo(
  page: Page,
  { file = LOGO_FILE, scope }: UploadLogoOptions = {},
): Promise<void> {
  const root = scope ?? page
  // The input is visually hidden; Playwright can still set files on it.
  await root.locator('input[type="file"]').first().setInputFiles(file)

  // Aspect-cropped uploads open the crop dialog.
  const dialog = page.getByRole('dialog').filter({ hasText: 'Crop Image' })
  await expect(dialog).toBeVisible()

  // "Save Crop" is disabled until ReactCrop reports a completed crop, which only
  // happens after the crop region is interacted with — so nudge it once.
  const cropImg = dialog.locator('img[alt="Crop preview"]')
  await expect(cropImg).toBeVisible()
  const box = await cropImg.boundingBox()
  if (!box) throw new Error('Crop preview image has no bounding box')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, {
    steps: 8,
  })
  await page.mouse.up()

  const saveCrop = dialog.getByRole('button', { name: 'Save Crop' })
  await expect(saveCrop).toBeEnabled()
  await saveCrop.click()
  await expect(dialog).toBeHidden()
}
