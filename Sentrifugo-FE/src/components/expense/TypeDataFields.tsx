/**
 * Renders an expense type's declared extra fields (§7.2).
 *
 * Choosing *Team Lunch* adds `attendees` and `occasion`; choosing *Travel* adds
 * `purpose` and `destination`. This is what makes "add a field to Travel" a
 * config row rather than a code change — the form is generated from
 * `field_schema`, and the server validates the resulting `type_data` blob
 * against the same schema.
 *
 * On a **draft** the caller passes the live schema; from `PENDING_APPROVAL`
 * onward it passes `type_schema_snapshot`, the schema as it was at submit. A
 * later config edit must never re-render an in-flight or settled expense (§7.6).
 */
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { invalidControlClass } from './FormField'
import type { FieldSpecOut } from '@/types/expense'

interface Props {
  schema: FieldSpecOut[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** Employee options for `employee_multi` fields. */
  employees?: { label: string; value: string }[]
  errors?: Record<string, string>
  disabled?: boolean
}

export function TypeDataFields({
  schema,
  value,
  onChange,
  employees = [],
  errors = {},
  disabled = false,
}: Props) {
  if (!schema.length) return null

  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v })

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Additional Details</h3>
      <div className="grid grid-cols-2 gap-4">
        {schema.map((field) => (
          <div
            key={field.key}
            className={`space-y-2 ${
              field.type === 'employee_multi' || field.type === 'date_range'
                ? 'col-span-2'
                : ''
            }`}
          >
            <Label htmlFor={`td-${field.key}`}>
              {field.label}
              {field.required && <span className="text-destructive"> *</span>}
            </Label>

            <div className={errors[field.key] ? invalidControlClass : undefined}>
              {renderControl(field, value[field.key], (v) => set(field.key, v), {
                employees,
                disabled,
              })}
            </div>

            {field.help_text && !errors[field.key] && (
              <p className="text-xs text-muted-foreground">{field.help_text}</p>
            )}
            {errors[field.key] && (
              <p className="text-xs text-destructive">{errors[field.key]}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function renderControl(
  field: FieldSpecOut,
  value: unknown,
  onChange: (v: unknown) => void,
  ctx: { employees: { label: string; value: string }[]; disabled: boolean },
) {
  const id = `td-${field.key}`

  switch (field.type) {
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          className="h-9"
          disabled={ctx.disabled}
          value={(value as string | number) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'date':
      return (
        <DatePicker
          value={(value as string) ?? ''}
          onChange={onChange}
          disabled={ctx.disabled}
          className="w-full"
        />
      )

    case 'date_range': {
      const range = (value as { from?: string; to?: string }) ?? {}
      return (
        <div className="grid grid-cols-2 gap-3">
          <DatePicker
            value={range.from ?? ''}
            onChange={(v) => onChange({ ...range, from: v })}
            placeholder="From"
            disabled={ctx.disabled}
            className="w-full"
          />
          <DatePicker
            value={range.to ?? ''}
            onChange={(v) => onChange({ ...range, to: v })}
            placeholder="To"
            disabled={ctx.disabled}
            className="w-full"
          />
        </div>
      )
    }

    case 'select':
      return (
        <Select
          value={(value as string) ?? ''}
          onValueChange={onChange}
          disabled={ctx.disabled}
        >
          <SelectTrigger className="h-9" id={id}>
            <SelectValue placeholder={`Select ${field.label}`} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )

    case 'boolean':
      return (
        <div className="flex h-9 items-center">
          <Switch
            id={id}
            checked={Boolean(value)}
            onCheckedChange={onChange}
            disabled={ctx.disabled}
          />
        </div>
      )

    case 'employee_multi':
      return (
        <SearchableSelect
          multi
          options={ctx.employees}
          value={(value as string[]) ?? []}
          onChange={onChange}
          placeholder={`Select ${field.label}`}
          disabled={ctx.disabled}
        />
      )

    case 'text':
    default:
      return (
        <Input
          id={id}
          className="h-9"
          maxLength={field.max_length ?? undefined}
          disabled={ctx.disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

/**
 * Client-side required check, mirroring what the server enforces.
 *
 * The server is the control — this only exists so the employee sees the problem
 * on the field rather than as a submit-time rejection.
 */
export function validateTypeData(
  schema: FieldSpecOut[],
  data: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of schema) {
    if (!field.required) continue
    const v = data[field.key]
    const empty =
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (field.type === 'date_range' &&
        (!(v as { from?: string }).from || !(v as { to?: string }).to))
    if (empty) errors[field.key] = `${field.label} is required`
  }
  return errors
}
