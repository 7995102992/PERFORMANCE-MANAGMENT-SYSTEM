import { apiClient } from '@/lib/axios'
import type { UserProfile } from '@/store/slices/auth-slice'

export interface LoginRequest {
  email: string
  password: string
  remember?: boolean
}

export interface LoginResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface RefreshRequest {
  refresh_token: string
}

export interface ForgotPasswordRequest {
  email: string
}

export interface ResetPasswordRequest {
  token: string
  new_password: string
}

export interface LogoutRequest {
  refresh_token: string | null
}

export interface UpdateProfileRequest {
  first_name?: string | null
  last_name?: string | null
  middle_name?: string | null
  phone?: string | null
  dob?: string | null
  gender?: string | null
  marital_status?: string | null
}

export interface ChangePasswordRequest {
  current_password: string
  new_password: string
}

export const authService = {
  /** POST /auth/logout — invalidate refresh token on the server */
  async logout(payload: LogoutRequest) {
    await apiClient.post('/auth/logout', payload)
  },

  /** POST /auth/login — org admin / regular user */
  async login(payload: LoginRequest) {
    const { data } = await apiClient.post<LoginResponse>('/auth/login', payload)
    return data
  },

  /** POST /auth/portal/login — super admin portal */
  async portalLogin(payload: LoginRequest) {
    const { data } = await apiClient.post<LoginResponse>('/auth/portal/login', payload)
    return data
  },

  /** POST /auth/refresh */
  async refresh(payload: RefreshRequest) {
    const { data } = await apiClient.post<LoginResponse>('/auth/refresh', payload)
    return data
  },

  /** GET /auth/me — returns current user profile including role flags */
  async getMe(): Promise<UserProfile> {
    const { data } = await apiClient.get<UserProfile>('/auth/me')
    return data
  },

  /** POST /auth/forgot-password */
  async forgotPassword(payload: ForgotPasswordRequest) {
    const { data } = await apiClient.post<{ message: string }>('/auth/forgot-password', payload)
    return data
  },

  /** POST /auth/reset-password */
  async resetPassword(payload: ResetPasswordRequest) {
    const { data } = await apiClient.post<{ message: string }>('/auth/reset-password', payload)
    return data
  },

  /** PUT /auth/me — update current user's profile */
  async updateProfile(payload: UpdateProfileRequest) {
    const { data } = await apiClient.put<UserProfile>('/auth/me', payload)
    return data
  },

  /** POST /auth/change-password — change password while authenticated */
  async changePassword(payload: ChangePasswordRequest) {
    const { data } = await apiClient.post<{ message: string }>('/auth/change-password', payload)
    return data
  },

  /** POST /auth/activate — verifies token, activates account, returns password-reset token */
  async activateAccount(token: string) {
    const { data } = await apiClient.post<{ message: string; password_reset_token: string }>('/auth/activate', { token })
    return data
  },
}
