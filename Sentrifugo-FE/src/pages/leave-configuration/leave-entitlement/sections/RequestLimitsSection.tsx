import { useFormContext, Controller } from 'react-hook-form'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'
import { stripZerosOnChange } from '@/lib/number-input'

const COMMENT_OPTIONS = [
  {
    value: 'not_required',
    label: 'Not Required',
    description: 'Employees do not need to provide a reason.',
  },
  {
    value: 'optional',
    label: 'Optional',
    description: 'Employees may optionally provide a reason.',
  },
  {
    value: 'mandatory',
    label: 'Mandatory',
    description: 'Employees must provide a reason for every request.',
  },
] as const

export function RequestLimitsSection() {
  const { control, watch } = useFormContext<EntitlementFormValues>()
  const enforceGap = watch('request_limits.enforce_gap')
  const mandatoryUpload = watch('upload_requirement.mandatory')
  const continuousLimitEnabled = watch('continuous_limit.enabled')
  const maxConsecutiveDays = watch('continuous_limit.max_consecutive_days')

  return (
    <SectionCard
      title="Request Rules"
      description="Configure limits, gap rules, upload requirements, and comment policies for leave requests."
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Max requests allowed */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Max Requests Allowed
            </Label>
            <Controller
              control={control}
              name="request_limits.max_requests_allowed"
              render={({ field }) => (
                <Input
                  type="number"
                  min={0}
                  className="h-9 text-sm"
                  placeholder="No limit"
                  value={field.value ?? ''}
                  onChange={stripZerosOnChange(field.onChange)}
                />
              )}
            />
          </div>

          {/* Period */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Per Period
            </Label>
            <Controller
              control={control}
              name="request_limits.period"
              render={({ field }) => (
                <Select
                  value={field.value ?? ''}
                  onValueChange={(v) => field.onChange(v || null)}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select period (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>

        {/* Enforce gap */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Enforce Gap Between Requests</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Require a minimum number of days between consecutive requests.
            </p>
          </div>
          <Controller
            control={control}
            name="request_limits.enforce_gap"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>

        {enforceGap && (
          <div className="pl-4 border-l-2 border-border space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Gap Days {enforceGap && <span className="text-destructive">*</span>}
            </Label>
            <Controller
              control={control}
              name="request_limits.gap_days"
              render={({ field }) => (
                <Input
                  type="number"
                  min={0}
                  className="h-9 text-sm w-32"
                  placeholder="e.g. 7"
                  value={field.value ?? ''}
                  onChange={stripZerosOnChange(field.onChange)}
                />
              )}
            />
          </div>
        )}

        {/* Mandatory Upload */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Mandatory Document Upload</Label>
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

        {mandatoryUpload && (
          <div className="pl-4 border-l-2 border-border space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Required After (days) <span className="text-destructive">*</span>
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

        {/* Comment / Reason Requirement */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Reason Policy
          </Label>
          <Controller
            control={control}
            name="comment_requirement.mode"
            render={({ field }) => (
              <RadioGroup
                value={field.value}
                onValueChange={field.onChange}
                className="flex gap-4"
              >
                {COMMENT_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <RadioGroupItem value={opt.value} id={`comment-${opt.value}`} />
                    <span className="text-sm font-medium">{opt.label}</span>
                  </label>
                ))}
              </RadioGroup>
            )}
          />
        </div>
      </div>
    </SectionCard>
  )
}
