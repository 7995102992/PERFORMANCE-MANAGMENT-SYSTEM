import type { AclLevel } from '@/lib/permissions'

// ─── Master Data ─────────────────────────────────────────────────────────────

export interface AssetResponse {
  id: string
  file_name: string
  file_size: number
  mime_type: string
  file_url: string
  folder: string
  is_active: boolean
}

// ─── Business Units ────────────────────────────────────────────────────────────

export interface AddressResponse {
  id: string
  country: string
  state: string
  city: string
  address_line_1: string
  address_line_2?: string | null
  zip_code?: string | null
}

export interface BusinessUnitResponse {
  id: string
  business_unit_name: string
  emp_code_prefix: string
  date_of_incorporation: string
  address_id: string
  address?: AddressResponse | null
  organisation_id?: string | null
  head_user_id?: string | null
  head_employee_name?: string | null
  ein?: string | null
  sector?: string | null
  type_of_business?: string | null
  nature_of_business?: string | null
  financial_year?: string | null
  currency?: string | null
  time_zone?: string | null
  time_format?: string | null
  is_active: boolean
}

export interface BusinessUnitListParams {
  skip?: number
  limit?: number
  search?: string
  q?: string
  organisation_id?: string | null
  is_active?: boolean
}

// ─── Departments ───────────────────────────────────────────────────────────────

export interface DepartmentResponse {
  id: string
  departmentName: string
  businessUnits: string[]
  businessUnitNames?: string[]
  primaryBusinessUnit?: string | null
  primaryBusinessUnitData?: { _id: string; businessUnitName: string } | null
  organisationId?: string | null
  departmentCode?: string | null
  description?: string | null
  departmentHead?: string | null
  departmentHeadName?: string | null
  is_active: boolean
}

export interface DepartmentListParams {
  business_unit_ids?: string[]
  skip?: number
  limit?: number
  search?: string
  q?: string
  organisation_id?: string | null
  is_active?: boolean
}

// ─── Master Data (Countries / States / Cities) ─────────────────────────────────

export interface CountryResponse {
  id: number
  name: string
  iso2?: string
  iso3?: string
  phone_code?: string
  currency?: string
  currency_symbol?: string
}

export interface StateResponse {
  id: number
  name: string
  country_id: number
  country_name?: string
  country_code?: string
}

export interface CityResponse {
  id: number
  name: string
  state_id: number
  state_name?: string
  country_id?: number
  country_name?: string
}

export interface StateListParams {
  country_id?: number | null
  country_name?: string | null
  search?: string | null
  skip?: number
  limit?: number
}

export interface CityListParams {
  state_id?: number | null
  state_name?: string | null
  country_id?: number | null
  country_name?: string | null
  search?: string | null
  skip?: number
  limit?: number
}

// ─── Designations ─────────────────────────────────────────────────────────────

export interface DesignationResponse {
  id: string
  designationName: string
  departmentId: string
  organisationId?: string
  hierarchyRole?: { _id: string; category: string; key: string; value: string } | null
  is_active: boolean
}

export interface DesignationListParams {
  department_id?: string
  department_ids?: string[]
  skip?: number
  limit?: number
  search?: string
  is_active?: boolean
}

// ─── Master Data (Generic) ────────────────────────────────────────────────────

export interface MasterDataOption {
  id: string
  key: string
  value: string
  category: string
  organisation_id?: string | null
  is_active: boolean
  is_custom: boolean
}

export interface MasterDataListParams {
  category: string
  organisation_id?: string
  /** Include options flagged inactive (e.g. Exit / Retired employment statuses). */
  include_inactive?: boolean
}

// ─── Employees ────────────────────────────────────────────────────────────────

export interface EmployeeListParams {
  business_unit_ids?: string[]
  department_ids?: string[]
  designation_ids?: string[]
  role_ids?: string[]
  employment_status?: string
  employment_type_id?: string
  project_status?: string
  has_policies?: boolean
  skip?: number
  limit?: number
  search?: string
  is_active?: boolean
}

export interface MasterDataCompact {
  _id: string
  category: string
  key: string
  value: string
  isActive?: boolean
}

