import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { masterDataService } from '@/api/master-data'
import type { MasterDataCreateDTO } from '@/api/master-data'
import { toast } from '@/lib/toast'

/**
 * Load all countries — small dataset (~250), load once, combobox filters client-side.
 * Returns { label, value } options ready for SearchableSelect.
 */
export function useCountries() {
  return useQuery({
    queryKey: ['master-data', 'countries'],
    queryFn: () => masterDataService.searchCountries('', 0, 300),
    staleTime: 30 * 60 * 1000, // 30 min — countries don't change
    // Keep iso2/iso3 alongside the {label,value} so callers can resolve a
    // country whether an external source (e.g. Google Places) returns the
    // full name or an ISO code.
    select: (data) =>
      data.map((c) => ({ label: c.name, value: c.name, iso2: c.iso2, iso3: c.iso3 })),
  })
}

/**
 * Load states for a given country name.
 * Loads all states for that country at once (~50-100), combobox filters client-side.
 */
export function useStates(countryName: string) {
  return useQuery({
    queryKey: ['master-data', 'states', countryName],
    queryFn: () => masterDataService.searchStates({
      country_name: countryName,
      limit: 200,
    }),
    enabled: !!countryName,
    staleTime: 30 * 60 * 1000,
    select: (data) => data.map((s) => ({ label: s.name, value: s.name })),
  })
}

/**
 * Load cities for a given state + country.
 */
export function useCities(countryName: string, stateName: string) {
  return useQuery({
    queryKey: ['master-data', 'cities', countryName, stateName],
    queryFn: () => masterDataService.searchCities({
      country_name: countryName,
      state_name: stateName || undefined,
      limit: 300,
    }),
    enabled: !!countryName,
    staleTime: 30 * 60 * 1000,
    select: (data) => data.map((c) => ({ label: c.name, value: c.name })),
  })
}

/**
 * Currencies — optionally filtered by country name. Empty country = all currencies.
 * Returns { label: "USD — US Dollar ($)", value: "USD" } options.
 */
export function useCurrencies(countryName?: string) {
  return useQuery({
    queryKey: ['master-data', 'currencies', countryName ?? 'all'],
    queryFn: () => masterDataService.listCurrencies(
      countryName ? { country_name: countryName } : undefined,
    ),
    staleTime: 30 * 60 * 1000,
    select: (data) => data.map((c) => ({
      label: c.currency_name
        ? `${c.currency} — ${c.currency_name}${c.currency_symbol ? ` (${c.currency_symbol})` : ''}`
        : c.currency,
      value: c.currency,
    })),
  })
}

/**
 * Timezones — optionally filtered by country name. Empty country = all timezones.
 * Returns { label: "Asia/Kolkata (GMT+05:30)", value: "Asia/Kolkata" } options.
 */
export function useTimezones(countryName?: string) {
  return useQuery({
    queryKey: ['master-data', 'timezones', countryName ?? 'all'],
    queryFn: () => masterDataService.listTimezones(
      countryName ? { country_name: countryName } : undefined,
    ),
    staleTime: 30 * 60 * 1000,
    select: (data) => data.map((tz) => ({
      label: tz.gmtOffsetName ? `${tz.zoneName} (${tz.gmtOffsetName})` : tz.zoneName,
      value: tz.zoneName,
    })),
  })
}

/**
 * Generic master data hook — fetches options by category + org scope.
 * Returns { label, value } options ready for SearchableSelect.
 */
export function useMasterData(category: string, organisationId?: string, includeInactive?: boolean) {
  return useQuery({
    queryKey: ['master-data', 'options', category, organisationId ?? 'global', includeInactive ? 'all' : 'active'],
    queryFn: () => masterDataService.listByCategory(category, organisationId, includeInactive),
    staleTime: 30 * 60 * 1000,
    select: (data) => data.map((d) => ({ label: d.value, value: d.id, isActive: d.is_active })),
  })
}

export function useCreateMasterData() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: MasterDataCreateDTO) => masterDataService.create(payload),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['master-data', 'options', data.category] })
      toast.success('Option added successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteMasterData() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => masterDataService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-data', 'options'] })
      toast.success('Option deleted successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}
