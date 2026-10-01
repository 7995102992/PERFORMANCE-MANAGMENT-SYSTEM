import { useFormContext, Controller } from 'react-hook-form'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'

export function CreditExpirySection() {
  const { control, watch, setValue } = useFormContext<EntitlementFormValues>()
  const expiryEnabled = watch('credit_expiry.expiry_enabled')
  const periodValue = watch('credit_expiry.expiry_period_value')
  const periodUnit = watch('credit_expiry.expiry_period_unit')

  const hintText = (() => {
    if (!periodValue || !periodUnit) return null
    if (periodUnit === 'Days') {
      return `If set to ${periodValue} days → Credits given on Jan 1 will expire on Apr 1.`
    }
    return `If set to ${periodValue} months → Credits given on Jan 1 will expire after ${periodValue} month(s).`
  })()

  return (
    <SectionCard
      title="Leave Credit Expiry Settings"
      description="Decide if unused leave credits should remain valid or expire after a set period."
    >
      <div className="space-y-3">
        {/* Keep Credits Forever */}
        <label
          className={cn(
            'flex items-start gap-3 rounded-xl p-4 cursor-pointer transition-colors',
            !expiryEnabled
              ? 'text-foreground'
              : 'text-muted-foreground',
          )}
          onClick={() => {
            setValue('credit_expiry.expiry_enabled', false)
            setValue('credit_expiry.expiry_period_value', null)
            setValue('credit_expiry.expiry_period_unit', null)
          }}
        >
          <div
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center',
              !expiryEnabled ? 'border-primary' : 'border-muted-foreground',
            )}
          >
            {!expiryEnabled && <div className="h-2 w-2 rounded-full bg-primary" />}
          </div>
          <div>
            <p className="text-sm font-medium">Keep Credits Forever (Default)</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employee balance stays available until used.
            </p>
          </div>
        </label>

        {/* Set Expiry Period */}
        <div
          className={cn(
            'rounded-xl border transition-colors',
            expiryEnabled ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <label
            className="flex items-start gap-3 p-4 cursor-pointer"
            onClick={() => setValue('credit_expiry.expiry_enabled', true)}
          >
            <div
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center',
                expiryEnabled ? 'border-primary' : 'border-muted-foreground',
              )}
            >
              {expiryEnabled && <div className="h-2 w-2 rounded-full bg-primary" />}
            </div>
            <div>
              <p className="text-sm font-semibold">Set Expiry Period</p>
              {!expiryEnabled && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Unused credits expire automatically after a fixed duration.
                </p>
              )}
            </div>
          </label>

          {expiryEnabled && (
            <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                Unused credits expire automatically after a fixed duration.
              </p>
              <div className="flex items-center gap-2">
                <Controller
                  control={control}
                  name="credit_expiry.expiry_period_value"
                  render={({ field }) => (
                    <Input
                      type="number"
                      min={1}
                      className="h-9 text-sm w-28"
                      placeholder="e.g. 90"
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value === '' ? null : parseInt(e.target.value, 10))
                      }
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="credit_expiry.expiry_period_unit"
                  render={({ field }) => (
                    <Select
                      value={field.value ?? ''}
                      onValueChange={(v) => field.onChange(v || null)}
                    >
                      <SelectTrigger className="h-9 text-sm w-28">
                        <SelectValue placeholder="Unit" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Days">Days</SelectItem>
                        <SelectItem value="Months">Months</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              {hintText && (
                <p className="text-xs text-muted-foreground">{hintText}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  )
}
