/**
 * OrgAdminLayout
 *
 * Dedicated layout shell for the post-setup org admin dashboard
 * (setup_status === 'active'). No wizard footer, no stepper sidebar.
 *
 * UI devs can freely modify this file without affecting
 * the super-admin layout or the org-setup wizard layout.
 */

import { Outlet } from "@tanstack/react-router"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "./AppSidebar"
import { Topbar } from "./Topbar"
import { OrgBootstrap } from "./OrgBootstrap"

const SIDEBAR_KEY = "sidebar_open"

export function OrgAdminLayout() {
  const defaultOpen = true

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      onOpenChange={(open) => localStorage.setItem(SIDEBAR_KEY, String(open))}
    >
      <OrgBootstrap />
      <AppSidebar />
      <SidebarInset>
        <Topbar />
        <main className="flex-1 overflow-y-auto bg-card ">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
