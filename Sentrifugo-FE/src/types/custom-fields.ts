export type CustomFieldType =
  | 'text' | 'textarea' | 'number' | 'date'
  | 'single_select' | 'multi_select' | 'radio' | 'checkbox'
  | 'file' | 'url' | 'email' | 'phone'

export type EntityType = 'organisation' | 'business_unit' | 'department' | 'employee' | 'exit_request'

export type SectionType =
  | 'default' | 'basic' | 'work' | 'personal' | 'identity'
  | 'contact' | 'emergency' | 'experience' | 'dependents' | 'education'
  | 'it_clearance' | 'admin_clearance' | 'finance_clearance'
  | 'manager_clearance' | 'hr_clearance'

export type FileTypeGroup = 'pdf' | 'word' | 'excel' | 'csv' | 'images'

export const OPTION_FIELD_TYPES: CustomFieldType[] = ['single_select', 'multi_select', 'radio', 'checkbox']

export interface FileSettings {
  max_size_mb: number
  allowed_file_types: FileTypeGroup[]
}

export interface CustomFieldDefinition {
  id: string
  organisation_id: string
  entity_type: EntityType
  section: SectionType
  name: string
  key: string
  field_type: CustomFieldType
  file_settings?: FileSettings | null
  placeholder?: string | null
  help_text?: string | null
  is_required: boolean
  sort_order: number
  is_active: boolean
}

export interface CustomFieldOption {
  id: string
  field_definition_id: string
  label: string
  value: string
  sort_order: number
  is_active: boolean
}

export interface CustomFieldValue {
  id: string
  field_definition_id: string
  value?: string | null
  option_ids: string[]
}

export interface FieldWithValue {
  definition: CustomFieldDefinition
  options: CustomFieldOption[]
  value: CustomFieldValue | null
}

export interface EntityValuesResponse {
  entity_id: string
  entity_type: EntityType
  fields: FieldWithValue[]
}

export interface DefinitionCreateDTO {
  entity_type: EntityType
  section?: SectionType
  name: string
  field_type: CustomFieldType
  file_settings?: FileSettings | null
  placeholder?: string | null
  help_text?: string | null
  is_required?: boolean
  sort_order?: number
}

export interface DefinitionUpdateDTO {
  name?: string
  field_type?: CustomFieldType
  section?: SectionType
  file_settings?: FileSettings | null
  placeholder?: string | null
  help_text?: string | null
  is_required?: boolean
  sort_order?: number
  is_active?: boolean
}

export interface OptionCreateDTO {
  label: string
  value: string
  sort_order?: number
}

export interface OptionUpdateDTO {
  label?: string
  value?: string
  sort_order?: number
  is_active?: boolean
}

export interface ValueUpsertDTO {
  field_definition_id: string
  value?: string | null
  option_ids?: string[]
}

export interface ReorderItemDTO {
  id: string
  sort_order: number
}