export interface BankDetailsDTO {
  accountHolderName?: string | null
  accountNumber?: string | null
  ifscCode?: string | null
  bankName?: string | null
}

export interface DependentRowDTO {
  name: string
  relationship: string
  dateOfBirth?: string | null
}

export interface EmergencyContactDTO {
  contactName: string
  contactNumber: string
  relationship: string
}

export interface EducationRowDTO {
  instituteName: string
  degree: string
  specialization?: string | null
  dateOfCompletion?: string | null
}

export interface WorkExperienceRowDTO {
  companyName: string
  jobTitle: string
  fromDate?: string | null
  toDate?: string | null
  jobDescription?: string | null
  relevant?: string | null
}

export interface IdentityFieldDTO {
  label: string
  value: string
}

export interface CtcHistoryEntry {
  /** Legacy alias kept for existing readers; the API sends `amount`. */
  value?: number | null
  amount?: number | null
  /** Currency this CTC value was set in. */
  currency?: string | null
  updatedOn?: string | null
}

export interface EmployeeResponse {
  id: string
  userId?: string | null
  user_id?: string | null
  empCode: string
  emp_code?: string
  firstName: string
  first_name: string
  middleName?: string | null
  lastName: string
  last_name: string
  workEmail: string
  work_email?: string
  businessUnitId: string
  businessUnitName?: string
  departmentId: string
  departmentName?: string
  department_name?: string
  designationId: string
  designationName?: string
  designation_name?: string
  l1ManagerId?: string | null
  l1ManagerName?: string | null
  l1ManagerEmail?: string | null
  l2ManagerId?: string | null
  l2ManagerName?: string | null
  employmentType?: MasterDataCompact | null
  employmentStatus?: MasterDataCompact | null
  /** Where the employee works from (remote-client-location / remote-work-from-home / hybrid). */
  workType?: string | null
  projectStatus?: MasterDataCompact | null
  sourceOfHire?: MasterDataCompact | null
  dateOfJoining?: string | null
  dateOfExit?: string | null
  dob?: string | null
  gender?: MasterDataCompact | null
  maritalStatus?: MasterDataCompact | null
  currentExp?: number | null
  totalExp?: number | null
  ctc?: number | null
  currency?: string | null
  ctcHistory?: CtcHistoryEntry[]
  aboutMe?: string | null
  seatLocation?: string | null
  workPhone?: string | null
  personalPhone?: string | null
  personalEmail?: string | null
  bankDetails?: BankDetailsDTO | null
  identityFields?: IdentityFieldDTO[]
  emergencyContacts?: EmergencyContactDTO[]
  dependents?: DependentRowDTO[]
  education?: EducationRowDTO[]
  workExperience?: WorkExperienceRowDTO[]
  activationPending?: boolean
  workPhoneExtension?: string | null
  sameAsPermanent?: boolean
  permanentAddress?: AddressResponse | null
  presentAddress?: AddressResponse | null
  /** Roles (policies) assigned to the employee. The form edits the first. */
  policies?: { id: string; name: string }[]
}

// ─── Employee write DTOs (POST/PUT /employees) ────────────────────────────────

export interface AddressCreateDTO {
  country: string
  state: string
  city: string
  zip_code?: string | null
  address_line_1: string
  address_line_2?: string | null
}

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
  /** Where the employee works from (remote-client-location / remote-work-from-home / hybrid). */
  workType?: string | null
  projectStatus: string
  roleIds?: string[]
  dateOfJoining: string
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

/**
 * PUT /employees/{userId}. Only the keys sent are written (the API dumps with
 * `exclude_unset`), so a partial body never clears the fields it omits —
 * whereas an explicit `null` does clear the stored value.
 */
export type EmployeeUpdateDTO = Partial<
  Omit<EmployeeCreateDTO, 'personalEmail'>
> & {
  personalEmail?: string | null
}

// ─── Employee bulk upload ─────────────────────────────────────────────────────

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

// ─── Roles ────────────────────────────────────────────────────────────────────

export interface RoleResponse {
  id: string
  name: string
  key: string
  description?: string | null
  is_active: boolean
}

