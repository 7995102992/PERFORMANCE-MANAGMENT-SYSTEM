import { useMemo } from 'react'
import {
  useGetMasterDataQuery,
  useGetCountriesQuery,
  useGetStatesQuery,
  useGetCitiesQuery,
  useGetCurrenciesQuery,
} from '@/store/api/iamApi'

export interface SelectOption {
  label: string
  value: string
}

const EMPTY: SelectOption[] = []

/**
 * Generic master-data options for a category, as `{ label, value }` ready for
 * SearchableSelect. `value` is the option's id — that is what the employee
 * payload stores, not the display string.
 */
export function useMasterOptions(
  category: string,
  organisationId?: string,
  includeInactive?: boolean,
): SelectOption[] {
  const { data } = useGetMasterDataQuery({
    category,
    ...(organisationId ? { organisation_id: organisationId } : {}),
    ...(includeInactive ? { include_inactive: true } : {}),
  })
  return useMemo(
    () => data?.map((d) => ({ label: d.value, value: d.id })) ?? EMPTY,
    [data],
  )
}

/** Countries — value is the country NAME, matching what addresses persist. */
export function useCountryOptions(): SelectOption[] {
  const { data } = useGetCountriesQuery({ limit: 300 })
  return useMemo(
    () => data?.map((c) => ({ label: c.name, value: c.name })) ?? EMPTY,
    [data],
  )
}

export function useStateOptions(countryName: string): SelectOption[] {
  const { data } = useGetStatesQuery(
    { country_name: countryName, limit: 300 },
    { skip: !countryName },
  )
  return useMemo(
    () => data?.map((s) => ({ label: s.name, value: s.name })) ?? EMPTY,
    [data],
  )
}

export function useCityOptions(countryName: string, stateName: string): SelectOption[] {
  const { data } = useGetCitiesQuery(
    { country_name: countryName, state_name: stateName || undefined, limit: 300 },
    { skip: !countryName },
  )
  return useMemo(
    () => data?.map((c) => ({ label: c.name, value: c.name })) ?? EMPTY,
    [data],
  )
}

/** Currencies as `{ label: "USD — US Dollar ($)", value: "USD" }`. */
export function useCurrencyOptions(countryName?: string): SelectOption[] {
  const { data } = useGetCurrenciesQuery(
    countryName ? { country_name: countryName } : undefined,
  )
  return useMemo(
    () =>
      data?.map((c) => ({
        label: c.currency_name
          ? `${c.currency} — ${c.currency_name}${c.currency_symbol ? ` (${c.currency_symbol})` : ''}`
          : c.currency,
        value: c.currency,
      })) ?? EMPTY,
    [data],
  )
}
