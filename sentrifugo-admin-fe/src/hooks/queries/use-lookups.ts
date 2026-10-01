import { useQuery } from '@tanstack/react-query'
import { lookupsService } from '@/api/lookups'
import { queryKeys } from '@/api/query-keys'

// Module / ACL-role / permission definitions are static reference data — they
// don't change during a session. Cache them indefinitely so switching between
// permission-grid module tabs doesn't refetch (and flicker) each time.
const LOOKUP_OPTS = { staleTime: Infinity, gcTime: Infinity } as const

export function useModules() {
  return useQuery({
    queryKey: queryKeys.lookups.modules,
    queryFn: () => lookupsService.modules(),
    ...LOOKUP_OPTS,
  })
}

export function useAcl() {
  return useQuery({
    queryKey: queryKeys.lookups.acl,
    queryFn: () => lookupsService.acl(),
    ...LOOKUP_OPTS,
  })
}

export function usePermissions() {
  return useQuery({
    queryKey: queryKeys.lookups.permissions,
    queryFn: () => lookupsService.permissions(),
    ...LOOKUP_OPTS,
  })
}

export function usePermissionsByModule(moduleCode: string) {
  return useQuery({
    queryKey: [...queryKeys.lookups.permissions, moduleCode],
    queryFn: () => lookupsService.permissions(moduleCode),
    enabled: !!moduleCode,
    ...LOOKUP_OPTS,
  })
}
