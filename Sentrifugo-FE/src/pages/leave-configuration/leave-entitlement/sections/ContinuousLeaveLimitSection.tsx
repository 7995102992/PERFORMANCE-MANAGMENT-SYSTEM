import { useEffect, useMemo } from 'react'
import { useFormContext, Controller, useWatch } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { useGetGrantPolicyQuery } from '@/store/api/lmsApi'
import { cn } from '@/lib/utils'

interface ContinuousLeaveLimitSectionProps {
  planId?: string
  onCapChange?: (exceeded: boolean) => void
}

export function ContinuousLeaveLimitSection({ planId, onCapChange }: ContinuousLeaveLimitSectionProps) {
  const { control } = useFormContext<EntitlementFormValues>()
  const enabled = useWatch({ control, name: 'continuous_limit.enabled' })
  const maxConsecutiveDays = useWatch({ control, name: 'continuous_limit.max_consecutive_days' }) as number | null

  const { data: grantPolicy } = useGetGrantPolicyQuery(planId!, { skip: !planId })

  const allocationInDays = useMemo(() => {
    const amount = grantPolicy?.allocation?.amount ?? null
    if (amount === null) return null
    return grantPolicy?.allocation?.unit === 'HOURS' ? amount / 8 : amount
  }, [grantPolicy])

  const val = Number(maxConsecutiveDays) || 0
  const exceeded = allocationInDays !== null && val > 0 && val > allocationInDays

  useEffect(() => {
    onCapChange?.(exceeded)
  }, [exceeded, onCapChange])

  return (
    <SectionCard
      title="Continuous Leave Limit"
      description="Restrict the maximum number of consecutive days an employee can take for this leave type."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Enable Continuous Leave Limit</Label>
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

        {enabled && (
          <div className="space-y-4 pl-4 border-l-2 border-border">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Max Consecutive Days {enabled && <span className="text-destructive">*</span>}
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
                      onChange={(e) =>
                        field.onChange(e.target.value === '' ? null : parseInt(e.target.value, 10))
                      }
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
      </div>
    </SectionCard>
  )
}
