import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'
import { stripZerosOnChange } from '@/lib/number-input'

export function BackdatedLeaveSection() {
  const { control, watch } = useFormContext<EntitlementFormValues>()
  const enabled = watch('backdated_leave.enabled')

  return (
    <SectionCard
      title="Backdated Leave Deadline"
      description="Limit how many days after an absence an employee can still submit a backdated leave request."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Enable Backdated Leave Deadline</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employees must apply for backdated leave within a set number of days after the absence.
            </p>
          </div>
          <Controller
            control={control}
            name="backdated_leave.enabled"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {enabled && (
          <div className="pl-4 border-l-2 border-border space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Max Days After Absence {enabled && <span className="text-destructive ml-0.5">*</span>}
            </Label>
            <Controller
              control={control}
              name="backdated_leave.max_days"
              render={({ field, fieldState }) => (
                <>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className={cn(
                      'h-9 text-sm w-32',
                      fieldState.error && 'border-destructive focus-visible:ring-destructive',
                    )}
                    placeholder="e.g. 30"
                    value={field.value ?? ''}
                    onChange={stripZerosOnChange(field.onChange)}
                    onBlur={field.onBlur}
                  />
                  <p className="text-xs text-muted-foreground">
                    Backdated applications submitted after this many days from the absence date will be rejected.
                  </p>
                  {fieldState.error && (
                    <p className="text-xs text-destructive">{fieldState.error.message}</p>
                  )}
                </>
              )}
            />
          </div>
        )}
      </div>
    </SectionCard>
  )
}
