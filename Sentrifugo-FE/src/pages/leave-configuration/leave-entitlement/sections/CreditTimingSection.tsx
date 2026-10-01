import { useFormContext, useFieldArray, Controller } from 'react-hook-form'
import { Trash2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

export function CreditTimingSection() {
  const { control } = useFormContext<EntitlementFormValues>()

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'credit_timing.date_rules',
  })

  return (
    <SectionCard
      title="Credit Timing"
      description="Configure when leave credits are applied during the month."
    >
      <div className="space-y-5">
        {/* Mode select */}
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Credit Timing Mode
          </Label>
          <Controller
            control={control}
            name="credit_timing.mode"
            render={({ field }) => (
              <Select
                value={field.value ?? ''}
                onValueChange={(v) => field.onChange(v || null)}
              >
                <SelectTrigger className="h-9 text-sm w-72">
                  <SelectValue placeholder="Select timing mode (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before_month_start">Before Month Start</SelectItem>
                  <SelectItem value="no_change">No Change</SelectItem>
                  <SelectItem value="do_not_credit_notice">Do Not Credit During Notice</SelectItem>
                  <SelectItem value="last_month_prorated">Last Month Prorated</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {/* Date-based rules */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Date Range Credit Rules
            </Label>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              onClick={() =>
                append({ from_day: 1, to_day: 15, credit_day: 1, allocation_days: 1 })
              }
            >
              Add Rule
            </Button>
          </div>

          {fields.length === 0 && (
            <p className="text-xs text-muted-foreground">No date range rules defined.</p>
          )}

          {fields.map((field, index) => (
            <div
              key={field.id}
              className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end"
            >
              <div>
                <Label className="text-xs text-muted-foreground">From Day</Label>
                <Controller
                  control={control}
                  name={`credit_timing.date_rules.${index}.from_day`}
                  render={({ field: f }) => (
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      className="h-9 text-sm"
                      value={f.value}
                      onChange={(e) => f.onChange(parseInt(e.target.value, 10) || 1)}
                    />
                  )}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">To Day</Label>
                <Controller
                  control={control}
                  name={`credit_timing.date_rules.${index}.to_day`}
                  render={({ field: f }) => (
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      className="h-9 text-sm"
                      value={f.value}
                      onChange={(e) => f.onChange(parseInt(e.target.value, 10) || 1)}
                    />
                  )}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Credit Day</Label>
                <Controller
                  control={control}
                  name={`credit_timing.date_rules.${index}.credit_day`}
                  render={({ field: f }) => (
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      className="h-9 text-sm"
                      value={f.value}
                      onChange={(e) => f.onChange(parseInt(e.target.value, 10) || 1)}
                    />
                  )}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Allocation Days</Label>
                <Controller
                  control={control}
                  name={`credit_timing.date_rules.${index}.allocation_days`}
                  render={({ field: f }) => (
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      className="h-9 text-sm"
                      value={f.value}
                      onChange={(e) => f.onChange(parseFloat(e.target.value) || 0)}
                    />
                  )}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-muted-foreground hover:text-destructive"
                onClick={() => remove(index)}
              >
                <Trash2  />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  )
}
