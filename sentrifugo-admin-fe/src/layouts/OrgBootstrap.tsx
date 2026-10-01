import { useEffect } from "react"
import { useOrganisations } from "@/hooks/queries/use-organisation"
import { useAppDispatch, useAppSelector } from "@/store"
import { setSavedOrganisation } from "@/store/slices/organisation-slice"

/**
 * Loads the org once on app mount, mirrors the latest fetch into Redux.
 *
 * - Single fetch site for all admin pages — no duplicate `useOrganisations` calls.
 * - Mirroring to Redux makes `setup_steps` synchronously available to route
 *   guards (which can't await React Query).
 * - Mutations that touch setup state invalidate this query (via the
 *   `setupAffecting` meta flag); the new payload flows back into Redux here.
 */
export function OrgBootstrap() {
  const dispatch = useAppDispatch()
  const token = useAppSelector((s) => s.auth.token)
  const isSuperAdmin = useAppSelector((s) => !!s.auth.user?.is_super_admin)
  const { data: orgs } = useOrganisations(!!token && !isSuperAdmin)

  useEffect(() => {
    if (isSuperAdmin) return
    const next = orgs?.[0]
    if (next) dispatch(setSavedOrganisation(next))
  }, [orgs, dispatch, isSuperAdmin])

  return null
}
