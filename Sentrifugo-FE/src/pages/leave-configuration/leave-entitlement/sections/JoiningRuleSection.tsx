import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

const CUTOFF_DAYS = [21, 22, 23, 24, 25]

export function JoiningRuleSection() {
  const { control, watch, setValue } = useFormContext<EntitlementFormValues>()
  const fmrEnabled = watch('joining_rule.first_month_restriction.enabled')

  return (
    <SectionCard
      title="Joining Rule"
      description="Skip leave credit for an employee's joining month when they join after a cutoff day."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Apply first-month cutoff restriction</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employees who join <span className="font-medium">after</span> the cutoff day won't
              receive leave credit for that joining month.
            </p>
          </div>
          <Controller
            control={control}
            name="joining_rule.first_month_restriction.enabled"
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={(v) => {
                  field.onChange(v)
                  // Single toggle drives both flags the backend checks together.
                  setValue('joining_rule.enabled', v)
                  if (v) setValue('joining_rule.first_month_restriction.cutoff_day', 0)
                }}
              />
            )}
          />
        </div>

        {fmrEnabled && (
          <div className="pl-4 border-l-2 border-border space-y-4">
              <Controller
                control={control}
                name="joining_rule.first_month_restriction.cutoff_day"
                render={({ field, fieldState }) => (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Cutoff day of the month <span className="text-destructive ml-0.5">*</span>
                    </Label>
                    <div className="flex flex-wrap gap-2 items-center">
                      {CUTOFF_DAYS.map((d) => (
                        <Button
                          key={d}
                          type="button"
                          size="sm"
                          variant={field.value === d ? 'default' : 'outline'}
                          onClick={() => field.onChange(d)}
                          className="w-14"
                        >
                          {d}th
                        </Button>
                      ))}
                      <div className="flex items-center gap-2 ml-2">
                        <Label className="text-xs text-muted-foreground">Other:</Label>
                        <Input
                          type="number"
                          min={1}
                          max={31}
                          className="w-16 h-9 text-sm text-center"
                          placeholder="—"
                          value={
                            CUTOFF_DAYS.includes(field.value ?? 0) || !field.value
                              ? ''
                              : field.value
                          }
                          onChange={(e) => {
                            const raw = e.target.value
                            const v = raw === '' ? 0 : parseInt(raw, 10)
                            if (v === 0 || (v >= 1 && v <= 31)) {
                              const canonical = raw === '' ? '' : String(v)
                              if (raw !== canonical) e.target.value = canonical
                              field.onChange(v)
                            }
                          }}
                        />
                      </div>
                    </div>
                    {fieldState.error && (
                      <p className="text-xs text-destructive">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
          </div>
        )}
      </div>
    </SectionCard>
  )
}
