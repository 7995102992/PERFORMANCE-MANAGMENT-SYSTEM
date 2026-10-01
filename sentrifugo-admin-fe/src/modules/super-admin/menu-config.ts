import { Building2, LayoutDashboard } from "lucide-react"
import type { MenuSection } from "@/layouts/menu-config"

export const superAdminMenuConfig: MenuSection[] = [
  {
    sectionTitle: "Super Admin",
    requiredRole: "superadmin",
    groups: [
      {
        key: "sa-dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        children: [{ key: "sa-dashboard-home", label: "Dashboard", path: "/super-admin" }],
      },
      {
        key: "sa-organisations",
        label: "Organisations",
        icon: Building2,
        children: [{ key: "sa-orgs-list", label: "Organisations", path: "/super-admin/organisations" }],
      },
      // {
      //   key: "sa-settings",
      //   label: "Settings",
      //   icon: Settings,
      //   children: [{ key: "sa-settings-home", label: "Settings", path: "/super-admin/settings" }],
      // },
      // {
      //   key: "sa-user-mgmt",
      //   label: "User Management",
      //   icon: Users,
      //   children: [{ key: "sa-users", label: "User Management", path: "/super-admin/users" }],
      // },
    ],
  },
]
