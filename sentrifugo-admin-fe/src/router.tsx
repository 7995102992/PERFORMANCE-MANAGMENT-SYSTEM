import {
  createRouter,
  createRootRoute,
  createRoute,
  redirect,
  Outlet,
} from "@tanstack/react-router"

import { AdminLayout } from "./layouts/AdminLayout"
import { Login } from "./pages/Login"
import { ForgotPassword } from "./pages/ForgotPassword"
import { ResetPassword } from "./pages/ResetPassword"
import { ActivateAccount } from "./pages/ActivateAccount"
import { Profile } from "./pages/Profile"
import { store } from "./store"

// ─── Module routes ────────────────────────────────────────────────────────────

import { createOrgSetupRoutes } from "./modules/org-setup/routes"
import { createSuperAdminRoutes } from "./modules/super-admin/routes"
import { createAuditLogsRoutes } from "./modules/audit-logs/routes"
// import { createTimesheetRoutes } from "./modules/timesheet/routes"         ← after merge
// import { createLeaveRoutes } from "./modules/leave-management/routes"      ← future

// ─── Root route ───────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
  beforeLoad: () => {
    // Mirror of the admin guard: an already-authenticated admin must not be
    // able to land back on /login (e.g. via the browser Back button) and then
    // re-enter the app without re-authenticating. Bounce them to their home.
    const state = store.getState()
    const { token, user } = state.auth
    if (token && user && (user.is_org_admin || user.is_super_admin)) {
      throw redirect({ to: user.is_super_admin ? "/super-admin" : "/" })
    }
  },
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPassword,
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetPassword,
  validateSearch: (search: Record<string, unknown>) => ({
    token: (search.token as string) || '',
  }),
})

const activateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activate",
  component: ActivateAccount,
  validateSearch: (search: Record<string, unknown>) => ({
    token: (search.token as string) || '',
  }),
})

const adminLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "admin",
  component: AdminLayout,
  beforeLoad: () => {
    const state = store.getState()
    if (!state.auth.token) {
      throw redirect({ to: "/login" })
    }
    // Employees and managers are not allowed in the admin portal
    const user = state.auth.user
    if (user && !user.is_org_admin && !user.is_super_admin) {
      throw redirect({ to: "/login" })
    }
  },
})

const profileRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: "/profile",
  component: Profile,
})

// ─── Route tree ───────────────────────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  activateRoute,
  adminLayoutRoute.addChildren([
    profileRoute,
    ...createOrgSetupRoutes(adminLayoutRoute),
    ...createSuperAdminRoutes(adminLayoutRoute),
    ...createAuditLogsRoutes(adminLayoutRoute),
    // ...createTimesheetRoutes(adminLayoutRoute),       ← after merge
    // ...createLeaveRoutes(adminLayoutRoute),            ← future
  ]),
])

export const router = createRouter({ routeTree, basepath: '/admin' })
