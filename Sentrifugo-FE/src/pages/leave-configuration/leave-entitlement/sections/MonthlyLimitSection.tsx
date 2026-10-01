import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

export function MonthlyLimitSection() {
  const { control, watch } = useFormContext<EntitlementFormValues>()
  const enabled = watch('monthly_limit.enabled')

  return (
    <SectionCard
      title="Monthly Leave Limit"
      description="Cap the number of days an employee can take in any single calendar month."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Enable Monthly Limit</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Restrict leave days per month.
            </p>
          </div>
          <Controller
            control={control}
            name="monthly_limit.enabled"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {enabled && (
          <div className="pl-4 border-l-2 border-border space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Max Days Per Month {enabled && <span className="text-destructive">*</span>}
            </Label>
            <Controller
              control={control}
              name="monthly_limit.max_days_per_month"
              render={({ field, fieldState }) => (
                <>
                  <Input
                    type="number"
                    min={0}
                    max={31}
                    step={0.5}
                    className="h-9 text-sm w-36"
                    placeholder="e.g. 3"
                    value={field.value ?? ''}
                    onChange={(e) =>
                      field.onChange(e.target.value === '' ? null : parseFloat(e.target.value))
                    }
                    onBlur={field.onBlur}
                  />
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
