import type { MenuSection, MenuGroup, MenuItem, Permission } from "@/layouts/menu-config"

/**
 * Shape of user permissions returned from the API.
 *
 * Key   = module key matching MenuGroup.key (e.g. "employees", "sr-category")
 * Value = list of granted actions (e.g. ["view", "create"])
 *
 * Example:
 * {
 *   "employees":   ["view", "create"],
 *   "sr-category": ["view"],
 *   "roles":       ["view", "edit", "delete"],
 * }
 */
export type UserPermissions = Record<string, Permission[]>

export type UserRole = "superadmin" | "admin" | "manager" | "employee"

export interface AuthUser {
  role: UserRole
  permissions: UserPermissions
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
export function filterMenuByPermissions(
  menu: MenuSection[],
  user: AuthUser
): MenuSection[] {
  return menu
    .filter((section) => {
      if (!section.requiredRole) return true
      return section.requiredRole === user.role
    })
    .map((section) => ({
      ...section,
      groups: section.groups
        .filter((group) => hasGroupAccess(group, user))
        .map((group) => ({
          ...group,
          children: group.children.filter((item) =>
            hasItemAccess(item, group.key, user)
          ),
        }))
        .filter((group) => group.children.length > 0),
    }))
    .filter((section) => section.groups.length > 0)
}

function hasGroupAccess(group: MenuGroup, user: AuthUser): boolean {
  // No permission required — always visible
  if (!group.permission) return true

  // Superadmin sees everything
  if (user.role === "superadmin") return true

  const modulePerms = user.permissions[group.key]
  if (!modulePerms) return false

  return modulePerms.includes(group.permission)
}

function hasItemAccess(
  item: MenuItem,
  groupKey: string,
  user: AuthUser
): boolean {
  if (!item.permission) return true
  if (user.role === "superadmin") return true

  const modulePerms = user.permissions[groupKey]
  if (!modulePerms) return false

  return modulePerms.includes(item.permission)
}
