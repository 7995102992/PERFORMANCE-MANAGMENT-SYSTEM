import { createRoute, redirect } from "@tanstack/react-router"
import type { AnyRoute } from "@tanstack/react-router"
import { store } from "@/store"
import { requireSetupPrereq } from "./route-guards"

import { Home } from "./pages/Home"
import { OrganisationPage } from "./pages/Organisation/OrganisationPage"
import { BusinessUnit } from "./pages/BusinessUnit"
import { Departments } from "./pages/Departments/DepartmentsPage"
import { OrgDocumentsPage } from "./pages/OrgDocuments/OrgDocumentsPage"
import { DesignationsLayout } from "./pages/Designations/DesignationsLayout"
import { EmployeeForm } from "./pages/Employees/EmployeeForm"
import { EmployeesListPage } from "./pages/Employees/EmployeesListPage"
import { OrganizationHead } from "./pages/OrganizationHead"
import { BandsPage } from "./pages/Bands/BandsPage"
import { PayGradesPage } from "./pages/PayGrades/PayGradesPage"
import { ModuleManagementPage } from "./pages/ModuleManagement"
import { OrgAdminsPage } from "./pages/OrgAdmins"
import { SettingsPage } from "@/pages/Settings"

// eslint-disable-next-line react-refresh/only-export-components
const PlaceholderPage = ({ title }: { title: string }) => (
  <div className="p-4">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="text-muted-foreground">This page is under construction.</p>
  </div>
)

/**
 * Creates all org-setup module routes under the given parent layout route.
 */
export function createOrgSetupRoutes(parentRoute: AnyRoute) {
  const indexRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/",
    component: Home,
    beforeLoad: () => {
      const user = store.getState().auth.user
      if (user?.is_super_admin) {
        throw redirect({ to: "/super-admin" })
      }
    },
  })

  const settingsOrgRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/organisation",
    component: OrganisationPage,
  })

  const settingsBuRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/business-units",
    component: BusinessUnit,
    beforeLoad: requireSetupPrereq("organisation"),
  })

  const settingsDeptRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/departments",
    component: Departments,
    beforeLoad: requireSetupPrereq("business_units"),
  })

  const settingsOrgDocsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/org-documents",
    component: OrgDocumentsPage,
  })

  const settingsCustomPermRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/custom-permissions",
    component: () => <PlaceholderPage title="Custom Permissions" />,
  })

  const settingsDesignationRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/designations",
    component: DesignationsLayout,
  })


  const empListRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/employees/list",
    component: EmployeesListPage,
  })

  const empCreateRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/employees/create",
    component: EmployeeForm,
    validateSearch: (search: Record<string, unknown>) => ({
      id: search.id ? String(search.id) : undefined,
      view: search.view === true || search.view === 'true' ? true : undefined,
    }),
  })

  const settingsAssignHeadRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/assign-heads",
    component: () => <OrganizationHead />,
  })

  const settingsBandsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/bands",
    component: () => <BandsPage />,
  })

  const settingsPaygradesRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/pay-grades",
    component: () => <PayGradesPage />,
  })

  const settingsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings",
    component: () => <SettingsPage />,
  })

  const settingsModulesRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/modules",
    component: () => <ModuleManagementPage />,
  })

  const settingsOrgAdminsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/settings/org-admins",
    component: () => <OrgAdminsPage />,
  })

  const timesheetRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/timesheet",
    component: () => <PlaceholderPage title="Time Sheet" />,
  })

  const leaveManagementRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "/leave-management",
    component: () => <PlaceholderPage title="Leave Management" />,
  })

  return [
    indexRoute,
    settingsRoute,
    settingsOrgRoute,
    settingsBuRoute,
    settingsDeptRoute,
    settingsOrgDocsRoute,
    settingsCustomPermRoute,
    settingsDesignationRoute,
    empListRoute,
    empCreateRoute,
    settingsAssignHeadRoute,
    settingsBandsRoute,
    settingsPaygradesRoute,
    settingsModulesRoute,
    settingsOrgAdminsRoute,
    timesheetRoute,
    leaveManagementRoute,
  ]
}
