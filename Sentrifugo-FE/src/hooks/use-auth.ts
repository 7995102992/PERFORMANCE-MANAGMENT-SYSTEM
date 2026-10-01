import { useAppSelector } from '@/store'
import { useGetMeQuery } from '@/store/api/iamApi'
import type {
  AclLevel,
  AuthUser,
  UserRole,
  UserPermissions,
  UserActionLevels,
  TimesheetActions,
} from '@/lib/permissions'
import type { Permission } from '@/layouts/menu-config'

const DEFAULT_TIMESHEET_ACTIONS: TimesheetActions = {
  my_timesheet: false,
  manage_timesheet: false,
  client_timesheet: false,
  manage_settings: false,
  manage_projects: false,
  view_reports: false,
  manage_clients: false,
}

function parseTimesheetActions(permissions: Record<string, unknown> | undefined): TimesheetActions {
  const tm = permissions?.timesheet_management as Record<string, unknown> | undefined
  const actions = tm?.actions as Record<string, boolean> | undefined
  if (!actions) return DEFAULT_TIMESHEET_ACTIONS
  return {
    my_timesheet: actions.my_timesheet ?? false,
    manage_timesheet: actions.manage_timesheet ?? false,
    client_timesheet: actions.client_timesheet ?? false,
    manage_settings: actions.manage_settings ?? false,
    manage_projects: actions.manage_projects ?? false,
    view_reports: actions.view_reports ?? false,
    manage_clients: actions.manage_clients ?? false,
  }
}

export function useAuth(): AuthUser {
  const { accessToken, user } = useAppSelector((s) => s.auth)

  useGetMeQuery(undefined, { skip: !accessToken || !!user })

  if (!user) {
    return {
      role: 'employee',
      permissions: {},
      moduleAcls: {},
      actionLevels: {},
      isOrgAdmin: false,
      payslipAdmin: false,
      timesheetActions: DEFAULT_TIMESHEET_ACTIONS,
      hasNoPermissions: false,
    }
  }

  let role: UserRole = 'employee'

  if (user.is_super_admin || user.is_org_admin) {
    role = 'admin'
  } else {
    const srPerm = (user.permissions ?? {})['service_request']
    if (srPerm && typeof srPerm === 'object' && 'acl' in srPerm) {
      const acl = (srPerm as { acl?: string }).acl
      if (acl === 'admin' || acl === 'editor') role = 'manager'
    }
  }

  const permissions: UserPermissions = {}
  const moduleAcls: Record<string, AclLevel> = {}
  const actionLevels: UserActionLevels = {}

  for (const [key, value] of Object.entries(user.permissions ?? {})) {
    if (Array.isArray(value)) {
      // Legacy format: ["view", "create", ...] — no level information at all.
      permissions[key] = value as string[]
    } else if (value && typeof value === 'object' && 'actions' in value) {
      // API format: { acl: "admin", actions: { leave_types: true, ... },
      //               action_acls: { resource_management: "viewer" } }
      const entry = value as {
        acl?: string
        actions?: Record<string, boolean>
        action_acls?: Record<string, string>
      }
      if (entry.actions && typeof entry.actions === 'object') {
        permissions[key] = Object.entries(entry.actions)
          .filter(([, enabled]) => enabled === true)
          .map(([action]) => action)
      }
      if (isAclLevel(entry.acl)) moduleAcls[key] = entry.acl
      if (entry.action_acls && typeof entry.action_acls === 'object') {
        const levels: Record<string, AclLevel> = {}
        for (const [action, level] of Object.entries(entry.action_acls)) {
          if (isAclLevel(level)) levels[action] = level
        }
        if (Object.keys(levels).length > 0) actionLevels[key] = levels
      }
    }
  }

  const isOrgAdmin = !!(user.is_super_admin || user.is_org_admin)
  const payslipAdmin = !!user.payslip_admin
  const timesheetActions = parseTimesheetActions(user.permissions as Record<string, unknown> | undefined)

  const hasNoPermissions = !isOrgAdmin && Object.keys(permissions).length === 0

  return {
    role,
    permissions,
    moduleAcls,
    actionLevels,
    isOrgAdmin,
    payslipAdmin,
    timesheetActions,
    hasNoPermissions,
  }
}

function isAclLevel(value: unknown): value is AclLevel {
  return value === 'viewer' || value === 'editor' || value === 'admin'
}
