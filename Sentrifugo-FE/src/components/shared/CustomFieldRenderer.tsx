import type { CustomFieldDefinition, CustomFieldOption } from "@/types/custom-fields"
import { SearchableSelect } from "./SearchableSelect"
import { DatePicker } from "@/components/ui/date-picker"
import { FileUploader } from "./FileUploader"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"

interface CustomFieldRendererProps {
  fieldDef: CustomFieldDefinition
  options?: CustomFieldOption[]
  value: string | null
  optionIds: string[]
  error?: string
  onValueChange: (value: string | null) => void
  onOptionIdsChange: (ids: string[]) => void
  onFileChange?: (file: File | null) => void
}

const FILE_GROUP_TO_MIME: Record<string, string[]> = {
  pdf: ['application/pdf'],
  word: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  excel: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv'],
  images: ['image/jpeg', 'image/png', 'image/gif'],
}

function resolveAcceptMimes(group: string): string[] {
  return FILE_GROUP_TO_MIME[group] ?? []
}

export function CustomFieldRenderer({
  fieldDef,
  options = [],
  value,
  optionIds,
  error,
  onValueChange,
  onOptionIdsChange,
  onFileChange,
}: CustomFieldRendererProps) {
  const { field_type, name, is_required, placeholder, help_text } = fieldDef

  const displayLabel = (
    <Label className="text-sm font-medium">
      {name} {is_required && <span className="text-destructive">*</span>}
    </Label>
  )

  const helpEl = help_text ? <p className="text-xs text-muted-foreground mt-1">{help_text}</p> : null
  const errorEl = error ? <p className="text-sm text-destructive mt-1">{error}</p> : null

  const selectOptions = options.map(o => ({ label: o.label, value: o.id }))

  switch (field_type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return (
        <div className="space-y-3">
          {displayLabel}
          <Input
            type={field_type === 'email' ? 'email' : field_type === 'url' ? 'url' : field_type === 'phone' ? 'tel' : 'text'}
            placeholder={placeholder ?? `Enter ${name}...`}
            value={value ?? ''}
            onChange={(e) => onValueChange(e.target.value || null)}
          />
          {errorEl}
          {helpEl}
        </div>
      )

    case 'textarea':
      return (
        <div className="space-y-3">
          {displayLabel}
          <Textarea
            placeholder={placeholder ?? `Enter ${name}...`}
            value={value ?? ''}
            onChange={(e) => onValueChange(e.target.value || null)}
            rows={3}
          />
          {errorEl}
          {helpEl}
        </div>
      )

    case 'number':
      return (
        <div className="space-y-3">
          {displayLabel}
          <Input
            type="number"
            placeholder={placeholder ?? `Enter ${name}...`}
            value={value ?? ''}
            onChange={(e) => onValueChange(e.target.value || null)}
          />
          {errorEl}
          {helpEl}
        </div>
      )

    case 'date':
      return (
        <div className="space-y-3">
          {displayLabel}
          <DatePicker
            value={value ?? ""}
            onChange={(v) => onValueChange(v || null)}
          />
          {errorEl}
          {helpEl}
        </div>
      )

    case 'single_select':
      return (
        <div className="space-y-3">
          {displayLabel}
          <SearchableSelect
            placeholder={placeholder ?? `Select ${name}...`}
            options={selectOptions}
            value={optionIds[0] ?? ''}
            onChange={(val) => onOptionIdsChange(val ? [val as string] : [])}
          />
          {errorEl}
          {helpEl}
        </div>
      )

    case 'radio':
      return (
        <div className="space-y-3">
          {displayLabel}
          <RadioGroup
            value={optionIds[0] ?? ''}
            onValueChange={(val) => onOptionIdsChange(val ? [val] : [])}
            className="flex flex-col space-y-1 mt-1"
          >
            {options.map((opt) => (
              <div className="flex items-center space-x-2" key={opt.id}>
                <RadioGroupItem value={opt.id} id={`${fieldDef.id}-${opt.id}`} />
                <Label className="font-normal" htmlFor={`${fieldDef.id}-${opt.id}`}>{opt.label}</Label>
              </div>
            ))}
          </RadioGroup>
          {errorEl}
          {helpEl}
        </div>
      )

    case 'multi_select':
      return (
        <div className="space-y-3">
          {displayLabel}
          <SearchableSelect
            multi
            placeholder={placeholder ?? `Select ${name}...`}
            options={selectOptions}
            value={optionIds}
            onChange={(val) => onOptionIdsChange(val as string[])}
          />
          {errorEl}
          {helpEl}
        </div>
      )

    case 'checkbox': {
      return (
        <div className="space-y-3">
          {displayLabel}
          <div className="flex flex-col space-y-3 mt-1">
            {options.map((opt) => {
              const checked = optionIds.includes(opt.id)
              return (
                <div className="flex items-center space-x-2" key={opt.id}>
                  <Checkbox
                    id={`${fieldDef.id}-${opt.id}`}
                    checked={checked}
                    onCheckedChange={(isChecked) => {
                      if (isChecked) {
                        onOptionIdsChange([...optionIds, opt.id])
                      } else {
                        onOptionIdsChange(optionIds.filter(id => id !== opt.id))
                      }
                    }}
                  />
                  <Label className="font-normal" htmlFor={`${fieldDef.id}-${opt.id}`}>{opt.label}</Label>
                </div>
              )
            })}
          </div>
          {errorEl}
          {helpEl}
        </div>
      )
    }

    case 'file':
      return (
        <div className="space-y-3">
          {displayLabel}
          <FileUploader
            value={null}
            onChange={(file) => onFileChange?.(file)}
            accept={fieldDef.file_settings?.allowed_file_types?.flatMap(resolveAcceptMimes) ?? []}
            maxSizeMB={fieldDef.file_settings?.max_size_mb ?? 10}
          />
          {value && <p className="text-xs text-muted-foreground">File uploaded (asset: {value})</p>}
          {errorEl}
          {helpEl}
        </div>
      )

    default:
      return null
  }
}
