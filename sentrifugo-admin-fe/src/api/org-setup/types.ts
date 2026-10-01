// Backend DTOs — match IAM Admin BE schema shapes (snake_case)
// These mirror Pydantic models 1:1

// ─── Address ──────────────────────────────────────────────────────────────────

export interface AddressCreateDTO {
  country: string
  state: string
  city: string
  zip_code?: string | null
  address_line_1: string
  address_line_2?: string | null
}

export interface AddressUpdateDTO {
  country?: string
  state?: string
  city?: string
  zip_code?: string | null
  address_line_1?: string
  address_line_2?: string | null
}

export interface AddressResponseDTO {
  id: string
  country: string
  state: string
  city: string
  zip_code?: string | null
  address_line_1: string
  address_line_2?: string | null
}

// ─── Organisation ─────────────────────────────────────────────────────────────

export interface OrganisationCreateDTO {
  legal_name: string
  address: AddressCreateDTO
  date_of_incorporation: string   // ISO date YYYY-MM-DD
  financial_year?: string | null
  currency?: string | null
  timezone?: string | null
  logo_asset_id?: string | null
  is_multiple_business_units: boolean
  is_active?: boolean
}

export interface OrganisationUpdateDTO {
  legal_name?: string
  head_user_id?: string | null
  address?: AddressCreateDTO
  date_of_incorporation?: string
  financial_year?: string | null
  currency?: string | null
  timezone?: string | null
  logo_asset_id?: string | null
  is_multiple_business_units?: boolean
  is_active?: boolean
  setup_status?: 'draft' | 'pending' | 'active'
  enabled_modules?: import('@/api/super-admin/types').OrgModule[]
}

export type SetupStepStatus = 'locked' | 'pending' | 'completed'

export type SetupProgressDTO = Record<string, SetupStepStatus>

export interface OrganisationResponseDTO {
  id: string
  legal_name: string
  address_id: string
  head_user_id?: string | null
  date_of_incorporation: string
  financial_year?: string | null
  currency?: string | null
  timezone?: string | null
  logo_asset_id?: string | null
  logo_url?: string | null
  is_multiple_business_units: boolean
  is_active: boolean
  address?: AddressResponseDTO
  head_employee_name?: string | null
  setup_status?: 'draft' | 'pending' | 'active' | null
  setup_progress?: SetupProgressDTO
  enabled_modules?: import('@/api/super-admin/types').OrgModule[]
}

// ─── Master Data Compact (resolved via $lookup) ─────────────────────────────

export interface MasterDataCompactDTO {
  _id: string
  category: string
  key: string
  value: string
  isActive: boolean
}

// ─── Business Unit ────────────────────────────────────────────────────────────

export interface EmpCodeStartFromDTO {
  // Digit strings — leading zeros define the zero-pad width ("006").
  fullTime: string
  contract: string
  internship: string
}

export interface BusinessUnitCreateDTO {
  head_user_id?: string | null
  address: AddressCreateDTO
  business_unit_name: string
  emp_code_prefix: string
  empCodeStartFrom?: EmpCodeStartFromDTO | null
  ein?: string | null
  sector?: string | null
  type_of_business?: string | null
  nature_of_business?: string | null
  date_of_incorporation: string
  financial_year?: string | null
  currency?: string | null
  time_zone?: string | null
  time_format?: string | null
  isSubsidiary?: boolean
  is_active?: boolean
}

export interface BusinessUnitUpdateDTO {
  head_user_id?: string | null
  address?: AddressCreateDTO
  business_unit_name?: string
  emp_code_prefix?: string
  empCodeStartFrom?: EmpCodeStartFromDTO | null
  ein?: string | null
  sector?: string | null
  type_of_business?: string | null
  nature_of_business?: string | null
  date_of_incorporation?: string
  financial_year?: string | null
  currency?: string | null
  time_zone?: string | null
  time_format?: string | null
  isSubsidiary?: boolean
  is_active?: boolean
}

export interface BusinessUnitResponseDTO {
  id: string
  organisation_id: string
  head_user_id?: string | null
  address_id: string
  business_unit_name: string
  emp_code_prefix?: string | null
  empCodeStartFrom?: { F: string; C: string; I: string } | null
  hasEmployees?: boolean
  ein?: string | null
  sector?: MasterDataCompactDTO | null
  type_of_business?: MasterDataCompactDTO | null
  nature_of_business?: MasterDataCompactDTO | null
  date_of_incorporation: string
  financial_year?: string | null
  currency?: string | null
  time_zone?: string | null
  time_format?: string | null
  isSubsidiary?: boolean
  is_active: boolean
  address?: AddressResponseDTO
  head_employee_name?: string | null
  head_emp_code?: string | null
}

// ─── Department (BE uses Pydantic aliases → camelCase in JSON) ───────────────

export interface DepartmentCreateDTO {
  businessUnits: string[]
  primaryBusinessUnit?: string | null
  departmentName: string
  departmentCode?: string | null
  description?: string | null
  departmentHead?: string | null
  is_active?: boolean
}

export interface DepartmentUpdateDTO {
  businessUnits?: string[]
  primaryBusinessUnit?: string | null
  departmentName?: string
  departmentCode?: string | null
  description?: string | null
  departmentHead?: string | null
  is_active?: boolean
}

export interface DepartmentResponseDTO {
  id: string
  organisationId: string
  businessUnits: string[]
  primaryBusinessUnit?: string | null
  primaryBusinessUnitData?: { _id: string; businessUnitName: string } | null
  businessUnitNames?: string[]
  departmentName: string
  departmentCode?: string | null
  description?: string | null
  departmentHead?: string | null
  departmentHeadName?: string | null
  is_active: boolean
}

