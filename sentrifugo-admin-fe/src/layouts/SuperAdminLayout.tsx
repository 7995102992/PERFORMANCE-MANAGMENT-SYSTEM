/**
 * SuperAdminLayout
 *
 * Dedicated layout shell for the super-admin portal.
 * UI devs can freely modify this file without affecting
 * the org-setup wizard or the post-setup org admin layout.
 */

import { Outlet } from "@tanstack/react-router"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "./AppSidebar"
import { Topbar } from "./Topbar"
import { OrgBootstrap } from "./OrgBootstrap"
import { LayoutVariantContext } from "@/contexts/layout-variant-context"

const SIDEBAR_KEY = "sidebar_open"

export function SuperAdminLayout() {
  const defaultOpen = localStorage.getItem(SIDEBAR_KEY) !== "false"

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      onOpenChange={(open) => localStorage.setItem(SIDEBAR_KEY, String(open))}
    >
      <OrgBootstrap />
      <AppSidebar />
      <SidebarInset>
        <Topbar />
        <main className="flex-1 overflow-y-auto bg-muted/40">
          <LayoutVariantContext.Provider value="elevated">
            <Outlet />
          </LayoutVariantContext.Provider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
