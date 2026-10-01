import type { MenuSection, MenuGroup, MenuItem } from "@/layouts/menu-config"

export type UserPermissions = Record<string, string[]>

/**
 * Level held per granted action, keyed module → action → level. Populated from
 * the `/me` payload's `action_acls`. Sparse: an action missing here is either
 * ungranted or granted by an API that predates the field — `permissionLevel`
 * falls back to the module-wide `acl` in that case.
 */
export type UserActionLevels = Record<string, Record<string, AclLevel>>

export type AclLevel = "viewer" | "editor" | "admin"

const ACL_RANK: Record<AclLevel, number> = { viewer: 0, editor: 1, admin: 2 }

export type UserRole = "superadmin" | "admin" | "manager" | "employee"

export interface TimesheetActions {
  my_timesheet: boolean
  manage_timesheet: boolean
  client_timesheet: boolean
  manage_settings: boolean
  manage_projects: boolean
  view_reports: boolean
  manage_clients: boolean
}
const ROLE_RANK: Record<UserRole, number> = {
  superadmin: 3,
  admin: 2,
  manager: 1,
  employee: 0,
}

export interface AuthUser {
  role: UserRole
  permissions: UserPermissions
  /** Module-wide acl per module, as sent by `/me`. */
  moduleAcls: Record<string, AclLevel>
  actionLevels: UserActionLevels
  isOrgAdmin: boolean
  payslipAdmin: boolean
  timesheetActions: TimesheetActions
  hasNoPermissions: boolean
}

/**
 * The level the user holds on one (module, action), or null when the action
 * isn't granted at all.
 *
 * Falls back to the module-wide acl when `action_acls` has no entry — an older
 * API, or a session cached before the field existed. Without that fallback a
 * levelled screen would read every legacy grant as ungranted and lock out
 * users who legitimately have access.
 */
export function permissionLevel(
  user: AuthUser,
  module: string,
  action: string
): AclLevel | null {
  if (user.isOrgAdmin || user.role === "superadmin" || user.role === "admin") {
    return "admin"
  }
  if (!user.permissions[module]?.includes(action)) return null
  return user.actionLevels[module]?.[action] ?? user.moduleAcls[module] ?? null
}

/** True when the user holds `action` at `min` level or higher. */
export function hasPermissionLevel(
  user: AuthUser,
  module: string,
  action: string,
  min: AclLevel
): boolean {
  const held = permissionLevel(user, module, action)
  if (!held) return false
  return ACL_RANK[held] >= ACL_RANK[min]
}

/**
 * Filters the full sidebar menu config based on the user's role and permissions.
 *
 * Filtering rules:
 * 1. Section with `requiredRole` is only visible if user.role matches
 * 2. A MenuGroup is visible if the user has the group's `permission` for that module key
 *    (or if group has no `permission` set — always visible)
 * 3. A MenuItem is visible if the user has that item's `permission` for the parent group key
 *    (or if item has no `permission` set — always visible)
 * 4. Groups with zero visible children after filtering are removed
 * 5. Sections with zero visible groups after filtering are removed
 */
// Timesheet is gated by the `timesheetActions` flags from `/me` rather than the
// module/permission pairs used everywhere else, so the whole group takes a
// separate path. Review and Admin are now nested items inside it, so the gate
// runs per item (at any depth) instead of per group.
const TIMESHEET_GROUP_KEY = "timesheet-management"
function meetsRoleRequirement(userRole: UserRole, requiredRole: string): boolean {
  const required = ROLE_RANK[requiredRole as UserRole]
  if (required === undefined) return false
  return ROLE_RANK[userRole] >= required
}

export function filterMenuByPermissions(
  menu: MenuSection[],
  user: AuthUser
): MenuSection[] {
  if (user.hasNoPermissions) {
    // Dashboard + Organization (My Journey, Policies & Docs) are baseline
    // employee content — visible even without any module permission.
    return menu
      .map((section) => ({
        ...section,
        groups: section.groups.filter(
          (g) => g.key === "dashboard" || g.key === "organization"
        ),
      }))
      .filter((section) => section.groups.length > 0)
  }

  return menu
    .filter((section) => {
      if (!section.requiredRole) return true
      return meetsRoleRequirement(user.role, section.requiredRole)
    })
    .map((section) => ({
      ...section,
      groups: section.groups
        .filter((group) =>
          // Timesheet has no group-level gate — per-item filtering below decides,
          // and the group drops out when nothing survives.
          group.key === TIMESHEET_GROUP_KEY ? true : hasGroupAccess(group, user)
        )
        .map((group) => ({
          ...group,
          children:
            group.key === TIMESHEET_GROUP_KEY
              ? filterTimesheetItems(group.children, user)
              : filterNestedChildren(group.children, group, user),
        }))
        .filter((group) => group.children.length > 0),
    }))
    .filter((section) => section.groups.length > 0)
}

function isClientOnlyUser(user: AuthUser): boolean {
  const ts = user.timesheetActions
  return !user.isOrgAdmin && ts.client_timesheet && !ts.manage_timesheet && !ts.my_timesheet
}

