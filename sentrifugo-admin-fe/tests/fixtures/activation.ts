import { expect, type Page } from '@playwright/test'
import Redis from 'ioredis'
import { API_BASE, authHeader } from './ui'

/**
 * Account-activation helpers.
 *
 * The IAM backend mints a single-use activation token (a JWT) and stores it in
 * Valkey as `activation:<token>` → `<user_id>` (see IAM `auth/utils/activation.py`).
 * The token is never returned over HTTP — it only reaches the user by email — so
 * to complete activation without a mail catcher we read the token straight from
 * Valkey by user id, then redeem the real endpoints:
 *   POST /auth/activate {token}  → { password_reset_token }
 *   POST /auth/reset-password {token, new_password}
 *
 * SECRETS: the Valkey connection comes entirely from env (nothing hard-coded):
 *   - E2E_VALKEY_URL                          e.g. redis://:<pw>@host:6379/0
 *   - or E2E_VALKEY_HOST / _PORT / _PASSWORD / _DB
 */

const ACTIVATION_PREFIX = 'activation:'

/** True when Valkey connection env is present (used to skip the spec otherwise). */
export function valkeyConfigured(): boolean {
  return !!(process.env.E2E_VALKEY_URL || process.env.E2E_VALKEY_HOST)
}

function createValkey(): Redis {
  if (process.env.E2E_VALKEY_URL) {
    return new Redis(process.env.E2E_VALKEY_URL, { maxRetriesPerRequest: 2 })
  }
  const host = process.env.E2E_VALKEY_HOST
  if (!host) {
    throw new Error(
      'Valkey not configured — set E2E_VALKEY_URL or E2E_VALKEY_HOST/_PORT/_PASSWORD ' +
        '(see tests/README.md). Credentials are never stored in the test files.',
    )
  }
  return new Redis({
    host,
    port: Number(process.env.E2E_VALKEY_PORT ?? 6379),
    username: process.env.E2E_VALKEY_USERNAME || undefined, // Redis ACL user (e.g. sentrifugo_dev)
    password: process.env.E2E_VALKEY_PASSWORD || undefined,
    db: Number(process.env.E2E_VALKEY_DB ?? 0),
    maxRetriesPerRequest: 2,
  })
}

/** A generated, policy-compliant password for a run — created fresh, never a stored secret. */
export function generatePassword(runId: string): string {
  return `Sethu@${runId}1A`
}

/**
 * Scan Valkey for the activation token belonging to `userId`. The activation
 * email arrives asynchronously (IAM → RabbitMQ), so retry briefly.
 */
export async function getActivationTokenForUser(
  userId: string,
  { attempts = 12, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
  const redis = createValkey()
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${ACTIVATION_PREFIX}*`, 'COUNT', 200)
        cursor = next
        for (const key of keys) {
          if ((await redis.get(key)) === userId) return key.slice(ACTIVATION_PREFIX.length)
        }
      } while (cursor !== '0')
      await new Promise((r) => setTimeout(r, delayMs))
    }
    throw new Error(`No activation token found in Valkey for user ${userId}`)
  } finally {
    redis.disconnect()
  }
}

/** Resolve an organisation's id by its (unique) legal name (super-admin token). */
export async function getOrgIdByName(page: Page, name: string): Promise<string> {
  const res = await page.request.get(`${API_BASE}/super-admin/organisations`, {
    params: { search: name },
    headers: await authHeader(page.context()),
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const items: Array<{ id: string; legal_name: string }> = body.items ?? body
  const org = items.find((o) => o.legal_name === name)
  if (!org) throw new Error(`Organisation not found by name: ${name}`)
  return org.id
}

/** Resolve an org admin's user id by email within an org (super-admin token). */
export async function getOrgAdminUserId(page: Page, orgId: string, email: string): Promise<string> {
  const res = await page.request.get(`${API_BASE}/users`, {
    params: { is_org_admin: true, organisation_id: orgId },
    headers: await authHeader(page.context()),
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const users: Array<{ id: string; email: string }> = Array.isArray(body) ? body : body.items
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase())
  if (!user) throw new Error(`Org admin not found by email: ${email}`)
  return user.id
}

/** Redeem the activation token, then set the password (the two public endpoints). */
export async function redeemActivation(
  page: Page,
  activationToken: string,
  newPassword: string,
): Promise<void> {
  const act = await page.request.post(`${API_BASE}/auth/activate`, {
    data: { token: activationToken },
  })
  expect(act.status(), 'activation should succeed').toBe(200)
  const { password_reset_token } = await act.json()
  expect(password_reset_token, 'activate should return a password_reset_token').toBeTruthy()

  const reset = await page.request.post(`${API_BASE}/auth/reset-password`, {
    data: { token: password_reset_token, new_password: newPassword },
  })
  expect(reset.ok(), 'reset-password should succeed').toBeTruthy()
}
