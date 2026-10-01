import { useFormContext, Controller } from 'react-hook-form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'

export function NegativeBalanceSection() {
  const { control, watch, setValue } = useFormContext<EntitlementFormValues>()
  const allowNegative = watch('negative_balance.allow_negative_balance')

  return (
    <SectionCard
      title="Leave Requests Beyond Current Balance"
      description="Define what happens when an employee requests leave beyond their available balance."
    >
      <div className="space-y-3">
        {/* Restrict to Current Balance */}
        <label
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-colors',
            !allowNegative
              ? 'border-primary bg-primary/5'
              : 'border-border hover:bg-muted/30',
          )}
          onClick={() => {
            setValue('negative_balance.allow_negative_balance', false)
            setValue('negative_balance.approval_required', false)
            setValue('negative_balance.approval_mode', null)
          }}
        >
          <div
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center',
              !allowNegative ? 'border-primary' : 'border-muted-foreground',
            )}
          >
            {!allowNegative && <div className="h-2 w-2 rounded-full bg-primary" />}
          </div>
          <div>
            <p className="text-sm font-medium">Restrict to Current Balance</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employees can only request up to the leave they currently have.
            </p>
          </div>
        </label>

        {/* Allow Temporary Negative Balance */}
        <div
          className={cn(
            'rounded-xl border transition-colors',
            allowNegative ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <label
            className="flex items-start gap-3 p-4 cursor-pointer"
            onClick={() => {
              setValue('negative_balance.allow_negative_balance', true)
              setValue('negative_balance.approval_required', false)
              setValue('negative_balance.approval_mode', 'auto_deduct')
            }}
          >
            <div
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center',
                allowNegative ? 'border-primary' : 'border-muted-foreground',
              )}
            >
              {allowNegative && <div className="h-2 w-2 rounded-full bg-primary" />}
            </div>
            <div>
              <p className="text-sm font-medium">Allow Temporary Negative Balance</p>
            </div>
          </label>

          {allowNegative && (
            <div className="px-4 pb-4 border-t border-border pt-4 space-y-3">
              <p className="text-sm font-semibold">Approval Settings</p>
              <Controller
                control={control}
                name="negative_balance.approval_mode"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value ?? ''}
                    onValueChange={(v) => {
                      field.onChange(v || null)
                      setValue(
                        'negative_balance.approval_required',
                        v === 'require_approval',
                      )
                    }}
                    className="space-y-3"
                  >
                    <label className="flex items-start gap-3 cursor-pointer">
                      <RadioGroupItem value="auto_deduct" id="nb-auto" className="mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">Auto-deduct from future credits.</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Automatically recovers the negative balance from an employee's upcoming Leaves.
                        </p>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <RadioGroupItem value="require_approval" id="nb-approve" className="mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">
                          Require Manager + HR approval for all transactions exceeding balance.
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Mandates explicit approval from both a manager and HR.
                        </p>
                      </div>
                    </label>
                  </RadioGroup>
                )}
              />
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  )
}
