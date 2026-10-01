import { useQuery } from '@tanstack/react-query'
import { searchCompanies } from '@/api/external/google-places'
import { queryKeys } from '@/api/query-keys'

/**
 * Search for companies by name. Returns suggestions from Google Places.
 * Results cached for 5 minutes — repeat searches don't hit the API.
 */
export function useCompanySearch(query: string) {
  return useQuery({
    queryKey: queryKeys.companySearch(query),
    queryFn: () => searchCompanies(query),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,       // 5 minutes
    gcTime: 30 * 60 * 1000,         // 30 minutes in memory
  })
}
