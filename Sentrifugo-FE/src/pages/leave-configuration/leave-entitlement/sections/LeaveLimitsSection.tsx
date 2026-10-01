import { useEffect, useMemo } from 'react'
import { useFormContext, Controller, useWatch } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { useGetGrantPolicyQuery } from '@/store/api/lmsApi'
import { cn } from '@/lib/utils'
import { stripZerosOnChange } from '@/lib/number-input'

interface LeaveLimitsSectionProps {
  planId?: string
  onContinuousCapChange?: (exceeded: boolean) => void
}

export function LeaveLimitsSection({ planId, onContinuousCapChange }: LeaveLimitsSectionProps) {
  const { control, watch } = useFormContext<EntitlementFormValues>()

  const continuousEnabled = useWatch({ control, name: 'continuous_limit.enabled' })
  const maxConsecutiveDays = useWatch({ control, name: 'continuous_limit.max_consecutive_days' }) as number | null
  const monthlyEnabled = watch('monthly_limit.enabled')

  const { data: grantPolicy } = useGetGrantPolicyQuery(planId!, { skip: !planId })

  const allocationInDays = useMemo(() => {
    const amount = grantPolicy?.allocation?.amount ?? null
    if (amount === null) return null
    return grantPolicy?.allocation?.unit === 'HOURS' ? amount / 8 : amount
  }, [grantPolicy])

  const val = Number(maxConsecutiveDays) || 0
  const exceeded = allocationInDays !== null && val > 0 && val > allocationInDays

  useEffect(() => {
    onContinuousCapChange?.(exceeded)
  }, [exceeded, onContinuousCapChange])

  return (
    <SectionCard
      title="Leave Limits"
      description="Set maximum consecutive and monthly leave limits for this leave type."
    >
      <div className="space-y-5">
        {/* Continuous Leave Limit */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Continuous Leave Limit</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Restrict maximum consecutive days in a single request.
            </p>
          </div>
          <Controller
            control={control}
            name="continuous_limit.enabled"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {continuousEnabled && (
          <div className="space-y-4 pl-4 border-l-2 border-border">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Max Consecutive Days
                <span className="text-destructive ml-0.5">*</span>
                {allocationInDays !== null && (
                  <span className="ml-1 normal-case font-normal text-muted-foreground">
                    (max {Number(allocationInDays.toFixed(1))} days)
                  </span>
                )}
              </Label>
              <Controller
                control={control}
                name="continuous_limit.max_consecutive_days"
                render={({ field, fieldState }) => (
                  <>
                    <Input
                      type="number"
                      min={0}
                      max={allocationInDays ?? undefined}
                      className={cn(
                        'h-9 text-sm w-36',
                        (exceeded || fieldState.error) && 'border-destructive focus-visible:ring-destructive',
                      )}
                      placeholder="e.g. 5"
                      value={field.value ?? ''}
                      onChange={stripZerosOnChange(field.onChange)}
                      onBlur={field.onBlur}
                    />
                    {exceeded && (
                      <p id="continuous-cap-error" className="text-xs text-destructive">
                        Cannot exceed the grant allocation of {Number(allocationInDays!.toFixed(1))} days
                      </p>
                    )}
                    {!exceeded && fieldState.error && (
                      <p className="text-xs text-destructive">{fieldState.error.message}</p>
                    )}
                  </>
                )}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Include Weekends</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Count weekends in the consecutive day calculation.
                </p>
              </div>
              <Controller
                control={control}
                name="continuous_limit.include_weekends"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Include Holidays</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Count public holidays in the consecutive day calculation.
                </p>
              </div>
              <Controller
                control={control}
                name="continuous_limit.include_holidays"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>
          </div>
        )}

        {/* Monthly Leave Limit */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Monthly Leave Limit</Label>
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

        {monthlyEnabled && (
          <div className="pl-4 border-l-2 border-border space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Max Days Per Month
              <span className="text-destructive ml-0.5">*</span>
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
                    onChange={stripZerosOnChange(field.onChange, { parse: 'float', max: 31 })}
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
