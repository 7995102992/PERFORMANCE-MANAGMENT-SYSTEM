import { useGetEmployeeAccessQuery } from '@/store/api/iamApi'
import { useAuth } from '@/hooks/use-auth'
import { hasPermissionLevel, type AclLevel } from '@/lib/permissions'

export interface EmployeeAccess {
  granted: boolean
  level: AclLevel | null
  canView: boolean
  canEdit: boolean
  canDelete: boolean
  /** True until the server has answered — screens keep the /me-derived gate meanwhile. */
  isLoading: boolean
}

/**
 * What the caller may do on the HR employee screens, taken from
 * `GET /employees/resources` — the server resolving its own guards rather than
 * the FE re-deriving them from the `/me` grid. `canEdit` here means the PUT
 * genuinely succeeds, not "probably".
 *
 * Falls back to the `/me` derivation in three cases, all of which used to be
 * the only path: while the call is in flight (so no control flickers from
 * enabled to disabled on load), against a backend that predates the route
 * (404), and on a transport error. A 403 is not a fallback case — the route
 * inherits the router's viewer guard, so it is the server saying "ungranted",
 * and the answer is a locked-down screen.
 */
export function useEmployeeAccess(): EmployeeAccess {
  const auth = useAuth()
  const { data, error, isLoading } = useGetEmployeeAccessQuery()

  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: number | string }).status
      : undefined

  if (status === 403) {
    return {
      granted: false,
      level: null,
      canView: false,
      canEdit: false,
      canDelete: false,
      isLoading: false,
    }
  }

  if (!data) {
    const level = ['admin', 'editor', 'viewer'].find((l) =>
      hasPermissionLevel(auth, 'core_hr', 'resource_management', l as AclLevel),
    ) as AclLevel | undefined
    return {
      granted: !!level,
      level: level ?? null,
      canView: hasPermissionLevel(auth, 'core_hr', 'resource_management', 'viewer'),
      canEdit: hasPermissionLevel(auth, 'core_hr', 'resource_management', 'editor'),
      canDelete: hasPermissionLevel(auth, 'core_hr', 'resource_management', 'admin'),
      isLoading,
    }
  }

  return {
    granted: data.granted,
    level: data.level,
    canView: data.can_view,
    canEdit: data.can_edit,
    canDelete: data.can_delete,
    isLoading: false,
  }
}
