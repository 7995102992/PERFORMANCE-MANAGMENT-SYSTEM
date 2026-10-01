import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '../../leave-entitlement/shared/SectionCard'
import { SlabEditor } from './SlabEditor'
import { PercentageEditor } from './PercentageEditor'
import { RoundingSection } from './RoundingSection'
import type { YearEndFormValues } from '../schema'

export function PayoutCarrySection() {
  const { control } = useFormContext<YearEndFormValues>()

  const processingType = useWatch({ control, name: 'processing_type' })
  const calculationMode = useWatch({ control, name: 'payout_carry_config.calculation_mode' })

  const showPayoutLimit = processingType !== 'CARRY_FORWARD_ALL'
  const showCarryLimit = processingType !== 'PAYOUT_ALL'

  return (
    <SectionCard
      title="Payout & Carry-Forward Configuration"
      description="Configure how leave balances are split between payout and carry-forward."
    >
      <div className="space-y-6">
        {/* Calculation Mode */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold">Calculation Mode</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Choose whether to use fixed day slabs or a percentage-based split.
            </p>
          </div>
          <Controller
            control={control}
            name="payout_carry_config.calculation_mode"
            render={({ field }) => (
              <RadioGroup
                value={field.value}
                onValueChange={field.onChange}
                className="grid grid-cols-2 gap-3"
                aria-label="Calculation mode"
              >
                {[
                  {
                    value: 'FIXED_DAYS',
                    label: 'Fixed Days (Slabs)',
                    desc: 'Define day-based slabs for payout and carry.',
                  },
                  {
                    value: 'PERCENTAGE',
                    label: 'Percentage Split',
                    desc: 'Split balance by percentage between payout and carry.',
                  },
                ].map((opt) => (
                  <label
                    key={opt.value}
                    htmlFor={`calc-${opt.value}`}
                    className={`flex items-start gap-3 cursor-pointer p-3 border rounded-xl transition-colors ${
                      field.value === opt.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-muted/10 hover:bg-muted/20'
                    }`}
                  >
                    <RadioGroupItem
                      value={opt.value}
                      id={`calc-${opt.value}`}
                      className="mt-0.5 shrink-0"
                    />
                    <div>
                      <p className="text-xs font-semibold">{opt.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            )}
          />
        </div>

        {/* Minimum Eligible Balance */}
        <div className="flex items-center gap-4 border-t border-border pt-5">
          <Label className="text-xs font-semibold whitespace-nowrap">
            Minimum Eligible Balance
          </Label>
          <Controller
            control={control}
            name="payout_carry_config.minimum_eligible_balance"
            render={({ field, fieldState }) => (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  value={field.value}
                  onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                  className="w-24 h-9 text-sm"
                  aria-label="Minimum eligible balance in days"
                />
                <span className="text-xs text-muted-foreground">days</span>
                {fieldState.error && (
                  <p className="text-xs text-destructive">{fieldState.error.message}</p>
                )}
              </div>
            )}
          />
        </div>

        {/* Slab Editor or Percentage Editor */}
        <div className="border-t border-border pt-5">
          {calculationMode === 'FIXED_DAYS' ? <SlabEditor /> : <PercentageEditor />}
        </div>

        {/* Max Limits */}
        {(showPayoutLimit || showCarryLimit) && (
          <div className="flex flex-wrap gap-8 border-t border-border pt-5">
            {showPayoutLimit && (
              <div className="flex items-center gap-3">
                <Label className="text-xs font-semibold whitespace-nowrap">Max Payout Limit</Label>
                <Controller
                  control={control}
                  name="payout_carry_config.max_payout_limit"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={field.value ?? ''}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === '' ? undefined : parseFloat(e.target.value),
                          )
                        }
                        placeholder="No limit"
                        className="w-28 h-9 text-sm"
                        aria-label="Max payout limit in days"
                      />
                      <span className="text-xs text-muted-foreground">days</span>
                    </div>
                  )}
                />
              </div>
            )}
            {showCarryLimit && (
              <div className="flex items-center gap-3">
                <Label className="text-xs font-semibold whitespace-nowrap">Max Carry Limit</Label>
                <Controller
                  control={control}
                  name="payout_carry_config.max_carry_limit"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={field.value ?? ''}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === '' ? undefined : parseFloat(e.target.value),
                          )
                        }
                        placeholder="No limit"
                        className="w-28 h-9 text-sm"
                        aria-label="Max carry forward limit in days"
                      />
                      <span className="text-xs text-muted-foreground">days</span>
                    </div>
                  )}
                />
              </div>
            )}
          </div>
        )}

        {/* Rounding */}
        <RoundingSection />
      </div>
    </SectionCard>
  )
}
