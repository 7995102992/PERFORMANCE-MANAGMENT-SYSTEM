import { createRoute, redirect } from "@tanstack/react-router"
import type { AnyRoute } from "@tanstack/react-router"

import { store } from "@/store"
import { SuperAdminDashboard } from "./pages/Dashboard"
import { OrgsListPage } from "./pages/Organisations/OrgsListPage"
import { AddOrganisation } from "./pages/Organisations/AddOrganisation"
import { EditOrganisation } from "./pages/Organisations/EditOrganisation"

function requireSuperAdmin() {
  const user = store.getState().auth.user
  if (!user?.is_super_admin) {
    throw redirect({ to: "/" })
  }
}

export function createSuperAdminRoutes(parentRoute: AnyRoute) {
  const superAdminIndexRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/super-admin",
    component: SuperAdminDashboard,
    beforeLoad: requireSuperAdmin,
  })

  const orgsListRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/super-admin/organisations",
    component: OrgsListPage,
    beforeLoad: requireSuperAdmin,
  })

  const addOrgRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/super-admin/organisations/new",
    component: AddOrganisation,
    beforeLoad: requireSuperAdmin,
  })

  const editOrgRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/super-admin/organisations/edit",
    component: EditOrganisation,
    beforeLoad: requireSuperAdmin,
    validateSearch: (search: Record<string, unknown>) => ({
      id: search.id ? String(search.id) : undefined,
    }),
  })

  return [
    superAdminIndexRoute,
    orgsListRoute,
    addOrgRoute,
    editOrgRoute,
  ]
}
