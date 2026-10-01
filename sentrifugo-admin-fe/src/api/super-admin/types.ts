// ─── Module definitions ───────────────────────────────────────────────────────

export type ModuleKey =
  | 'core_hr'
  | 'attendance_management'
  | 'leave_management'
  | 'payroll'
  | 'performance_management'
  | 'recruitment'
  | 'training_and_development'
  | 'expense_management'
  | 'asset_management'
  | 'service_request'
  | 'timesheet_management'
  | 'reports_and_analytics'

export type SetupStatus = 'draft' | 'pending' | 'active'

export interface OrgModule {
  code: ModuleKey
  is_active: boolean
}

export interface ModuleDefinition {
  key: ModuleKey
  label: string
  description: string
  mandatory?: boolean
}

// Mirror of the BE module catalog seed
// (Sentrifugo-IAM-Admin-BE/scripts/seed_lookups.py → MODULE_SEED).
// Only the uncommented modules are actually seeded; the rest are kept commented
// so the two lists can be re-enabled in lockstep. This is a fallback / label
// lookup only — the live catalog comes from GET /lookups/modules.
export const MODULE_DEFINITIONS: ModuleDefinition[] = [
  {
    key: 'core_hr',
    label: 'Core HR',
    description: 'Employee database, org structure, and basic HR functions',
    mandatory: true,
  },
  // {
  //   key: 'attendance_management',
  //   label: 'Attendance Management',
  //   description: 'Track employee attendance, shifts, and work hours',
  // },
  {
    key: 'leave_management',
    label: 'Leave Management',
    description: 'Manage leave requests, approvals, and balances',
  },
  // {
  //   key: 'payroll',
  //   label: 'Payroll',
  //   description: 'Salary processing, tax calculations, and payslips',
  // },
  // {
  //   key: 'performance_management',
  //   label: 'Performance Management',
  //   description: 'Goals, reviews, and performance evaluations',
  // },
  // {
  //   key: 'recruitment',
  //   label: 'Recruitment',
  //   description: 'Job postings, candidate tracking, and hiring',
  // },
  // {
  //   key: 'training_and_development',
  //   label: 'Training & Development',
  //   description: 'Learning programs, courses, and skill development',
  // },
  // {
  //   key: 'expense_management',
  //   label: 'Expense Management',
  //   description: 'Track and approve employee expenses and reimbursements',
  // },
  // {
  //   key: 'asset_management',
  //   label: 'Asset Management',
  //   description: 'Manage company assets and equipment allocation',
  // },
  {
    key: 'service_request',
    label: 'Service Request',
    description: 'Raise and manage employee service requests',
  },
  {
    key: 'timesheet_management',
    label: 'Timesheet Management',
    description: 'Track time, manage clients, projects, and approvals',
  },
  {
    key: 'reports_and_analytics',
    label: 'Reports & Analytics',
    description: 'Generate reports and view organisation analytics',
  },
]

// ─── Module catalog (from GET /lookups/modules) ───────────────────────────────

export interface ModuleCatalogItem {
  id: string
  code: ModuleKey
  label: string
  description: string
  mandatory: boolean
}

// ─── Administrator sub-types ──────────────────────────────────────────────────

export interface AdministratorInput {
  name: string
  email: string
  phone?: string | null
}

export interface AdministratorView {
  user_id: string
  name: string
  email: string
  phone?: string | null
  pending_email?: string | null
}

// ─── Create / Update DTOs (match backend tenancy/schemas.py) ─────────────────

export interface AdministratorUpdateInput {
  name?: string
  phone?: string | null
}

export interface SuperAdminOrgCreateDTO {
  legal_name: string
  enabled_modules: OrgModule[]
  setup_status?: SetupStatus
  administrator: AdministratorInput
  send_activation?: boolean
  // Optional fields for later (org admin completes these)
  address_id?: string | null
  date_of_incorporation?: string | null
  financial_year?: string | null
  currency?: string | null
  timezone?: string | null
  logo_asset_id?: string | null
  is_multiple_business_units?: boolean
}

export interface SuperAdminOrgUpdateDTO {
  legal_name?: string | null
  enabled_modules?: OrgModule[] | null
  setup_status?: SetupStatus | null
  administrator?: AdministratorUpdateInput | null
  is_active?: boolean | null
  address_id?: string | null
  date_of_incorporation?: string | null
  financial_year?: string | null
  currency?: string | null
  timezone?: string | null
  logo_asset_id?: string | null
  is_multiple_business_units?: boolean | null
}

// ─── Response DTOs ────────────────────────────────────────────────────────────

/** Full response — returned by GET /{id} and POST / PUT */
export interface SuperAdminOrgResponseDTO {
  id: string
  legal_name: string
  is_active: boolean
  enabled_modules: OrgModule[]
  administrator?: AdministratorView | null
  logo_asset_id?: string | null
  created_on?: string | null
  modified_on?: string | null
}

/** Summary — returned by GET / (list endpoint) */
export interface SuperAdminOrgListItemDTO {
  id: string
  legal_name: string
  is_active: boolean
  setup_status?: SetupStatus | null
  enabled_modules_count: number
  active_modules_count: number
  created_on?: string | null
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface RecentActivity {
  id: string
  activity: string
  organisation: string
  date: string
  status: 'Completed' | 'Pending' | 'Active'
}

export interface SuperAdminDashboardStats {
  total_users: number
  total_organisations: number
  active_organisations: number
  pending_setup: number
  recent_activities?: RecentActivity[]
}
