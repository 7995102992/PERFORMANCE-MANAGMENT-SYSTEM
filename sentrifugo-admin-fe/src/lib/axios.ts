import axios, { CanceledError, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { store } from '@/store'
import { setTokens, clearToken, setSessionExpired } from '@/store/slices/auth-slice'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor — attach auth token, block non-auth requests after logout
apiClient.interceptors.request.use((config) => {
  const token = store.getState().auth.token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  } else if (!config.url?.includes('/auth/')) {
    return Promise.reject(new CanceledError('Session ended'))
  }
  return config
})

// ─── Token refresh logic ─────────────────────────────────────────────────────

let isRefreshing = false
let failedQueue: { resolve: (token: string) => void; reject: (err: unknown) => void }[] = []

function processQueue(error: unknown, token: string | null) {
  for (const { resolve, reject } of failedQueue) {
    if (token) resolve(token)
    else reject(error)
  }
  failedQueue = []
}

// Response interceptor — refresh token on 401, then retry
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    if (
      error.response?.status !== 401
      || originalRequest._retry
      || originalRequest.url?.includes('/auth/')
    ) {
      return Promise.reject(error)
    }

    // If already refreshing, queue this request until refresh completes
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({
          resolve: (token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`
            resolve(apiClient(originalRequest))
          },
          reject,
        })
      })
    }

    originalRequest._retry = true
    isRefreshing = true

    const refreshToken = store.getState().auth.refreshToken
    if (!refreshToken) {
      isRefreshing = false
      store.dispatch(clearToken())
      store.dispatch(setSessionExpired())
      return Promise.reject(error)
    }

    try {
      // Use raw axios (not apiClient) to avoid interceptor loop.
      // Build base URL from apiClient defaults so it's never undefined.
      const baseURL = apiClient.defaults.baseURL ?? ''
      const { data } = await axios.post(
        `${baseURL}/auth/refresh`,
        { refresh_token: refreshToken },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
      )

      store.dispatch(setTokens({
        token: data.access_token,
        refreshToken: data.refresh_token,
      }))

      processQueue(null, data.access_token)
      originalRequest.headers.Authorization = `Bearer ${data.access_token}`
      return apiClient(originalRequest)
    } catch (refreshError) {
      processQueue(refreshError, null)
      store.dispatch(clearToken())
      store.dispatch(setSessionExpired())
      return Promise.reject(refreshError)
    } finally {
      isRefreshing = false
    }
  }
)

export { apiClient }
