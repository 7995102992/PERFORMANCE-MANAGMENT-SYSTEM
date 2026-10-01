import { useEffect } from 'react'
import { useFormContext, useFieldArray, Controller } from 'react-hook-form'
import { Trash2 } from 'lucide-react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'
import { stripZerosOnChange } from '@/lib/number-input'
import { useGetLeavePlanLeaveTypesQuery } from '@/store/api/lmsApi'

export function ProbationSection({ planId }: { planId?: string }) {
  const { control, watch, trigger, setValue } = useFormContext<EntitlementFormValues>()
  // The plan-leave-types endpoint returns mapping rows; the actual leave type is
  // nested under `.leave_type` (with _id / name), matching DistributionSection.
  const { data: leaveTypesRaw } = useGetLeavePlanLeaveTypesQuery(planId!, { skip: !planId })
  const planLeaveTypes = Array.isArray(leaveTypesRaw)
    ? leaveTypesRaw.map((t: any) => t.leave_type).filter(Boolean)
    : []
  const creditMode = watch('probation.credit_mode')
  const creditStart = watch('probation.credit_start')
  const bandRules = watch('probation.band_rules') ?? []
  const probationDurationMonths = watch('probation.probation_duration_months')

  const { fields, append, remove, replace } = useFieldArray({
    control,
    name: 'probation.band_rules',
  })

  useEffect(() => {
    if (fields.length > 0) {
      trigger(fields.flatMap((_, i) => [
        `probation.band_rules.${i}.from_month` as const,
        `probation.band_rules.${i}.to_month` as const,
      ]))
    }
  }, [probationDurationMonths])

  // Confirmation-date mode has no probation window to tier across — clear any
  // stale duration/band data so it doesn't get persisted hidden behind the UI.
  useEffect(() => {
    if (creditStart !== 'confirmation_date') return
    if (probationDurationMonths != null) {
      setValue('probation.probation_duration_months', null, { shouldDirty: true })
    }
    if (bandRules.length > 0) {
      replace([])
    }
  }, [creditStart, probationDurationMonths, bandRules.length, setValue, replace])

  return (
    <SectionCard
      title="Leave Credit During Probation"
      description="Configure how employees accrue leave credit during their probationary period. Select one of the options below to define the rules."
    >
      <div className="space-y-4">
        <p className="text-sm font-semibold">Configure Leave Credit Options</p>

        <Controller
          control={control}
          name="probation.credit_mode"
          render={({ field }) => (
            <RadioGroup
              value={field.value ?? ''}
              onValueChange={(v) => field.onChange(v || null)}
              className="space-y-3"
            >
              {/* Same for All Employees */}
              <label
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-colors',
                  field.value === 'same_for_all'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/30',
                )}
              >
                <RadioGroupItem value="same_for_all" id="prob-same" className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Same for All Employees</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Applies a uniform leave credit rate for all new hires during probation.
                  </p>
                </div>
              </label>

              {/* Tiered by Duration */}
              <div
                className={cn(
                  'rounded-xl border transition-colors',
                  field.value === 'tiered_by_duration'
                    ? 'border-primary bg-primary/5'
                    : 'border-border',
                )}
              >
                <label className="flex items-start gap-3 p-4 cursor-pointer">
                  <RadioGroupItem value="tiered_by_duration" id="prob-tiered" className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Tiered Leave Credit by Probation Duration</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {field.value === 'tiered_by_duration'
                        ? 'Define different leave credit amounts based on various probation duration bands.'
                        : 'Adjusts leave credit based on different probation period lengths.'}
                    </p>
                  </div>
                </label>

                {field.value === 'tiered_by_duration' && (
                  <div className="px-4 pb-4 space-y-5 border-t border-border pt-4">
                    {/* Credit Start — two side-by-side cards */}
                    <Controller
                      control={control}
                      name="probation.credit_start"
                      render={({ field: cs, fieldState }) => (
                       <div className="space-y-1.5">
                        <RadioGroup
                          value={cs.value ?? ''}
                          onValueChange={(v) => cs.onChange(v || null)}
                          className="grid grid-cols-2 gap-3"
                        >
                          <label
                            className={cn(
                              'flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-colors',
                              cs.value === 'start_date'
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:bg-muted/30',
                            )}
                          >
                            <RadioGroupItem value="start_date" id="cs-start" className="mt-0.5 shrink-0" />
                            <div>
                              <p className="text-sm font-semibold">Credit from Start Date</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Grant leave credit immediately from the employee's date of joining.
                              </p>
                            </div>
                          </label>
                          <label
                            className={cn(
                              'flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-colors',
                              cs.value === 'confirmation_date'
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:bg-muted/30',
                            )}
                          >
                            <RadioGroupItem value="confirmation_date" id="cs-confirm" className="mt-0.5 shrink-0" />
                            <div>
                              <p className="text-sm font-semibold">Credit from Confirmation</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Allocate leave credit starting from the employee's confirmation date after probation.
                              </p>
                            </div>
                          </label>
                        </RadioGroup>
                        {fieldState.error && (
                          <p className="text-xs text-destructive">{fieldState.error.message}</p>
                        )}
                       </div>
                      )}
                    />

                    {creditStart === 'start_date' && (
                      <>
                    {/* Probation Leave Types — the types a probationer is funded
                        into (via the bands) and the only ones they can apply for.
                        Each selected type is credited at the band's own rate;
                        selecting a second type does not dilute the first. */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">
                        Probation Leave Types
                        <span className="text-destructive ml-0.5">*</span>
                      </Label>
                      <Controller
                        control={control}
                        name="probation.probation_leave_type_ids"
                        render={({ field: f, fieldState }) => (
                          <div className="max-w-sm">
                            <SearchableSelect
                              multi
                              options={planLeaveTypes.map((lt: any) => ({
                                label: lt.name, value: lt._id,
                              }))}
                              value={f.value ?? []}
                              onChange={(v) => f.onChange((v as string[]) ?? [])}
                              placeholder={planId ? 'Select leave types' : 'Select on the plan'}
                              disabled={!planId}
                              searchable={planLeaveTypes.length > 5}
                              emptyMessage="No leave types in this plan"
                            />
                            {fieldState.error && (
                              <p className="text-xs text-destructive mt-1">{fieldState.error.message}</p>
                            )}
                          </div>
                        )}
                      />
                      <p className="text-xs text-muted-foreground">
                        During probation, employees are funded into and can apply for only these
                        leave types. All other types start once they're confirmed. Each selected
                        type is credited at the band amount below.
                      </p>
                    </div>

                    {/* Probation Duration */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">
                        Probation Duration Timeline (Months)
                        <span className="text-destructive ml-0.5">*</span>
                      </Label>
                      <Controller
                        control={control}
                        name="probation.probation_duration_months"
                        render={({ field: f, fieldState }) => (
                          <>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              className="h-9 text-sm w-36"
                              placeholder="e.g. 6"
                              value={f.value ?? ''}
                              onChange={stripZerosOnChange(f.onChange, { max: 100 })}
                              onBlur={f.onBlur}
                            />
                            {fieldState.error && (
                              <p className="text-xs text-destructive">{fieldState.error.message}</p>
                            )}
                          </>
                        )}
                      />
                      <p className="text-xs text-muted-foreground">
                        Adjust to define the maximum probation duration relevant for tiered credits.
                      </p>
                    </div>

                    {/* Band Configuration */}
                    <div className="space-y-3">
                      <p className="text-sm font-semibold">Band Configuration</p>
                      <p className="text-xs text-muted-foreground">
                        Each credit amount is added <span className="font-medium">per month</span> while that band is active.
                      </p>

                      {fields.map((field, index) => {
                        const fromMonth = bandRules[index]?.from_month ?? 0
                        const toMonth = bandRules[index]?.to_month ?? 0
                        const bandUnit = bandRules[index]?.unit ?? 'Days'
                        // The band amount is credited EACH month the band is active
                        // (not once for the whole band), so the ceiling is per-month —
                        // a single month can't grant more leave than its calendar days.
                        // Hours unit multiplies by 8.
                        const maxCreditDays = 31
                        const maxCredit = bandUnit === 'Hours' ? maxCreditDays * 8 : maxCreditDays
                        const creditVal = Number(bandRules[index]?.credit_amount) || 0
                        const creditExceeds = maxCredit > 0 && creditVal > maxCredit
                        return (
                          <div key={field.id} className="rounded-md border border-border p-3 space-y-2">
                            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
                              {/* Duration Band (read-only display) */}
                              <div>
                                <Label className="text-xs text-muted-foreground">Duration Band</Label>
                                <Input
                                  readOnly
                                  value={`${fromMonth}-${toMonth} Months`}
                                  className="h-9 text-sm bg-muted/50 cursor-default"
                                />
                              </div>

                              {/* Credit Amount */}
                              <div>
                                <Label className="text-xs text-muted-foreground">
                                  Credit Amount
                                  <span className="normal-case font-medium ml-1">(per month)</span>
                                  {maxCredit > 0 && (
                                    <span className="normal-case font-normal ml-1">
                                      (max {maxCredit} {bandUnit.toLowerCase()}/month)
                                    </span>
                                  )}
                                </Label>
                                <Controller
                                  control={control}
                                  name={`probation.band_rules.${index}.credit_amount`}
                                  render={({ field: f }) => (
                                    <Input
                                      type="number"
                                      min={0}
                                      step={0.5}
                                      max={maxCredit || undefined}
                                      className={cn(
                                        'h-9 text-sm',
                                        creditExceeds &&
                                          'border-destructive focus-visible:ring-destructive',
                                      )}
                                      value={
                                        f.value === null || f.value === undefined || (f.value as unknown) === ''
                                          ? ''
                                          : Number(f.value)
                                      }
                                      onChange={(e) => {
                                        const raw = e.target.value
                                        let num = raw === '' ? 0 : parseFloat(raw) || 0
                                        // Hard cap: clamp on change so the user
                                        // literally cannot store a value above the
                                        // band's allowed maximum.
                                        if (maxCredit > 0 && num > maxCredit) num = maxCredit
                                        // Canonicalise visible value so leading
                                        // zeros (e.g. "010" → "10") never stick.
                                        const canonical = raw === '' ? '' : String(num)
                                        if (raw !== canonical) e.target.value = canonical
                                        f.onChange(num)
                                      }}
                                    />
                                  )}
                                />
                                {creditExceeds && (
                                  <p className="text-[11px] text-destructive leading-4 mt-0.5">
                                    Cannot exceed {maxCredit} {bandUnit.toLowerCase()}/month
                                  </p>
                                )}
                              </div>

                              {/* Unit toggle (Days / Hours) */}
                              <div>
                                <Label className="text-xs text-muted-foreground">Unit</Label>
                                <Controller
                                  control={control}
                                  name={`probation.band_rules.${index}.unit`}
                                  render={({ field: f }) => (
                                    <div className="flex h-9 rounded-md border border-input overflow-x-auto">
                                      <button
                                        type="button"
                                        onClick={() => f.onChange('Days')}
                                        className={cn(
                                          'flex-1 px-3 text-sm transition-colors',
                                          f.value === 'Days'
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-background hover:bg-muted/50',
                                        )}
                                      >
                                        Days
                                      </button>
                                      {/* Hours option hidden */}
                                    </div>
                                  )}
                                />
                              </div>

                              {/* Delete */}
                              <div>
                                <Label className="text-xs text-muted-foreground"> </Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-9 w-9 text-destructive hover:bg-destructive/10"
                                  onClick={() => remove(index)}
                                >
                                  <Trash2  />
                                </Button>
                              </div>
                            </div>

                            {/* from_month / to_month editors */}
                            <div className="flex gap-3 flex-wrap">
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-muted-foreground">From month:</span>
                                  <Controller
                                    control={control}
                                    name={`probation.band_rules.${index}.from_month`}
                                    render={({ field: f, fieldState }) => (
                                      <>
                                        <Input
                                          type="number"
                                          min={0}
                                          className={cn('h-7 text-xs w-16', fieldState.error && 'border-destructive')}
                                          value={f.value}
                                          onChange={(e) => {
                                            const raw = e.target.value
                                            const num = parseInt(raw, 10) || 0
                                            const canonical = raw === '' ? '' : String(num)
                                            if (raw !== canonical) e.target.value = canonical
                                            f.onChange(num)
                                          }}
                                          onBlur={f.onBlur}
                                        />
                                        {fieldState.error && (
                                          <span className="text-xs text-destructive">{fieldState.error.message}</span>
                                        )}
                                      </>
                                    )}
                                  />
                                </div>
                              </div>
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-muted-foreground">To month:</span>
                                  <Controller
                                    control={control}
                                    name={`probation.band_rules.${index}.to_month`}
                                    render={({ field: f, fieldState }) => (
                                      <>
                                        <Input
                                          type="number"
                                          min={0}
                                          className={cn('h-7 text-xs w-16', fieldState.error && 'border-destructive')}
                                          value={f.value}
                                          onChange={(e) => {
                                            const raw = e.target.value
                                            const num = parseInt(raw, 10) || 0
                                            const canonical = raw === '' ? '' : String(num)
                                            if (raw !== canonical) e.target.value = canonical
                                            f.onChange(num)
                                          }}
                                          onBlur={f.onBlur}
                                        />
                                        {fieldState.error && (
                                          <span className="text-xs text-destructive">{fieldState.error.message}</span>
                                        )}
                                      </>
                                    )}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}

                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs"
                        disabled={
                          probationDurationMonths != null &&
                          bandRules.length > 0 &&
                          bandRules[bandRules.length - 1].to_month >= probationDurationMonths
                        }
                        onClick={() => {
                          const lastBand = bandRules[bandRules.length - 1]
                          const fromMonth = lastBand ? lastBand.to_month : 0
                          append({ from_month: fromMonth, to_month: fromMonth + 3, credit_amount: 0, unit: 'Days' })
                        }}
                      >
                        Add New Band
                      </Button>

                      {/* Preview — shows the per-month rate AND the resulting total,
                          since the amount is credited every month the band is active. */}
                      {fields.length > 0 && (() => {
                        const grandTotal = bandRules.reduce((sum, r) => {
                          const months = Math.max(0, (r.to_month ?? 0) - (r.from_month ?? 0))
                          return sum + (Number(r.credit_amount) || 0) * months
                        }, 0)
                        return (
                          <div className="space-y-1">
                            <p className="text-xs font-semibold text-muted-foreground">Preview:</p>
                            {bandRules.map((rule, i) => {
                              const months = Math.max(0, (rule.to_month ?? 0) - (rule.from_month ?? 0))
                              const perMonth = Number(rule.credit_amount) || 0
                              const unit = rule.unit?.toLowerCase() ?? 'days'
                              return (
                                <p key={i} className="text-xs text-muted-foreground">
                                  {rule.from_month}-{rule.to_month} Months: {perMonth} {unit}/month
                                  {months > 0 && (
                                    <span> → {perMonth * months} {unit} over {months} month{months > 1 ? 's' : ''}</span>
                                  )}
                                </p>
                              )
                            })}
                            <p className="text-xs font-medium text-foreground pt-1">
                              Total over probation: ≈ {grandTotal} days (per leave type)
                            </p>
                          </div>
                        )
                      })()}
                    </div>
                      </>
                    )}

                    {creditStart === 'confirmation_date' && (
                      <p className="text-xs text-muted-foreground rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
                        Leave credit will begin from the employee's confirmation date. Probation duration and band rules don't apply in this mode.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </RadioGroup>
          )}
        />
      </div>
    </SectionCard>
  )
}
