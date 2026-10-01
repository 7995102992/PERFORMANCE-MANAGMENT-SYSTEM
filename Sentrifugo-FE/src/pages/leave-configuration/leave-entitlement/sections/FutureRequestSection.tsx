import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'

export function FutureRequestSection() {
  const { control, watch } = useFormContext<EntitlementFormValues>()
  const allowFuture = watch('future_request.allow_future_requests')

  return (
    <SectionCard
      title="Future Leave Requests"
      description="Control whether employees can apply for leave in advance of accrual."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Allow Future Requests</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Employees can apply before the leave is fully accrued.
            </p>
          </div>
          <Controller
            control={control}
            name="future_request.allow_future_requests"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {allowFuture && (
          <div className="flex items-center justify-between pl-4 border-l-2 border-border">
            <div>
              <Label className="text-sm font-medium">Allow Based on Projected Balance</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Approve requests against the expected future balance.
              </p>
            </div>
            <Controller
              control={control}
              name="future_request.allow_based_on_projected_balance"
              render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>
        )}
      </div>
    </SectionCard>
  )
}
