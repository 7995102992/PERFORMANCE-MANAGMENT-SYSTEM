/**
 * AdminLayout — Route-level layout switcher
 *
 * This component is the single entry-point for the authenticated zone.
 * It reads the user's role and org state from Redux and delegates rendering
 * to one of three fully-isolated layout files:
 *
 *   SuperAdminLayout  → src/layouts/SuperAdminLayout.tsx
 *   OrgSetupLayout    → src/layouts/OrgSetupLayout.tsx
 *   OrgAdminLayout    → src/layouts/OrgAdminLayout.tsx
 *
 * UI devs should edit THOSE files, not this one.
 * Router config lives in src/router.tsx — also untouched.
 */

import { useAppSelector } from "@/store"
import { SuperAdminLayout } from "./SuperAdminLayout"
import { OrgSetupLayout } from "./OrgSetupLayout"
import { OrgAdminLayout } from "./OrgAdminLayout"
import { SessionExpiredModal } from "@/components/shared/SessionExpiredModal"

export function AdminLayout() {
  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const setupStatus = useAppSelector((s) => s.organisation.savedOrganisation?.setup_status)

  const layout = isSuperAdmin
    ? <SuperAdminLayout />
    : setupStatus !== "active"
      ? <OrgSetupLayout />
      : <OrgAdminLayout />

  return (
    <>
      {layout}
      <SessionExpiredModal />
    </>
  )
}
