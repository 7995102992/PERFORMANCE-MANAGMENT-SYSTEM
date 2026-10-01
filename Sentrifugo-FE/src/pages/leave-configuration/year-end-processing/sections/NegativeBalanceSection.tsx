import { Controller, useFormContext } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { SectionCard } from '../../leave-entitlement/shared/SectionCard'
import type { YearEndFormValues } from '../schema'

const OPTIONS = [
  {
    value: 'DEDUCT_FROM_PAYROLL' as const,
    label: 'Deduct from Payroll',
    desc: "Negative balance is recovered from the employee's payroll.",
  },
  {
    value: 'RESET_TO_ZERO' as const,
    label: 'Reset to Zero',
    desc: 'Negative balance is written off and the balance resets to zero.',
  },
  {
    value: 'CARRY_FORWARD_DEFICIT' as const,
    label: 'Carry Forward Deficit',
    desc: 'Negative balance is carried forward into the next service year.',
  },
]

export function NegativeBalanceSection() {
  const { control } = useFormContext<YearEndFormValues>()

  return (
    <SectionCard
      title="Negative Balance Handling"
      description="Define how negative leave balances at year-end are treated."
    >
      <Controller
        control={control}
        name="negative_balance_rule"
        render={({ field, fieldState }) => (
          <div className="space-y-1">
            <RadioGroup
              value={field.value}
              onValueChange={field.onChange}
              className="grid grid-cols-1 gap-3"
              aria-label="Negative balance rule"
            >
              {OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  htmlFor={`neg-${opt.value}`}
                  className={`flex items-start gap-3 cursor-pointer p-4 border rounded-xl transition-colors ${
                    field.value === opt.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-muted/10 hover:bg-muted/20'
                  }`}
                >
                  <RadioGroupItem
                    value={opt.value}
                    id={`neg-${opt.value}`}
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