// ─── Employee Directory (GET /directory) ──────────────────────────────────────

/**
 * Colleague-facing employee record. Any authenticated user in the org may read
 * it, so it carries NO sensitive data — no CTC, bank details, date of birth or
 * personal contact. For the full HR record use GET /employees/{userId}.
 *
 * Every field except `userId` is nullable; render defensively.
 */
export interface DirectoryEmployee {
  /** Employee record id — unique per row. `userId` is NOT: a rehired employee
   *  has one user and several employee records, so keying a list on `userId`
   *  collapses those rows into one. Optional because it postdates the rest of
   *  this payload — treat a missing value as an older API. */
  id?: string | null
  userId: string
  empCode?: string | null
  firstName?: string | null
  middleName?: string | null
  lastName?: string | null
  fullName?: string | null
  email?: string | null
  workPhone?: string | null
  workPhoneExtension?: string | null
  avatarUrl?: string | null
  avatarAssetId?: string | null
  /** Flat display names, not ids — nothing to resolve client-side. */
  businessUnit?: string | null
  department?: string | null
  designation?: string | null
  l1Manager?: string | null
  l2Manager?: string | null
  employmentType?: string | null
  employmentStatus?: string | null
  dateOfJoining?: string | null
  seatLocation?: string | null
}

export interface DirectoryListParams {
  /** Matches name, employee code or email. */
  search?: string
  /** Comma-separated ids. */
  businessUnitIds?: string
  departmentIds?: string
  /** Omit/false → active employees only (the default). True → active + inactive. */
  includeInactive?: boolean
  skip?: number
  /** Default 20, max 200. */
  limit?: number
}

export interface DirectoryListResponse {
  items: DirectoryEmployee[]
  total: number
  skip: number
  limit: number
}

/**
 * GET /employees/resources — what the caller may do on the `/employees` routes,
 * answered by the same guard chain that enforces them.
 *
 * Saves the FE re-deriving the answer from the `/me` grid and getting the
 * thresholds subtly wrong: the flags map onto the exact levels the router binds
 * its guards at, so `canEdit: true` means PUT genuinely succeeds.
 *
 * The route sits behind the router's viewer guard, so an ungranted caller gets
 * a 403 rather than an all-false body — `canView` is true in every 200.
 */
export interface EmployeeAccessResponse {
  module: string
  code: string
  granted: boolean
  /** viewer | editor | admin; null when ungranted. */
  level: AclLevel | null
  can_view: boolean
  can_edit: boolean
  can_delete: boolean
}

// ─── Org graph (GET /graph/*) ────────────────────────────────────────────────
// Neo4j-backed projection. HR-only (core_hr / create_resource), org-scoped.
// NB: every id here is an EMPLOYEE record id (EmployeeResponse.id), NOT a
// user id — chain `employee_id` from one response into the next.
// A 503 means the graph store is down, which is NOT the same as "no data".

export interface OrgStructureDepartment {
  id: string
  name: string
}

export interface OrgStructureBusinessUnit {
  business_unit_id: string
  business_unit: string | null
  /** Head's display name; null when the BU has no linked head. */
  head: string | null
  departments: OrgStructureDepartment[]
}

/** A person node in the reporting chart. `name` is null for unlinked users. */
export interface GraphPerson {
  employee_id: string
  emp_code: string | null
  name: string | null
}

/** Reporting chain entry — level 0 is the person, increasing toward the top. */
export interface GraphChainEntry extends GraphPerson {
  level: number
}

/**
 * GET /graph/org-tree — the whole active-employee hierarchy, already nested.
 * One call replaces node-by-node direct-reports expansion.
 *
 * Active employees only. Usually a single root, but an active employee whose
 * L1 manager is inactive or absent surfaces as an extra root — so this is a
 * LIST of roots, not one. Children arrive sorted by name.
 */
export interface OrgTreeNode {
  employee_id: string
  emp_code: string | null
  name: string | null
  designation: string | null
  /** Null on a root. Present on every node, so the tree can also be flattened. */
  manager_id: string | null
  children: OrgTreeNode[]
}
