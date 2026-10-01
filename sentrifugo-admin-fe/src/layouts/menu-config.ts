import type { LucideIcon } from "lucide-react"

// ─── Shared types (used by all modules) ───────────────────────────────────────

export type Permission = "view" | "create" | "edit" | "delete"

export type MenuItem = {
  key: string
  label: string
  path: string
  icon?: LucideIcon
  permission?: Permission
}

export type MenuGroup = {
  key: string
  label: string
  description?: string
  icon: LucideIcon
  permission?: Permission
  setupStepId?: string
  children: MenuItem[]
}

export type MenuSection = {
  sectionTitle: string
  requiredRole?: string
  collapsible?: boolean
  groups: MenuGroup[]
}

// ─── Import module configs ────────────────────────────────────────────────────

export { orgSetupMenuConfig, orgPostSetupMenuConfig } from "@/modules/org-setup/menu-config"
export { superAdminMenuConfig } from "@/modules/super-admin/menu-config"

import { SETUP_STEP_PATHS as orgSetupStepPaths } from "@/modules/org-setup/menu-config"

// ─── Wizard step paths (aggregated from all modules) ─────────────────────────

export const SETUP_STEP_PATHS: string[] = [
  ...orgSetupStepPaths,
  // ...timesheetStepPaths,            ← after merge
]
