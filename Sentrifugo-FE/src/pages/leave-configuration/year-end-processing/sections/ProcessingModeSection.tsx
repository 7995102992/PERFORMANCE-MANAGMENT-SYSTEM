import { Controller, useFormContext } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { SectionCard } from '../../leave-entitlement/shared/SectionCard'
import type { YearEndFormValues } from '../schema'

const OPTIONS = [
  {
    value: 'EXPIRE_RESET' as const,
    label: 'Expire & Reset',
    desc: 'All unused leave expires at year-end. Balances reset to zero.',
  },
  {
    value: 'PAYOUT_ALL' as const,
    label: 'Payout All',
    desc: 'All unused leave is paid out to employees. No carry-forward.',
  },
  {
    value: 'CARRY_FORWARD_ALL' as const,
    label: 'Carry Forward All',
    desc: 'All unused leave is carried forward to the next service year.',
  },
  {
    value: 'PAYOUT_THEN_CARRY' as const,
    label: 'Payout, then Carry Forward',
    desc: 'A portion is paid out first; the remaining balance is carried forward.',
  },
  {
    value: 'CARRY_THEN_PAYOUT' as const,
    label: 'Carry Forward, then Payout',
    desc: 'A portion is carried forward first; the remaining balance is paid out.',
  },
]

export function ProcessingModeSection() {
  const { control } = useFormContext<YearEndFormValues>()

  return (
    <SectionCard
      title="Year-End Processing Mode"
      description="Select how unused leave balances are handled at the end of each service year."
    >
      <Controller
        control={control}
        name="processing_type"
        render={({ field, fieldState }) => (
          <div className="space-y-1">
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="grid grid-cols-1 gap-3"
              aria-label="Year-end processing mode"
            >
              {OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  htmlFor={`proc-${opt.value}`}
                  className={`flex items-start gap-3 cursor-pointer p-4 border rounded-xl transition-colors ${
                    field.value === opt.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-muted/10 hover:bg-muted/20'
                  }`}
                >
                  <RadioGroupItem
                    value={opt.value}
                    id={`proc-${opt.value}`}
                    className="mt-0.5 shrink-0"
                  />
                  <div>
                    <p className="text-sm font-semibold">{opt.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>
            {fieldState.error && (
              <p className="text-xs text-destructive mt-1">{fieldState.error.message}</p>
            )}
          </div>
        )}
      />
    </SectionCard>
  )
}
