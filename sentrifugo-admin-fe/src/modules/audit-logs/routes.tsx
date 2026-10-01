import { createRoute } from "@tanstack/react-router"
import type { AnyRoute } from "@tanstack/react-router"

import { AuditLogsPage } from "./pages/AuditLogsPage"

/**
 * Creates the audit-logs module routes under the given parent (admin) layout
 * route. Guarded by the admin layout's auth check; org scoping is server-side.
 */
export function createAuditLogsRoutes(parentRoute: AnyRoute) {
  const auditLogsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/audit-logs",
    component: AuditLogsPage,
  })

  return [auditLogsRoute]
}
