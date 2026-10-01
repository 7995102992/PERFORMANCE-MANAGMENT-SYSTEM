import { apiClient } from '@/lib/axios'
import type { AddressCreateDTO, AddressResponseDTO, MasterDataCompactDTO } from './types'

// ─── Sub-types ──────────────────────────────────────────────────────────────

export interface BankDetailsDTO {
  accountHolderName?: string | null
  accountNumber?: string | null
  ifscCode?: string | null
  bankName?: string | null
}

export interface IdentityFieldDTO {
  label: string
  value: string
}

export interface WorkExperienceRowDTO {
  companyName: string
  jobTitle: string
  fromDate?: string | null
  toDate?: string | null
  jobDescription?: string | null
  relevant?: string | null
}

export interface DependentRowDTO {
  name: string
  relationship: string
  dateOfBirth?: string | null
}

export interface EducationRowDTO {
  instituteName: string
  degree: string
  specialization?: string | null
  dateOfCompletion?: string | null
}

export interface EmergencyContactDTO {
  contactName: string
  contactNumber: string
  relationship: string
}

/** A past CTC revision. Returned read-only; the current value stays on `ctc`. */
export interface CtcHistoryEntryDTO {
  amount?: number | null
  currency?: string | null    // currency this CTC value was set in
  updatedOn?: string | null   // timestamp this CTC value was set
}

// ─── Employee DTOs ──────────────────────────────────────────────────────────

export interface EmployeeCreateDTO {
  // emp_code is auto-generated server-side (BU prefix + counter)
  workEmail: string
  firstName: string
  middleName?: string | null
  lastName: string
  businessUnitId: string
  departmentId: string
  designationId: string
  sourceOfHire?: string | null
  l1ManagerId?: string | null
  l2ManagerId?: string | null
  currentExp?: number | null
  totalExp?: number | null
  employmentType: string
  employmentStatus: string
  projectStatus: string
  roleIds?: string[]                          // assigned role (policy) ids
  dateOfJoining: string                       // ISO YYYY-MM-DD
  dateOfExit?: string | null
  ctc?: number | null
  currency?: string | null
  dob: string
  gender: string
  maritalStatus?: string | null
  aboutMe?: string | null
  bankDetails?: BankDetailsDTO | null
  identityFields: IdentityFieldDTO[]
  workPhoneExtension?: string | null
  workPhone?: string | null
  personalPhone: string
  personalEmail: string
  seatLocation?: string | null
  permanentAddress: AddressCreateDTO
  presentAddress: AddressCreateDTO
  sameAsPermanent: boolean
  emergencyContacts: EmergencyContactDTO[]
  workExperience: WorkExperienceRowDTO[]
  dependents: DependentRowDTO[]
  education: EducationRowDTO[]
}

export type EmployeeUpdateDTO = Partial<EmployeeCreateDTO>

export interface EmployeeResponseDTO extends Omit<EmployeeCreateDTO, 'sourceOfHire' | 'employmentType' | 'employmentStatus' | 'projectStatus' | 'gender' | 'maritalStatus' | 'permanentAddress' | 'presentAddress'> {
  id: string
  empCode: string
  userId?: string | null
  permanentAddressId: string
  presentAddressId: string
  permanentAddress: AddressResponseDTO
  presentAddress: AddressResponseDTO
  sameAsPermanent: boolean
  businessUnitName?: string | null
  departmentName?: string | null
  designationName?: string | null
  l1ManagerName?: string | null
  l1ManagerEmail?: string | null
  l1ManagerEmpCode?: string | null
  l2ManagerName?: string | null
  l2ManagerEmail?: string | null
  l2ManagerEmpCode?: string | null
  policies: { id: string; name: string }[]
  /** True when the linked account has never been activated → eligible for resend. */
  activationPending?: boolean
  sourceOfHire?: MasterDataCompactDTO | null
  employmentType: MasterDataCompactDTO
  employmentStatus: MasterDataCompactDTO
  projectStatus?: MasterDataCompactDTO | null
  gender: MasterDataCompactDTO
  maritalStatus?: MasterDataCompactDTO | null
  /** Prior CTC revisions, newest-last. Current amount is on `ctc`. */
  ctcHistory?: CtcHistoryEntryDTO[]
}

