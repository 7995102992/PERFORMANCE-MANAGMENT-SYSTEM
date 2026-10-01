import { useFormContext, Controller } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

const ROUNDING_OPTIONS = [
  { value: 'exact', label: 'Exact', description: 'Keep fractional days as-is' },
  { value: 'nearest_half', label: 'Nearest Half', description: 'Round to the nearest 0.5' },
  { value: 'nearest_one', label: 'Nearest Day', description: 'Round to the nearest whole day' },
  { value: 'round_up', label: 'Round Up', description: 'Always round up to the next whole day' },
  { value: 'round_down', label: 'Round Down', description: 'Always round down to the previous whole day' },
] as const

export function FractionalBalanceSection() {
  const { control } = useFormContext<EntitlementFormValues>()

  return (
    <SectionCard
      title="Fractional Balance Handling"
      description="Define how fractional leave days are rounded."
    >
      <div className="space-y-2">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Rounding Mode
        </Label>
        <Controller
          control={control}
          name="fractional_balance.mode"
          render={({ field }) => (
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="flex flex-wrap gap-4"
            >
              {ROUNDING_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <RadioGroupItem value={opt.value} id={`frac-${opt.value}`} />
                  <span className="text-sm font-medium">{opt.label}</span>
                </label>
              ))}
            </RadioGroup>
          )}
        />
      </div>
    </SectionCard>
  )
}
