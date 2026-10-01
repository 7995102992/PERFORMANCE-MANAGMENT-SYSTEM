import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { MeResponse, TokenResponse } from '@/types/auth'
import {
  getCookie,
  setCookie,
  deleteCookie,
  isRemembered,
  TOKEN_MAX_AGE,
  REMEMBER_KEY,
} from '@/lib/cookies'

interface AuthState {
  accessToken: string | null
  refreshToken: string | null
  user: MeResponse | null
  sessionExpired: boolean
}

const initialState: AuthState = {
  accessToken: getCookie('access_token'),
  refreshToken: getCookie('refresh_token'),
  user: null,
  sessionExpired: false,
}

// Persistent (7-day) cookies when "remember me" was checked, otherwise session
// cookies. The choice is recorded by the Login page before tokens are issued,
// so both login and silent token refresh persist tokens consistently.
function persistTokens(accessToken: string, refreshToken: string): void {
  const maxAge = isRemembered() ? TOKEN_MAX_AGE : undefined
  setCookie('access_token', accessToken, maxAge)
  setCookie('refresh_token', refreshToken, maxAge)
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setTokens(state, action: PayloadAction<TokenResponse>) {
      state.accessToken = action.payload.access_token
      state.refreshToken = action.payload.refresh_token
      state.sessionExpired = false
      persistTokens(action.payload.access_token, action.payload.refresh_token)
    },
    setUser(state, action: PayloadAction<MeResponse>) {
      state.user = action.payload
    },
    setSessionExpired(state) {
      state.sessionExpired = true
    },
    clearAuth(state) {
      state.accessToken = null
      state.refreshToken = null
      state.user = null
      state.sessionExpired = false
      deleteCookie('access_token')
      deleteCookie('refresh_token')
      deleteCookie(REMEMBER_KEY)
    },
  },
})

export const { setTokens, setUser, setSessionExpired, clearAuth } = authSlice.actions
export default authSlice.reducer