export interface EmployeeListParams {
  skip?: number
  limit?: number
  search?: string
  businessUnitIds?: string[]
  departmentIds?: string[]
  designationIds?: string[]
  employmentStatus?: string
  projectStatus?: string
  hasPolicies?: boolean
}

// ─── Bulk upload DTOs ───────────────────────────────────────────────────────

export interface BulkRowError {
  field: string
  message: string
}

export interface BulkRowResult {
  row_num: number
  status: 'valid' | 'error' | 'duplicate' | 'empty'
  parsed: Record<string, unknown> | null
  errors: BulkRowError[]
}

export interface BulkValidateResult {
  total_rows: number
  valid_count: number
  error_count: number
  duplicate_count: number
  file_errors: string[]
  rows: BulkRowResult[]
}

export interface BulkUploadResult {
  total: number
  successful: number
  failed: number
  errors: { row_num: number; message: string }[]
  created_ids: string[]
}

// ─── Service ────────────────────────────────────────────────────────────────

export const employeesService = {
  /** GET /employees/ */
  async list(params?: EmployeeListParams) {
    const { businessUnitIds, departmentIds, designationIds, employmentStatus, projectStatus, hasPolicies, ...rest } = params ?? {}
    const { data } = await apiClient.get<EmployeeResponseDTO[]>('/employees/', {
      params: {
        ...(businessUnitIds?.length ? { business_unit_ids: businessUnitIds.join(',') } : {}),
        ...(departmentIds?.length ? { department_ids: departmentIds.join(',') } : {}),
        ...(designationIds?.length ? { designation_ids: designationIds.join(',') } : {}),
        ...(employmentStatus ? { employment_status: employmentStatus } : {}),
        ...(projectStatus ? { project_status: projectStatus } : {}),
        ...(hasPolicies != null ? { has_policies: hasPolicies } : {}),
        ...rest,
      },
    })
    return data
  },

  /** GET /employees/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<EmployeeResponseDTO>(`/employees/${id}`)
    return data
  },

  /** POST /employees/ */
  async create(payload: EmployeeCreateDTO) {
    const { data } = await apiClient.post<EmployeeResponseDTO>('/employees/', payload)
    return data
  },

  /** PUT /employees/{id} */
  async update(id: string, payload: EmployeeUpdateDTO) {
    const { data } = await apiClient.put<EmployeeResponseDTO>(`/employees/${id}`, payload)
    return data
  },

  /** DELETE /employees/{id} */
  async remove(id: string) {
    await apiClient.delete(`/employees/${id}`)
  },

  // ─── Bulk ──────────────────────────────────────────────────────────────

  /** GET /employees/bulk-template — streams an .xlsx file */
  async downloadTemplate(): Promise<Blob> {
    const { data } = await apiClient.get('/employees/bulk-template', {
      responseType: 'blob',
    })
    return data as Blob
  },

  /** POST /employees/bulk-validate */
  async bulkValidate(file: File): Promise<BulkValidateResult> {
    const form = new FormData()
    form.append('file', file)
    const { data } = await apiClient.post<BulkValidateResult>('/employees/bulk-validate', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    })
    return data
  },

  /** POST /employees/bulk-upload — selected_row_nums is a query param */
  async bulkUpload(file: File, selectedRowNums?: number[]): Promise<BulkUploadResult> {
    const form = new FormData()
    form.append('file', file)
    const params = selectedRowNums?.length
      ? { selected_row_nums: JSON.stringify(selectedRowNums) }
      : undefined
    const { data } = await apiClient.post<BulkUploadResult>('/employees/bulk-upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
      params,
    })
    return data
  },
}
