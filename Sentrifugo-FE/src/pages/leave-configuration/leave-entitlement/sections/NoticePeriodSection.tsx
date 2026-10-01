import { useFormContext, Controller } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

const MODE_OPTIONS = [
  {
    value: 'block',
    label: 'Block Leave During Notice Period',
    description: 'Employees cannot apply for this leave type while serving notice.',
  },
  {
    value: 'allow_with_extension',
    label: 'Allow with Notice Extension',
    description: 'Leave is permitted but the notice period is extended by the leave days taken.',
  },
] as const

export function NoticePeriodSection() {
  const { control } = useFormContext<EntitlementFormValues>()

  return (
    <SectionCard
      title="Notice Period Leave"
      description="Define how this leave type behaves when an employee is serving their notice period."
    >
      <div className="space-y-5">
        {/* Mode */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Notice Period Policy
          </Label>
          <Controller
            control={control}
            name="notice_period_leave.mode"
            render={({ field }) => (
              <RadioGroup
                value={field.value ?? ''}
                onValueChange={(v) => field.onChange(v || null)}
                className="grid gap-2"
              >
                {MODE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex items-center gap-3 p-3 rounded-xl border border-border cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <RadioGroupItem value={opt.value} id={`np-${opt.value}`} />
                    <div>
                      <span className="text-sm font-medium">{opt.label}</span>
                      <p className="text-xs text-muted-foreground">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            )}
          />
        </div>
      </div>
    </SectionCard>
  )
}