function hasGroupAccess(group: MenuGroup, user: AuthUser): boolean {
  // Client-only users see nothing outside of timesheet groups (handled separately)
  if (isClientOnlyUser(user)) return false

  if (group.hideForAdmin && user.isOrgAdmin) {
    return false
  }
  if (group.requiredRole && !meetsRoleRequirement(user.role, group.requiredRole)) {
    return false
  }
  if (!group.permission) return true
  if (user.role === "superadmin" || user.role === "admin") return true

  const modulePerms = user.permissions[group.moduleKey ?? group.key]
  if (!modulePerms) return false

  return modulePerms.includes(group.permission)
}

function filterNestedChildren(children: MenuItem[], group: MenuGroup, user: AuthUser): MenuItem[] {
  return children
    .map((item) => {
      if (item.children) {
        const filtered = filterNestedChildren(item.children, group, user)
        return filtered.length > 0 ? { ...item, children: filtered } : null
      }
      return hasItemAccess(item, group, user) ? item : null
    })
    .filter((item): item is MenuItem => item !== null)
}

function hasItemAccess(item: MenuItem, group: MenuGroup, user: AuthUser): boolean {
  if (item.minRole && !meetsRoleRequirement(user.role, item.minRole)) {
    return false
  }
  // Payslip-admin items are gated purely by the `/me` payslip_admin flag,
  // independent of role/module permissions.
  if (item.requiresPayslipAdmin) return user.payslipAdmin
  if (!item.permission && !item.anyPermission?.length) return true
  if (user.role === "superadmin" || user.role === "admin") return true

  // Item may override the module it checks against (e.g. SR analytics leaves
  // inside the cross-module Analytics group).
  const modulePerms = user.permissions[item.moduleKey ?? group.moduleKey ?? group.key]
  if (!modulePerms) return false

  // A disjunction, for entries one of several roles can reach. Expense's
  // `Team Expenses` is the case: it serves the reporting manager and the
  // management approver from one list, and L2 gets no nav entry of its own.
  if (item.anyPermission?.length) {
    return item.anyPermission.some((p) => modulePerms.includes(p))
  }

  return modulePerms.includes(item.permission!)
}

/**
 * Walks the Timesheet group at any depth, keeping only leaves the user's
 * `timesheetActions` allow. A nested parent (Timesheet Review / Timesheet Admin)
 * survives only if at least one of its leaves does.
 */
function filterTimesheetItems(items: MenuItem[], user: AuthUser): MenuItem[] {
  return items
    .map((item) => {
      if (item.children) {
        const children = filterTimesheetItems(item.children, user)
        return children.length > 0 ? { ...item, children } : null
      }
      return hasTimesheetItemAccess(item.key, user) ? item : null
    })
    .filter((item): item is MenuItem => item !== null)
}

function hasTimesheetItemAccess(key: string, user: AuthUser): boolean {
  const ts = user.timesheetActions

  // Org admins get the configuration + review surfaces but not the personal /
  // team logging screens, which belong to employees and their managers.
  const adminOverride = user.isOrgAdmin

  switch (key) {
    // — own / team logging —
    case "employee-timesheet":
      return !user.isOrgAdmin && (ts.my_timesheet || ts.manage_timesheet)
    case "employee-timesheets":
      return !user.isOrgAdmin && ts.manage_timesheet

    // — review —
    case "client-review":
      return adminOverride || ts.client_timesheet

    // — admin / setup —
    case "ts-clients":
      return adminOverride || ts.manage_clients
    case "ts-project-heads":
      return adminOverride || ts.manage_clients || ts.manage_projects
    case "ts-projects":
      return adminOverride || ts.manage_projects
    case "ts-tasks":
      return adminOverride || ts.manage_projects
    case "ts-reports":
      return adminOverride || ts.view_reports
    case "ts-settings":
      return adminOverride || ts.manage_settings

    default:
      return false
  }
}

/**
 * Second-pass gate for SR analytics persona items. Menu items tagged with
 * `analyticsRole` are visibility-driven by the backend `/analytics/roles`
 * entitlement (grant OR derived), not by static permissions — this is the
 * single source of truth that reflects A (IAM grant) and B (reporting-chain /
 * department derived). Until the roles load (`loaded === false`) tagged items
 * are hidden, so un-entitled links never flash. Untagged items pass through.
 * Parent items / groups / sections left empty after filtering are dropped.
 */
export function gateAnalyticsRoles(
  menu: MenuSection[],
  entitledRoles: Set<string>,
  loaded: boolean
): MenuSection[] {
  const filterItems = (items: MenuItem[]): MenuItem[] =>
    items
      .map((item) => {
        if (item.children) {
          const children = filterItems(item.children)
          return children.length > 0 ? { ...item, children } : null
        }
        if (item.analyticsRole) {
          return loaded && entitledRoles.has(item.analyticsRole) ? item : null
        }
        return item
      })
      .filter((item): item is MenuItem => item !== null)

  return menu
    .map((section) => ({
      ...section,
      groups: section.groups
        .map((group) => ({ ...group, children: filterItems(group.children) }))
        .filter((group) => group.children.length > 0),
    }))
    .filter((section) => section.groups.length > 0)
}
