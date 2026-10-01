import { defineConfig, devices } from '@playwright/test'

// Load E2E secrets/config from a git-ignored .env.e2e (NEVER commit secrets).
// Node (>=20.12 / required >=22 here) ships process.loadEnvFile; real environment
// variables — shell exports and CI secrets — take precedence over the file, and
// the file is simply absent in CI. See .env.e2e.example + tests/README.md.
if (typeof process.loadEnvFile === 'function') {
  for (const f of ['.env.e2e', '.env.e2e.local']) {
    try {
      process.loadEnvFile(f)
    } catch {
      /* file is optional */
    }
  }
}

// Slow each action down when watching a headed run so it's easy to follow.
// Headless/CI runs stay at full speed. Override with E2E_SLOWMO (ms).
const slowMo = process.env.E2E_SLOWMO
  ? Number(process.env.E2E_SLOWMO)
  : process.argv.includes('--headed')
    ? 400
    : 0

/**
 * Playwright E2E config for Sentrifugo-Admin-FE (the IAM admin frontend).
 *
 * Specs live under `tests/` (committed). The FE dev server is auto-started
 * (reused if already running). The IAM backend (:8000) must be running
 * separately and pointed at the target environment (currently DEV).
 *
 * NOTE: the app is served under the `/admin` base path (Vite `base: '/admin'`,
 * TanStack router `basepath: '/admin'`). All in-app navigation therefore goes
 * through the `goto()` / `appUrl()` helpers in tests/fixtures/ui.ts, which
 * prepend `/admin`. Override the app origin+base with E2E_BASE_URL and the IAM
 * API base with E2E_API_URL if needed.
 */
export default defineConfig({
  testDir: './tests',
  // These E2E tests hit one shared local stack (FE + IAM API), so run them
  // serially — parallel workers overload the single dev server and time out.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Generous per-test timeout: real login + navigation + form round-trips.
  timeout: 60_000,
  // HTML report (open with `npm run test:e2e:report`) + concise terminal output.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // Origin+base of the admin app. Helpers build absolute URLs from this, so
    // the `/admin` base is never lost to Playwright's relative-URL joining.
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5174/admin',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { slowMo },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Pin the dev server to 5174 so auto-start matches the configured base URL
    // (Vite would otherwise pick 5173, or fall through to 5174 if it's taken).
    command: 'npm run dev -- --port 5174 --strictPort',
    // The app lives under /admin; the bare origin 404s, so poll the base path.
    url: 'http://localhost:5174/admin',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
