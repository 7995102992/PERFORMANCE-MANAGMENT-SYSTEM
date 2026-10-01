// Cookie-backed auth token storage.
//
// "Remember me" controls cookie persistence — it does NOT change the tokens
// themselves (the IAM backend still issues a 7-day refresh token):
//   - remembered     → 90-day cookies (matches the remember-me refresh window)
//   - not remembered → session cookies (cleared when the browser closes)
//
// Tokens are read by JS and attached as the `Bearer` header by the axios
// interceptor, so these cookies are intentionally not HttpOnly. SameSite=Strict
// + Secure (on https) limit cross-site exposure.

export const REMEMBER_KEY = 'auth_remember'
export const TOKEN_MAX_AGE = 90 * 24 * 60 * 60 // 90 days, in seconds

export function setCookie(name: string, value: string, maxAgeSeconds?: number): void {
  let cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Strict`
  if (window.location.protocol === 'https:') cookie += '; Secure'
  if (maxAgeSeconds != null) cookie += `; Max-Age=${maxAgeSeconds}`
  document.cookie = cookie
}

export function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

export function deleteCookie(name: string): void {
  document.cookie = `${name}=; path=/; Max-Age=0; SameSite=Strict`
}

/** Record the user's remember-me choice before login so token cookies inherit it. */
export function setRememberPreference(remember: boolean): void {
  setCookie(REMEMBER_KEY, remember ? '1' : '0', remember ? TOKEN_MAX_AGE : undefined)
}

export function isRemembered(): boolean {
  return getCookie(REMEMBER_KEY) === '1'
}
