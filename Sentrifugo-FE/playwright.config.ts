import { existsSync } from 'node:fs'
// Load .env into process.env BEFORE anything reads it. Vite loads .env for the
// app bundle, but that is a different process from this test runner — without
// this, every E2E_* / VITE_* key in .env is invisible here and the fixtures fall
// back to their defaults, silently pointing the tests at the wrong host.
// dotenv does not overwrite variables already set, so a shell override still wins.
import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'

// Slow each action down when watching a headed run so it's easy to follow.
// Headless/CI runs stay at full speed. Override with E2E_SLOWMO (ms).
const slowMo = process.env.E2E_SLOWMO
  ? Number(process.env.E2E_SLOWMO)
  : process.argv.includes('--headed')
    ? 400
    : 0

// Drive the browser INSTALLED ON THIS MACHINE, not Playwright's bundled
// Chromium — the corporate security agent whitelists the real Chrome binary
// and blocks the downloaded one (same reason API calls go through the page,
// see tests/fixtures/api.ts). `channel: 'chrome'` resolves the system Google
// Chrome; point E2E_BROWSER_PATH at any other Chromium build to override it
// (e.g. a real chromium.exe or msedge.exe).
const executablePath = process.env.E2E_BROWSER_PATH

/**
 * Playwright E2E config for Sentrifugo-FE.
 *
 * Specs live under `tests/` (committed). The FE dev server is auto-started
 * (reused if already running). The backends (IAM :8000, SRM :8001) must be
 * running separately and pointed at the target environment (currently DEV).
 *
 * Override the base URL with E2E_BASE_URL if needed.
 */
export default defineConfig({
  testDir: './tests',
  // Compiles the app once before the first spec — see tests/global-setup.ts.
  globalSetup: './tests/global-setup.ts',
  // These E2E tests hit one shared local stack (FE + IAM + module API), so run
  // them serially — parallel workers overload the single dev server and time out.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Generous per-test timeout: real login + navigation + form round-trips.
  timeout: 60_000,
  // HTML report (open with `npm run test:e2e:report`) + concise terminal output.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { slowMo, ...(executablePath ? { executablePath } : {}) },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Skipped when E2E_BROWSER_PATH is set — executablePath wins over channel.
        ...(executablePath ? {} : { channel: 'chrome' }),
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
