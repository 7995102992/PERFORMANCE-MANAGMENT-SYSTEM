import { fetchBaseQuery } from '@reduxjs/toolkit/query'
import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
} from '@reduxjs/toolkit/query'
import type { RootState } from '@/store'
import { setTokens, clearAuth, setSessionExpired } from '@/store/slices/authSlice'
import { payrollLocked } from '@/store/slices/payrollLockSlice'

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

// Shared refresh promise — ensures concurrent 401s trigger only one refresh call.
let refreshing: Promise<void> | null = null

export async function attemptTokenRefresh(
  getRefreshToken: () => string | null,
  onSuccess: (tokens: { access_token: string; refresh_token: string }) => void,
  onFailure: () => void,
): Promise<void> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    onFailure()
    return
  }
  try {
    const res = await fetch(`${IAM_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!res.ok) throw new Error('refresh failed')
    const tokens = await res.json()
    onSuccess(tokens)
  } catch {
    onFailure()
  }
}

/**
 * Serialise array params as repeated keys — `?status=A&status=B&status=C`.
 *
 * RTK Query's default is `new URLSearchParams(params)`, which stringifies an
 * array into a single comma-joined value (`status=A,B,C`). FastAPI declares
 * repeatable list queries and rejects the joined form with a 422, so any filter
 * carrying more than one value fails while single-value filters look fine —
 * which is why this only ever shows up on one tile or one dropdown.
 *
 * Opt-in per API on purpose: several backends here parse comma-joined ids
 * instead, and those slices already `.join(',')` before the request.
 */
export function repeatArrayParams(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue
        search.append(key, String(item))
      }
      continue
    }
    search.append(key, String(value))
  }
  return search.toString()
}

export function createBaseQuery(
  baseUrl: string,
  options: {
    /** Override how query params are encoded. See {@link repeatArrayParams}. */
    paramsSerializer?: (params: Record<string, unknown>) => string
  } = {},
): BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> {
  const rawQuery = fetchBaseQuery({
    baseUrl,
    paramsSerializer: options.paramsSerializer,
    prepareHeaders: (headers, { getState }) => {
      const token = (getState() as RootState).auth.accessToken
      if (token) headers.set('Authorization', `Bearer ${token}`)
      return headers
    },
  })

  return async (args, api, extraOptions) => {
    let result = await rawQuery(args, api, extraOptions)

    // Payroll unlock session expired (fixed 5-min window). Any payroll endpoint
    // returns 403 { code: "PAYSLIP_LOCKED" } once it lapses — bump the lock nonce
    // so the PayrollPinGate re-prompts uniformly across every payroll call.
    if (
      result.error?.status === 403 &&
      (result.error.data as { code?: string } | undefined)?.code === 'PAYSLIP_LOCKED'
    ) {
      api.dispatch(payrollLocked())
      return result
    }

    if (result.error?.status !== 401) return result

    // Kick off a token refresh (or join an in-flight one)
    if (!refreshing) {
      refreshing = attemptTokenRefresh(
        () => (api.getState() as RootState).auth.refreshToken,
        (tokens) => api.dispatch(setTokens(tokens)),
        () => {
          api.dispatch(clearAuth())
          api.dispatch(setSessionExpired())
        },
      ).finally(() => {
        refreshing = null
      })
    }

    await refreshing

    const hasToken = (api.getState() as RootState).auth.accessToken
    if (!hasToken) return result

    result = await rawQuery(args, api, extraOptions)
    return result
  }
}
