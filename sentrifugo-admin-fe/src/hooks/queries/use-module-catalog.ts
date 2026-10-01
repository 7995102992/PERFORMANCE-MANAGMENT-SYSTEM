import { useQuery } from '@tanstack/react-query'
import { lookupsService } from '@/api/lookups'
import { queryKeys } from '@/api/query-keys'

export function useModuleCatalog() {
  return useQuery({
    queryKey: queryKeys.moduleCatalog,
    queryFn: () => lookupsService.getModules(),
    staleTime: 10 * 60 * 1000, // catalog rarely changes
  })
}
