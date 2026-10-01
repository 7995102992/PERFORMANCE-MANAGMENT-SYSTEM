import { useFormContext, Controller } from 'react-hook-form'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'
import { stripZerosOnChange } from '@/lib/number-input'

const MAX_EXTRA_DAYS = 365

export function ExtraLeaveSection() {
  const { control, watch, setValue } = useFormContext<EntitlementFormValues>()
  const allowed = watch('extra_leave.status') === 'ALLOWED'

  return (
    <SectionCard
      title="Extra Leave"
      description="Allow employees to take additional leave beyond their allocated balance."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Extra leave
          </Label>
          <Controller
            control={control}
            name="extra_leave.status"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v)
                  if (v === 'NOT_ALLOWED') setValue('extra_leave.max_days', 0)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NOT_ALLOWED">Not allowed</SelectItem>
                  <SelectItem value="ALLOWED">Allowed</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {allowed && (
          <Controller
            control={control}
            name="extra_leave.max_days"
            render={({ field, fieldState }) => (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Maximum extra days <span className="text-destructive ml-0.5">*</span>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={MAX_EXTRA_DAYS}
                  className={cn(
                    'w-full h-9 text-sm',
                    fieldState.error && 'border-destructive focus-visible:ring-destructive',
                  )}
                  value={field.value ?? ''}
                  onChange={stripZerosOnChange(field.onChange, { max: MAX_EXTRA_DAYS })}
                  onBlur={field.onBlur}
                />
                {fieldState.error && (
                  <p className="text-xs text-destructive">{fieldState.error.message}</p>
                )}
              </div>
            )}
          />
        )}
      </div>
    </SectionCard>
  )
}
