import { ScrollText } from "lucide-react"
import type { MenuGroup } from "@/layouts/menu-config"

// Audit Logs sidebar entry. Shown only in the post-setup org-admin sidebar
// (wired into orgPostSetupMenuConfig), so it appears once the org is fully set up.
export const auditLogsMenuGroup: MenuGroup = {
  key: "audit-logs",
  label: "Audit Logs",
  description: "Review system & user activity",
  icon: ScrollText,
  children: [
    { key: "audit-logs-page", label: "View", path: "/audit-logs" },
  ],
}
