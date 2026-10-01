import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'

export function UploadRequirementSection() {
  const { control, watch } = useFormContext<EntitlementFormValues>()
  const mandatory = watch('upload_requirement.mandatory')
  const continuousLimitEnabled = watch('continuous_limit.enabled')
  const maxConsecutiveDays = watch('continuous_limit.max_consecutive_days')

  return (
    <SectionCard
      title="Document Upload Requirement"
      description="Define when employees must upload a supporting document for their leave request."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Mandatory Upload</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Require employees to attach a document when applying.
            </p>
          </div>
          <Controller
            control={control}
            name="upload_requirement.mandatory"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {mandatory && (
          <div className="pl-4 border-l-2 border-border space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Required After (days)
            </Label>
            <Controller
              control={control}
              name="upload_requirement.required_after_days"
              render={({ field }) => {
                const val = field.value != null ? Number(field.value) : null
                const capExceeded =
                  continuousLimitEnabled &&
                  maxConsecutiveDays != null &&
                  val != null &&
                  val > maxConsecutiveDays
                return (
                  <>
                    <Input
                      type="number"
                      min={0}
                      max={continuousLimitEnabled && maxConsecutiveDays != null ? maxConsecutiveDays : undefined}
                      className={cn('h-9 text-sm w-36', capExceeded && 'border-destructive focus-visible:ring-destructive')}
                      placeholder="Always required"
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value === '' ? null : parseInt(e.target.value, 10))
                      }
                      onBlur={field.onBlur}
                    />
                    {capExceeded ? (
                      <p className="text-xs text-destructive">
                        Cannot exceed the continuous leave limit of {maxConsecutiveDays} days
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Leave blank to require upload on all requests.
                        {continuousLimitEnabled && maxConsecutiveDays != null && (
                          <span className="ml-1">(max {maxConsecutiveDays} days)</span>
                        )}
                      </p>
                    )}
                  </>
                )
              }}
            />
          </div>
        )}
      </div>
    </SectionCard>
  )
}