// ─── Band (BE uses Pydantic aliases → camelCase in JSON) ─────────────────────

export interface BandCreateDTO {
  name: string
  // classLabel: string
  // frequency: string
  currency?: string | null
  minAmount?: number | null
  maxAmount?: number | null
  effectiveFrom?: string | null   // ISO date YYYY-MM-DD
  effectiveTo?: string | null     // ISO date YYYY-MM-DD
  notes?: string | null
  is_active?: boolean
}

export interface BandUpdateDTO {
  name?: string
  // classLabel?: string
  // frequency?: string
  currency?: string
  minAmount?: number
  maxAmount?: number
  effectiveFrom?: string | null
  effectiveTo?: string | null
  notes?: string | null
  is_active?: boolean
}

export interface BandResponseDTO {
  id: string
  organisationId: string
  name: string
  // classLabel?: MasterDataCompactDTO | null
  // frequency?: MasterDataCompactDTO | null
  currency?: string | null
  minAmount?: number | null
  maxAmount?: number | null
  effectiveFrom?: string | null
  effectiveTo?: string | null
  notes?: string | null
  is_active: boolean
}

// ─── Designation (BE uses Pydantic aliases → camelCase in JSON) ──────────────

export interface DesignationCreateDTO {
  designationName: string
  description?: string
  payGradeIds?: string[]
  is_active?: boolean
}

export interface DesignationUpdateDTO {
  designationName?: string
  description?: string
  payGradeIds?: string[]
  is_active?: boolean
}

export interface DesignationPayGradeCompactDTO {
  _id: string
  name: string
}

export interface DesignationResponseDTO {
  id: string
  organisationId: string
  designationName: string
  description?: string
  payGradeIds?: string[]
  payGrades?: DesignationPayGradeCompactDTO[]
  is_active: boolean
}

// ─── Pay Grade ───────────────────────────────────────────────────────────────

export interface PayGradeCreateDTO {
  name: string
  description?: string | null
  bandIds: string[]
  is_active?: boolean
}

export interface PayGradeUpdateDTO {
  name?: string
  description?: string | null
  bandIds?: string[]
  is_active?: boolean
}

export interface PayGradeResponseDTO {
  id: string
  organisationId: string
  name: string
  description?: string | null
  bandIds: string[]
  bandNames: string[]
  is_active: boolean
}

// ─── Policy ──────────────────────────────────────────────────────────────────

export interface PolicyListParams {
  skip?: number
  limit?: number
  is_active?: boolean
  search?: string
}

export interface PolicyResponseDTO {
  id: string
  name: string
  is_active: boolean
  is_role: boolean
  module_count: number
  created_on: string
  modified_on: string
}

export interface PolicyPaginatedResponse {
  items: PolicyResponseDTO[]
  total: number
  skip: number
  limit: number
}

export type PolicyPermissionsMap = Record<string, Record<string, Record<string, boolean>>>

export interface PolicyDetailResponseDTO {
  id: string
  name: string
  is_active: boolean
  is_role: boolean
  organisation_id: string
  seed_module_codes: string[]
  created_by: string
  created_on: string
  modified_by: string
  modified_on: string
}

export interface PolicyPermissionsResponseDTO {
  policy_id: string
  permissions: PolicyPermissionsMap
}

export interface PolicyCreateDTO {
  name: string
  is_active?: boolean
  is_role?: boolean
  organisation_id?: string | null
  seed_module_codes?: string[]
  permissions?: PolicyPermissionsMap
}

export interface PolicyUpdateDTO {
  name: string
  is_active?: boolean
  is_role?: boolean
}

export interface PolicyPermissionsUpdateDTO {
  permissions: PolicyPermissionsMap
}
// ─── Document Folders ───────────────────────────────────────────────────────

export interface FolderAccessDTO {
  business_units: string[]
  departments: string[]
  worker_types: string[]
}

export interface FolderCreateDTO {
  name: string
  description?: string | null
  custom_access?: boolean
  access?: FolderAccessDTO | null
}

export interface FolderUpdateDTO {
  name?: string
  description?: string | null
  custom_access?: boolean
  access?: FolderAccessDTO | null
  is_active?: boolean
}

export interface FolderResponseDTO {
  id: string
  organisation_id: string
  name: string
  description?: string | null
  custom_access: boolean
  access: FolderAccessDTO
  is_active: boolean
}

export interface BulkFolderCreateDTO {
  folders: Array<{
    name: string
    description?: string | null
    custom_access?: boolean
    access?: FolderAccessDTO | null
  }>
}

// ─── Org Documents ──────────────────────────────────────────────────────────

export interface OrgDocumentCreateDTO {
  folder_id: string
  title: string
  description?: string | null
  allow_download?: boolean
  require_acknowledgement?: boolean
  asset_id: string
}

export interface OrgDocumentUpdateDTO {
  title?: string
  description?: string | null
  allow_download?: boolean
  require_acknowledgement?: boolean
  asset_id?: string
  is_active?: boolean
}

export interface OrgDocumentResponseDTO {
  id: string
  organisation_id: string
  folder_id: string
  title: string
  description?: string | null
  allow_download: boolean
  require_acknowledgement: boolean
  asset_id: string
  is_active: boolean
  file_name?: string | null
  file_size?: number | null
  mime_type?: string | null
  file_url?: string | null
}

export interface BulkDocumentCreateDTO {
  documents: OrgDocumentCreateDTO[]
}
