import axios from 'axios'
import { store } from '@/store'
import { setTokens, clearAuth, setSessionExpired } from '@/store/slices/authSlice'
import { attemptTokenRefresh } from '@/store/api/baseQuery'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_LMS_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor — attach auth token
apiClient.interceptors.request.use((config) => {
  const token = store.getState().auth.accessToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Shared refresh promise for axios — same deduplication as RTK Query
let axiosRefreshing: Promise<void> | null = null

// Response interceptor — refresh token on 401, show session expired if refresh fails
apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) {
      return Promise.reject(error)
    }

    const originalRequest = error.config!

    if (!axiosRefreshing) {
      axiosRefreshing = attemptTokenRefresh(
        () => store.getState().auth.refreshToken,
        (tokens) => store.dispatch(setTokens(tokens)),
        () => {
          store.dispatch(clearAuth())
          store.dispatch(setSessionExpired())
        },
      ).finally(() => {
        axiosRefreshing = null
      })
    }

    await axiosRefreshing

    const newToken = store.getState().auth.accessToken
    if (!newToken) return Promise.reject(error)

    originalRequest.headers.Authorization = `Bearer ${newToken}`
    return apiClient(originalRequest)
  }
)

export { apiClient }
