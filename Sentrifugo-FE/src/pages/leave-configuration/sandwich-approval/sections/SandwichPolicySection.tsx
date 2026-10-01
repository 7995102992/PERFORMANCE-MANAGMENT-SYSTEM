import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionCard } from '../../leave-entitlement/shared/SectionCard'
import type { SandwichApprovalFormValues } from '../schema'

const RULE_OPTIONS = [
  { value: 'between_two_leave_days', label: 'Between two leave days' },
  { value: 'before_a_leave_day', label: 'Before a leave day' },
  { value: 'after_a_leave_day', label: 'After a leave day' },
  { value: 'before_or_after_leave_day', label: 'Before or after a leave day' },
  { value: 'between_two_holidays', label: 'Between two holidays' },
] as const

export function SandwichPolicySection() {
  const { control, watch } = useFormContext<SandwichApprovalFormValues>()
  const enabled = watch('sandwich.enabled')

  return (
    <SectionCard
      title="Sandwich Leave Policy"
      description="Configure rules for leaves taken around holidays or other leave periods."
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-semibold">Enable Sandwich Leave Policy</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Count intervening working days as leave when surrounded by leave or holidays.
            </p>
          </div>
          <Controller
            control={control}
            name="sandwich.enabled"
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-label="Enable sandwich leave policy"
              />
            )}
          />
        </div>

        {enabled && (
          <>
            <div className="border-t border-border pt-5">
              <p className="text-xs font-semibold mb-3 text-foreground">Apply rule when: {enabled && <span className="text-destructive">*</span>}</p>
              <Controller
                control={control}
                name="sandwich.apply_rule_when"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                    aria-label="Sandwich rule condition"
                  >
                    {RULE_OPTIONS.map((opt) => (
                      <div key={opt.value} className="flex items-center gap-2">
                        <RadioGroupItem value={opt.value} id={`rule-${opt.value}`} />
                        <Label
                          htmlFor={`rule-${opt.value}`}
                          className="text-sm text-muted-foreground font-medium cursor-pointer"
                        >
                          {opt.label}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
              />
            </div>

            <div className="border-t border-border pt-5">
              <p className="text-xs font-semibold mb-3 text-foreground">Minimum consecutive duration: {enabled && <span className="text-destructive">*</span>}</p>
              <div className="flex items-center gap-3">
                <Controller
                  control={control}
                  name="sandwich.minimum_consecutive_value"
                  render={({ field, fieldState }) => (
                    <div>
                      <Input
                        type="number"
                        min={1}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                        className="w-24 h-9 text-sm text-center"
                        aria-label="Minimum consecutive value"
                      />
                      {fieldState.error && (
                        <p className="text-xs text-destructive mt-1">{fieldState.error.message}</p>
                      )}
                    </div>
                  )}
                />
                <Controller
                  control={control}
                  name="sandwich.minimum_consecutive_unit"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="h-9 text-sm w-28" aria-label="Duration unit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="days">Days</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <div className="border-t border-border pt-5">
              <Controller
                control={control}
                name="sandwich.ignore_half_day_leaves"
                render={({ field }) => (
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id="ignore-half-day"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      aria-label="Ignore half day leaves"
                    />
                    <Label
                      htmlFor="ignore-half-day"
                      className="text-sm font-medium cursor-pointer"
                    >
                      Ignore half-day leaves when calculating sandwich
                    </Label>
                  </div>
                )}
              />
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}
