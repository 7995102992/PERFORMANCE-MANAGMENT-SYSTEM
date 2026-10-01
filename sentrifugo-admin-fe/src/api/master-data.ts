import { apiClient } from '@/lib/axios'

// ─── Response types ──────────────────────────────────────────────────────────

export interface CountryDTO {
  id: number
  name: string
  iso2?: string
  iso3?: string
  phone_code?: string
  capital?: string
  currency?: string
  currency_symbol?: string
  region?: string
  emoji?: string
}

export interface StateDTO {
  id: number
  name: string
  state_code?: string
  country_id?: number
  country_name?: string
  country_code?: string
}

export interface CityDTO {
  id: number
  name: string
  state_id?: number
  country_id?: number
  state_name?: string
  country_name?: string
}

export interface CurrencyDTO {
  currency: string
  currency_name?: string | null
  currency_symbol?: string | null
}

export interface TimezoneDTO {
  zoneName: string
  gmtOffset?: number | null
  gmtOffsetName?: string | null
  abbreviation?: string | null
  tzName?: string | null
}

export interface MasterDataOption {
  id: string
  key: string
  value: string
  category: string
  organisation_id?: string | null
  is_active: boolean
  is_custom: boolean
}

export interface MasterDataCreateDTO {
  category: string
  key: string
  value: string
  organisation_id: string
}

// ─── Service ─────────────────────────────────────────────────────────────────

export const masterDataService = {
  /** GET /master-data?category=sectors&organisation_id=xxx */
  async listByCategory(category: string, organisationId?: string, includeInactive?: boolean): Promise<MasterDataOption[]> {
    const { data } = await apiClient.get<MasterDataOption[]>('/master-data/', {
      params: {
        category,
        ...(organisationId ? { organisation_id: organisationId } : {}),
        ...(includeInactive ? { include_inactive: true } : {}),
      },
    })
    return data
  },

  /** POST /master-data */
  async create(payload: MasterDataCreateDTO): Promise<MasterDataOption> {
    const { data } = await apiClient.post<MasterDataOption>('/master-data', payload)
    return data
  },

  /** DELETE /master-data/{id} */
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/master-data/${id}`)
  },

  /** GET /master-data/countries?search=&skip=&limit= */
  async searchCountries(search?: string, skip = 0, limit = 20) {
    const { data } = await apiClient.get<CountryDTO[]>('/master-data/countries', {
      params: { search: search || undefined, skip, limit },
    })
    return data
  },

  /** GET /master-data/countries/{id} */
  async getCountryById(id: number) {
    const { data } = await apiClient.get<CountryDTO>(`/master-data/countries/${id}`)
    return data
  },

  /** GET /master-data/states?search=&country_name=&skip=&limit= */
  async searchStates(params: { search?: string; country_id?: number; country_name?: string; skip?: number; limit?: number }) {
    const { data } = await apiClient.get<StateDTO[]>('/master-data/states', { params })
    return data
  },

  /** GET /master-data/states/{id} */
  async getStateById(id: number) {
    const { data } = await apiClient.get<StateDTO>(`/master-data/states/${id}`)
    return data
  },

  /** GET /master-data/cities?search=&state_name=&country_name=&skip=&limit= */
  async searchCities(params: { search?: string; state_id?: number; state_name?: string; country_id?: number; country_name?: string; skip?: number; limit?: number }) {
    const { data } = await apiClient.get<CityDTO[]>('/master-data/cities', { params })
    return data
  },

  /** GET /master-data/currencies?country_id=&country_name= */
  async listCurrencies(params?: { country_id?: number; country_name?: string }) {
    const { data } = await apiClient.get<CurrencyDTO[]>('/master-data/currencies', { params })
    return data
  },

  /** GET /master-data/timezones?country_id=&country_name= */
  async listTimezones(params?: { country_id?: number; country_name?: string }) {
    const { data } = await apiClient.get<TimezoneDTO[]>('/master-data/timezones', { params })
    return data
  },
}
