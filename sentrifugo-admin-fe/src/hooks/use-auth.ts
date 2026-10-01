import { useAppSelector } from "@/store"
import type { AuthUser } from "@/lib/permissions"

export function useAuth(): AuthUser {
  const user = useAppSelector((state) => state.auth.user)

  if (user?.is_super_admin) {
    return {
      role: "superadmin",
      permissions: {},
    }
  }

  return {
    role: "admin",
    permissions: {
      "sr-category": ["view", "create", "edit", "delete"],
      "sr-type": ["view", "create", "edit", "delete"],
      "sr-approvals": ["view", "create", "edit", "delete"],
      employees: ["view", "create", "edit", "delete"],
      organisation: ["view", "edit"],
      "business-units": ["view", "create", "edit", "delete"],
      departments: ["view", "create", "edit", "delete"],
      roles: ["view", "create", "edit", "delete"],
      "org-folders": ["view", "create", "edit", "delete"],
      designations: ["view", "create", "edit", "delete"],
      paygrade: ["view", "create", "edit", "delete"],
      "assign-head": ["view", "edit"],
    },
  }
}
