import { toast as sonner } from 'sonner'
import type { AxiosError } from 'axios'
import { store } from '@/store'

// ─── Error extraction ─────────────────────────────────────────────────────────

function formatLabel(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function extractAxiosDetail(detail: unknown): string | null {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc, msg, type}]
    const first = detail[0]
    if (first && typeof first === 'object' && 'msg' in first) {
      return String((first as { msg: unknown }).msg)
    }
  }
  // Dependency conflict object handled separately in extractDependencyError
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return (detail as { message: string }).message
  }
  return null
}

interface DependencyInfo {
  message: string
  dependencies: { type: string; count: number }[]
}

function extractDependencyError(error: unknown): DependencyInfo | null {
  const axiosErr = error as AxiosError<{ detail?: unknown }>
  const detail = axiosErr?.response?.data?.detail
  if (
    detail &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    'dependencies' in detail
  ) {
    const obj = detail as DependencyInfo
    if (obj.dependencies?.length) return obj
  }
  return null
}

export function extractErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (!error) return fallback

  // Axios error
  const axiosErr = error as AxiosError<{ detail?: unknown; message?: string }>
  if (axiosErr.response) {
    const data = axiosErr.response.data
    if (data) {
      const detail = extractAxiosDetail(data.detail)
      if (detail) return detail
      if (typeof data.message === 'string') return data.message
    }
    // HTTP status fallbacks
    const status = axiosErr.response.status
    if (status === 401) return 'Session expired — please log in again'
    if (status === 403) return 'You do not have permission to do that'
    if (status === 404) return 'Resource not found'
    if (status === 409) return 'A conflict occurred — this record may already exist'
    if (status === 422) return 'Invalid data submitted'
    if (status >= 500) return 'Server error — please try again later'
  }

  if (axiosErr.message === 'Network Error') return 'Network error — check your connection'
  if (axiosErr.code === 'ECONNABORTED') return 'Request timed out'

  // Plain Error
  if (error instanceof Error && error.message) return error.message

  return fallback
}

// ─── Typed wrappers ───────────────────────────────────────────────────────────

export const toast = {
  success: (message: string, description?: string) =>
    sonner.success(message, { description }),

  error: (error: unknown, fallback?: string) => {
    if (store.getState().auth.sessionExpired) return
    const dep = extractDependencyError(error)
    if (dep) {
      const desc = dep.dependencies
        .map((d) => `${formatLabel(d.type)} (${d.count})`)
        .join(', ')
      return sonner.error(dep.message, {
        description: `Active linked records: ${desc}`,
        duration: 6000,
      })
    }
    return sonner.error(extractErrorMessage(error, fallback))
  },

  info: (message: string) => sonner.info(message),

  loading: (message: string) => sonner.loading(message),

  dismiss: (id?: string | number) => sonner.dismiss(id),

  promise: sonner.promise.bind(sonner),
}
