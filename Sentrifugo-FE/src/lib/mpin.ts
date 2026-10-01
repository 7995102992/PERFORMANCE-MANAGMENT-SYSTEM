import { setCookie, getCookie, deleteCookie, TOKEN_MAX_AGE } from '@/lib/cookies'

// mPIN device token — lets a trusted device offer quick login with the Secure PIN.
// Stored in a 90-day cookie (matches the server-side token window). Read by JS
// (not HttpOnly) so the login screen can decide which form to show. The server
// can revoke it (logout-all / password change), in which case /auth/mpin/login
// rejects it and we clear it here.
const MPIN_DEVICE_TOKEN_KEY = 'mpin_device_token'
// The enrolled account's display label, so the mPIN screen can show who it's for.
const MPIN_ACCOUNT_KEY = 'mpin_account'
// "Don't ask again" — suppresses the enrolment prompt on this device.
const MPIN_PROMPT_DISMISSED_KEY = 'mpin_prompt_dismissed'
const PROMPT_DISMISS_MAX_AGE = 365 * 24 * 60 * 60 // 1 year, in seconds

export interface MpinAccount {
  name: string
  email: string
}

export function getMpinDeviceToken(): string | null {
  return getCookie(MPIN_DEVICE_TOKEN_KEY)
}

export function setMpinDeviceToken(token: string): void {
  setCookie(MPIN_DEVICE_TOKEN_KEY, token, TOKEN_MAX_AGE)
}

/** Forget this device's enrolment (token + account label). No backend call —
 *  the server-side token expires (~90 days) or is revoked on sign-out-all. */
export function clearMpinDeviceToken(): void {
  deleteCookie(MPIN_DEVICE_TOKEN_KEY)
  deleteCookie(MPIN_ACCOUNT_KEY)
}

export function getMpinAccount(): MpinAccount | null {
  try {
    const raw = getCookie(MPIN_ACCOUNT_KEY)
    return raw ? (JSON.parse(raw) as MpinAccount) : null
  } catch {
    return null
  }
}

export function setMpinAccount(account: MpinAccount): void {
  setCookie(MPIN_ACCOUNT_KEY, JSON.stringify(account), TOKEN_MAX_AGE)
}

/** Whether the user chose "No, don't ask again" for the enrolment prompt. */
export function isMpinPromptDismissed(): boolean {
  return getCookie(MPIN_PROMPT_DISMISSED_KEY) === '1'
}

export function dismissMpinPrompt(): void {
  setCookie(MPIN_PROMPT_DISMISSED_KEY, '1', PROMPT_DISMISS_MAX_AGE)
}
