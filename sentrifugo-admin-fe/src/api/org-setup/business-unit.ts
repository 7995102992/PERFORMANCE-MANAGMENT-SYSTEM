import { apiClient } from '@/lib/axios'
import type {
  AddressCreateDTO,
  BusinessUnitCreateDTO,
  BusinessUnitUpdateDTO,
  BusinessUnitResponseDTO,
} from './types'
import type { BusinessUnitFormValues } from '@/modules/org-setup/types/business-unit'

// ─── Raw CRUD (matches BE 1:1) ───────────────────────────────────────────────

export const businessUnitService = {
  /** GET /business-units/?skip=&limit=&search=&is_active=&is_subsidiary= */
  async list(params?: { skip?: number; limit?: number; search?: string; is_active?: boolean; is_subsidiary?: boolean }) {
    const { data } = await apiClient.get<BusinessUnitResponseDTO[]>('/business-units/', { params })
    return data
  },

  /** GET /business-units/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<BusinessUnitResponseDTO>(`/business-units/${id}`)
    return data
  },

  /** POST /business-units/ */
  async create(payload: BusinessUnitCreateDTO) {
    const { data } = await apiClient.post<BusinessUnitResponseDTO>('/business-units/', payload)
    return data
  },

  /** PUT /business-units/{id} */
  async update(id: string, payload: BusinessUnitUpdateDTO) {
    const { data } = await apiClient.put<BusinessUnitResponseDTO>(`/business-units/${id}`, payload)
    return data
  },

  /** DELETE /business-units/{id} */
  async remove(id: string) {
    await apiClient.delete(`/business-units/${id}`)
  },

  /** POST /business-units/bulk-delete */
  async bulkDelete(ids: string[]) {
    const { data } = await apiClient.post<{ deleted: number }>('/business-units/bulk-delete', { ids })
    return data
  },
}

// ─── Form → single-call save helper ──────────────────────────────────────────

interface SaveBusinessUnitInput {
  businessUnitId?: string
  headUserId?: string | null
  values: BusinessUnitFormValues
}

function buildAddress(values: BusinessUnitFormValues): AddressCreateDTO {
  return {
    country: values.country,
    state: values.state,
    city: values.city,
    zip_code: values.zipCode || null,
    address_line_1: values.addressLine1,
    address_line_2: values.addressLine2 || null,
  }
}

export async function saveBusinessUnit(input: SaveBusinessUnitInput): Promise<BusinessUnitResponseDTO> {
  const { values, businessUnitId, headUserId } = input

  const payload: BusinessUnitCreateDTO = {
    head_user_id: headUserId ?? null,
    address: buildAddress(values),
    business_unit_name: values.businessUnitName,
    emp_code_prefix: values.empCodePrefix.trim().toUpperCase(),
    empCodeStartFrom: {
      fullTime: values.empCodeStartFrom?.fullTime ?? "0",
      contract: values.empCodeStartFrom?.contract ?? "0",
      internship: values.empCodeStartFrom?.internship ?? "0",
    },
    ein: values.ein || null,
    sector: values.sector || null,
    type_of_business: values.typeOfBusiness || null,
    nature_of_business: values.natureOfBusiness || null,
    date_of_incorporation: values.dateOfIncorporation ? new Date(values.dateOfIncorporation).toISOString() : new Date().toISOString(),
    financial_year: values.financialYear || null,
    currency: values.currency || null,
    time_zone: values.timeZone || null,
    time_format: values.timeFormat || null,
    isSubsidiary: values.isSubsidiary ?? false,
    is_active: values.isActive ?? true,
  }

  if (businessUnitId) {
    return businessUnitService.update(businessUnitId, payload as BusinessUnitUpdateDTO)
  }
  return businessUnitService.create(payload)
}
