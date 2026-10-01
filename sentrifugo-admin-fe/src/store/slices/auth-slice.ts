import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface UserProfile {
  id: string
  email: string
  first_name: string
  last_name: string
  middle_name?: string | null
  phone?: string | null
  dob?: string | null
  gender?: string | null
  marital_status?: string | null
  avatar_url?: string | null
  organisation_id: string | null
  is_super_admin: boolean
  is_org_admin: boolean
}

export interface AuthState {
  token: string | null
  refreshToken: string | null
  user: UserProfile | null
  sessionExpired: boolean
}

const initialState: AuthState = {
  token: null,
  refreshToken: null,
  user: null,
  sessionExpired: false,
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setTokens: (state, action: PayloadAction<{ token: string; refreshToken: string }>) => {
      state.token = action.payload.token
      state.refreshToken = action.payload.refreshToken
      state.sessionExpired = false
    },
    setToken: (state, action: PayloadAction<string>) => {
      state.token = action.payload
    },
    setUser: (state, action: PayloadAction<UserProfile>) => {
      state.user = action.payload
    },
    setSessionExpired: (state) => {
      state.sessionExpired = true
    },
    clearToken: (state) => {
      state.token = null
      state.refreshToken = null
      state.user = null
      state.sessionExpired = false
    },
  },
})

export const { setTokens, setToken, setUser, setSessionExpired, clearToken } = authSlice.actions
export default authSlice.reducer
