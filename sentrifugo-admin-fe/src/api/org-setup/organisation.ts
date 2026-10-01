import { apiClient } from '@/lib/axios'
import { assetService } from '@/api/assets'
import type {
  AddressCreateDTO,
  OrganisationUpdateDTO,
  OrganisationResponseDTO,
} from './types'
import type { OrganisationFormValues } from '@/modules/org-setup/types/organisation'

// ─── Raw CRUD (matches BE 1:1) ───────────────────────────────────────────────

export const organisationService = {
  /** GET /organisations/ — returns the caller's organisation (org admin: from token) */
  async list(): Promise<OrganisationResponseDTO[]> {
    const { data } = await apiClient.get<OrganisationResponseDTO>('/organisations/')
    return [data]
  },

  /** GET /organisations/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<OrganisationResponseDTO>(`/organisations/${id}`)
    return data
  },

  /** PUT /organisations/{id} */
  async update(id: string, payload: OrganisationUpdateDTO) {
    const { data } = await apiClient.put<OrganisationResponseDTO>(`/organisations/${id}`, payload)
    return data
  },

  /** DELETE /organisations/{id} */
  async remove(id: string) {
    await apiClient.delete(`/organisations/${id}`)
  },
}

// ─── Form → save helper ─────────────────────────────────────────────────────

interface SaveOrganisationInput {
  organisationId?: string
  values: OrganisationFormValues
  existingLogoAssetId?: string | null
}

function buildAddress(values: OrganisationFormValues): AddressCreateDTO {
  return {
    country: values.country,
    state: values.state ?? '',
    city: values.city,
    zip_code: values.zipCode || null,
    address_line_1: values.addressLine1,
    address_line_2: values.addressLine2 || null,
  }
}

export async function saveOrganisation(input: SaveOrganisationInput): Promise<OrganisationResponseDTO> {
  const { values, existingLogoAssetId } = input

  let logoAssetId: string | null = existingLogoAssetId ?? null
  if (values.logoFile instanceof File) {
    const asset = await assetService.upload(values.logoFile, 'org-logos')
    logoAssetId = asset.id
  }

  const updatePayload: OrganisationUpdateDTO = {
    legal_name: values.legalName,
    address: buildAddress(values),
    date_of_incorporation: values.dateOfIncorporation || undefined,
    financial_year: values.financialYear || null,
    currency: values.currency || null,
    timezone: values.timezone || null,
    logo_asset_id: logoAssetId,
  }
  return organisationService.update(input.organisationId!, updatePayload)
}

// ─── Reverse mapper: BE response → form values (for editing) ─────────────────

export function organisationToFormValues(org: OrganisationResponseDTO): OrganisationFormValues {
  return {
    legalName: org.legal_name,
    logoFile: null, // Will be hydrated from logo_url if needed
    country: org.address?.country ?? '',
    state: org.address?.state ?? '',
    addressLine1: org.address?.address_line_1 ?? '',
    addressLine2: org.address?.address_line_2 ?? '',
    city: org.address?.city ?? '',
    zipCode: org.address?.zip_code ?? '',
    dateOfIncorporation: org.date_of_incorporation
      ? org.date_of_incorporation.substring(0, 10)
      : '',
    financialYear: org.financial_year ?? '',
    currency: org.currency ?? '',
    timezone: org.timezone ?? '',
  }
}
