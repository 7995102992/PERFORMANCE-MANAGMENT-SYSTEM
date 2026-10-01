import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchCompanyData } from '@/api/external/google-places'
import { queryKeys } from '@/api/query-keys'
import type { CompanyData } from '@/types/company'

/**
 * Imperatively fetch company details. TanStack Query handles caching.
 */
export function useFetchCompanyDetails() {
  const queryClient = useQueryClient()

  return async (
    id: string,
    source: 'google' | 'manual',
  ): Promise<CompanyData | null> => {
    if (source === 'manual') return null

    return queryClient.fetchQuery({
      queryKey: queryKeys.companyDetails(id),
      queryFn: () => fetchCompanyData(id, source),
      staleTime: Infinity,
    })
  }
}

/**
 * Reactive hook — useful if you want to observe fetching state.
 */
export function useCompanyDetails(id: string | null, source: 'google' | 'manual' | null) {
  return useQuery({
    queryKey: queryKeys.companyDetails(id ?? ''),
    queryFn: () => fetchCompanyData(id!, source as 'google'),
    enabled: !!id && source === 'google',
    staleTime: Infinity,
  })
}
