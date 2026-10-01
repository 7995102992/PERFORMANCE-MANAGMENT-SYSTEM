// ─── Auth Request / Response Types ────────────────────────────

export interface LoginRequest {
  email: string
  password: string
  remember?: boolean
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type?: string
}

export interface RefreshRequest {
  refresh_token: string
}

// ─── mPIN (quick login with the Secure PIN on a trusted device) ──
export interface MpinRegisterResponse {
  device_token: string
}

export interface MpinLoginRequest {
  pin: string
  device_token: string
}

export interface LogoutRequest {
  refresh_token?: string | null
  all_devices?: boolean
}

export interface MeResponse {
  id: string
  email: string
  auth_method: string
  first_name: string
  last_name: string
  middle_name?: string | null
  phone?: string | null
  avatar_url?: string | null
  dob?: string | null
  gender?: string | null
  marital_status?: string | null
  status: string
  organisation_id?: string | null
  is_super_admin?: boolean
  is_org_admin?: boolean
  /** True when the caller may manage payslips (New Payslip / Employee Payslip). */
  payslip_admin?: boolean
  /** True when the caller already has a Secure PIN (from the session payload). */
  is_pin_exists?: boolean
  pending_email?: string | null
  policy_ids?: string[]
  last_login_at?: string | null
  password_changed_at?: string | null
  created_on?: string | null
  modified_on?: string | null
  permissions?: Record<string, {
    /** Module-wide maximum across the caller's policies. Says nothing about the
     *  level held on one specific action — use `action_acls` for that. */
    acl?: string
    actions?: Record<string, boolean>
    /** Level held per granted action ("viewer" | "editor" | "admin"). Only
     *  present for actions that are true in `actions`. Absent on sessions
     *  cached before the API started sending it. */
    action_acls?: Record<string, string>
  } | unknown>
}

export interface ActivateAccountRequest {
  token: string
  password: string
}

export interface ResendActivationRequest {
  email: string
}

export interface ForgotPasswordRequest {
  email: string
}

export interface ResetPasswordRequest {
  token: string
  new_password: string
}

export interface ChangePasswordRequest {
  current_password: string
  new_password: string
}

export interface ConfirmEmailChangeRequest {
  token: string
}

export interface AzureLoginUrlResponse {
  authorization_url: string
  state: string
}

export interface AzureCallbackRequest {
  code: string
  state: string
}

// ─── User Profile Update ───────────────────────────────────────

export interface UserUpdate {
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  middle_name?: string | null
  phone?: string | null
  avatar_url?: string | null
  dob?: string | null
  gender?: string | null
  marital_status?: string | null
}
