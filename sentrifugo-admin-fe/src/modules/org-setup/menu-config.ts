import {
  LayoutDashboard,
  Users,
  FolderOpen,
  Building2,
  Briefcase,
  Layers,
  Award,
  UserCog,
  Package,
  ShieldCheck,
} from "lucide-react"
import type { MenuSection } from "@/layouts/menu-config"
import { auditLogsMenuGroup } from "@/modules/audit-logs/menu-config"

export const SETUP_STEP_PATHS: string[] = [
  "/settings/organisation",
  "/settings/business-units",
  "/settings/departments",
  "/settings/org-documents",
  "/settings/designations",
  "/employees/list",
  "/settings/assign-heads",
]

// ─── Wizard sidebar (setup_status !== 'active') ─────────────────────────────

export const orgSetupMenuConfig: MenuSection[] = [
  {
    sectionTitle: "Main",
    requiredRole: "admin",
    groups: [
      {
        key: "dashboard",
        label: "Dashboard",
        description: "Overview & setup progress",
        icon: LayoutDashboard,
        children: [
          { key: "dashboard-home", label: "Overview", path: "/" },
        ],
      },
      {
        key: "module-management",
        label: "Module Management",
        description: "Enable or disable modules",
        icon: Package,
        children: [
          { key: "modules-page", label: "Manage", path: "/settings/modules" },
        ],
      },
      {
        key: "org-admins",
        label: "Org Admins",
        description: "Manage organisation administrators",
        icon: ShieldCheck,
        children: [
          { key: "org-admins-page", label: "Manage", path: "/settings/org-admins" },
        ],
      },
    ],
  },
  {
    sectionTitle: "Settings",
    requiredRole: "admin",
    groups: [
      {
        key: "organisation",
        label: "Organisation Setup",
        description: "Company details & settings",
        icon: Building2,
        setupStepId: "organisation",
        children: [
          { key: "org-details", label: "Details", path: "/settings/organisation" },
        ],
      },
      {
        key: "business-units",
        label: "Business Units",
        description: "Structure & legal entities",
        icon: Briefcase,
        setupStepId: "business-units",
        children: [
          { key: "bu-list", label: "List", path: "/settings/business-units" },
        ],
      },
      {
        key: "departments",
        label: "Departments",
        description: "Teams & department heads",
        icon: Layers,
        setupStepId: "departments",
        children: [
          { key: "dept-list", label: "List", path: "/settings/departments" },
        ],
      },
      {
        key: "org-documents",
        label: "Org. Documents",
        description: "Policies & handbooks",
        icon: FolderOpen,
        setupStepId: "org-documents",
        children: [
          { key: "org-docs-list", label: "List", path: "/settings/org-documents" },
        ],
      },
      {
        key: "designations",
        label: "Job Levels",
        description: "Job titles & hierarchy",
        icon: Award,
        setupStepId: "designations",
        children: [
          { key: "desg-list", label: "List", path: "/settings/designations" },
        ],
      },
      {
        key: "employees",
        label: "Employees",
        description: "Add & manage employees",
        icon: Users,
        permission: "view",
        setupStepId: "employees",
        children: [
          { key: "emp-list", label: "List", path: "/employees/list", permission: "view" },
        ],
      },
      {
        key: "assign-head",
        label: "Assign Head",
        description: "Department & BU heads",
        icon: UserCog,
        setupStepId: "assign-head",
        children: [
          { key: "assign-head-page", label: "List", path: "/settings/assign-heads" },
        ],
      },
    ],
  },
]

// ─── Post-setup sidebar (setup_status === 'active') ─────────────────────────

export const orgPostSetupMenuConfig: MenuSection[] = [
  {
    sectionTitle: "Main",
    requiredRole: "admin",
    groups: [
      {
        key: "dashboard",
        label: "Dashboard",
        description: "Overview & setup progress",
        icon: LayoutDashboard,
        children: [
          { key: "dashboard-home", label: "Overview", path: "/" },
        ],
      },
      {
        key: "module-management",
        label: "Module Management",
        description: "Enable or disable modules",
        icon: Package,
        children: [
          { key: "modules-page", label: "Manage", path: "/settings/modules" },
        ],
      },
      {
        key: "org-admins",
        label: "Org Admins",
        description: "Manage organisation administrators",
        icon: ShieldCheck,
        children: [
          { key: "org-admins-page", label: "Manage", path: "/settings/org-admins" },
        ],
      },
    ],
  },
  {
    sectionTitle: "Settings",
    requiredRole: "admin",
    groups: [
      {
        key: "organisation",
        label: "Organisation Setup",
        description: "Company details & settings",
        icon: Building2,
        children: [
          { key: "org-details", label: "Details", path: "/settings/organisation" },
        ],
      },
      {
        key: "business-units",
        label: "Business Units",
        description: "Structure & legal entities",
        icon: Briefcase,
        children: [
          { key: "bu-list", label: "List", path: "/settings/business-units" },
        ],
      },
      {
        key: "departments",
        label: "Departments",
        description: "Teams & department heads",
        icon: Layers,
        children: [
          { key: "dept-list", label: "List", path: "/settings/departments" },
        ],
      },
      {
        key: "designations",
        label: "Job Levels",
        description: "Job titles & hierarchy",
        icon: Award,
        children: [
          { key: "desg-list", label: "List", path: "/settings/designations" },
        ],
      },
      {
        key: "org-documents",
        label: "Org. Documents",
        description: "Policies & handbooks",
        icon: FolderOpen,
        children: [
          { key: "org-docs-list", label: "List", path: "/settings/org-documents" },
        ],
      },
      {
        key: "employees",
        label: "Employees",
        description: "Add & manage employees",
        icon: Users,
        permission: "view",
        children: [
          { key: "emp-list", label: "List", path: "/employees/list", permission: "view" },
        ],
      },
      {
        key: "assign-head",
        label: "Assign Head",
        description: "Department & BU heads",
        icon: UserCog,
        children: [
          { key: "assign-head-page", label: "List", path: "/settings/assign-heads" },
        ],
      },
    ],
  },
  {
    sectionTitle: "Audit",
    requiredRole: "admin",
    groups: [auditLogsMenuGroup],
  },
]
