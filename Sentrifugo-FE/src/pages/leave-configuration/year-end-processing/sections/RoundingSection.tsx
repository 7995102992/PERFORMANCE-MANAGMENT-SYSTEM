import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { YearEndFormValues } from '../schema'

export function RoundingSection() {
  const { control } = useFormContext<YearEndFormValues>()
  const roundingEnabled =
    useWatch({ control, name: 'payout_carry_config.rounding.enabled' }) ?? false

  return (
    <div className="space-y-5 border-t border-border pt-5">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-semibold">Enable Rounding</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Round fractional day values to a fixed unit after calculation.
          </p>
        </div>
        <Controller
          control={control}
          name="payout_carry_config.rounding.enabled"
          render={({ field }) => (
            <Switch
              checked={field.value ?? false}
              onCheckedChange={field.onChange}
              aria-label="Enable rounding"
            />
          )}
        />
      </div>

      {roundingEnabled && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Rounding Type</Label>
            <Controller
              control={control}
              name="payout_carry_config.rounding.rounding_type"
              render={({ field }) => (
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <SelectTrigger className="h-9 text-sm" aria-label="Rounding type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NEAREST">Nearest</SelectItem>
                    <SelectItem value="UP">Up (round up)</SelectItem>
                    <SelectItem value="DOWN">Down (round down)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Rounding Unit</Label>
            <Controller
              control={control}
              name="payout_carry_config.rounding.rounding_unit"
              render={({ field }) => (
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <SelectTrigger className="h-9 text-sm" aria-label="Rounding unit">
                    <SelectValue placeholder="Select unit" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HALF_DAY">Half day</SelectItem>
                    <SelectItem value="FULL_DAY">Full day</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>
      )}
    </div>
  )
}
