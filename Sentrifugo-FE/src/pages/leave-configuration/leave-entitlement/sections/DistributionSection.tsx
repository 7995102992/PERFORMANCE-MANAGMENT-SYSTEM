import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useFormContext, Controller, useFieldArray, useWatch } from 'react-hook-form'
import { Lock } from 'lucide-react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'
import { useGetLeavePlanLeaveTypesQuery, useGetGrantPolicyQuery } from '@/store/api/lmsApi'

const ACCRUAL_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'half_yearly', label: 'Half-Yearly' },
  { value: 'yearly', label: 'Yearly' },
] as const

const PERIODS_PER_YEAR: Record<string, number> = {
  monthly: 12,
  quarterly: 4,
  half_yearly: 2,
  yearly: 1,
}

const PERIOD_LABEL: Record<string, string> = {
  monthly: 'month',
  quarterly: 'quarter',
  half_yearly: '6 months',
  yearly: 'year',
}

const ROW_GRID = 'grid grid-cols-[minmax(0,1.3fr)_110px_150px_120px] gap-3'

// 1 day = 8 hours (standard working hours for unit conversion)
const HOURS_PER_DAY = 8

function convertToAllocUnit(value: number, rowUnit: string, allocUnit: string): number {
  if (rowUnit === 'Hours' && allocUnit === 'DAYS') return value / HOURS_PER_DAY
  if (rowUnit === 'Days' && allocUnit === 'HOURS') return value * HOURS_PER_DAY
  return value
}

// Display the numeric value with no leading zeros and an empty box for 0.
// Keeps a local string buffer so "0.5" / "0." stay typeable while "05" → "5".
function _toRaw(v: number | null | undefined): string {
  return v == null || v === 0 ? '' : String(v)
}

interface NumberValueInputProps {
  value: number | null | undefined
  onChange: (v: number) => void
  disabled?: boolean
  max?: number
  invalid?: boolean
  placeholder?: string
}

function NumberValueInput({
  value, onChange, disabled, max, invalid, placeholder = '0',
}: NumberValueInputProps) {
  const [raw, setRaw] = useState<string>(() => _toRaw(value))

  // Re-sync the buffer when the value changes from outside (form reset / row
  // reconcile) but not while the user is mid-edit (parsed buffer === value).
  useEffect(() => {
    const parsed = raw === '' ? 0 : parseFloat(raw)
    if (parsed !== (value ?? 0) && !Number.isNaN(parsed)) {
      setRaw(_toRaw(value))
    }
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Input
      type="number"
      min={0}
      step="any"
      disabled={disabled}
      max={max}
      className={cn(
        'h-9 text-sm w-full',
        invalid && 'border-destructive focus-visible:ring-destructive',
      )}
      placeholder={placeholder}
      value={raw}
      onChange={(e) => {
        let v = e.target.value
        // Strip leading zeros ("05" → "5") while preserving "0.x".
        if (v.length > 1 && v[0] === '0' && v[1] !== '.') {
          v = v.replace(/^0+/, '') || '0'
        }
        setRaw(v)
        const n = v === '' ? 0 : parseFloat(v)
        onChange(Number.isNaN(n) ? 0 : n)
      }}
    />
  )
}

// ─── Row component — memo'd so only the changed field re-renders ──────────────

interface RowProps {
  index: number
  statutory: boolean
  typeName: string | undefined
  maxStatutory: number | null
  allocationAmount: number | null
  allocUnit: string
}

const PostingCycleRow = memo(function PostingCycleRow({
  index,
  statutory,
  typeName,
  maxStatutory,
  allocationAmount,
  allocUnit,
}: RowProps) {
  const { control } = useFormContext<EntitlementFormValues>()
  const rowUnit = useWatch({ control, name: `distribution.posting_cycles.${index}.unit` }) ?? 'Days'
  const fieldValue = useWatch({ control, name: `distribution.posting_cycles.${index}.value` }) as number | null
  const rowFreq = useWatch({ control, name: `distribution.posting_cycles.${index}.accrual_frequency` }) as string | null
  const unitLabel = rowUnit === 'Hours' ? 'hrs' : 'days'
  const periodsPerYear = rowFreq ? PERIODS_PER_YEAR[rowFreq] ?? null : null
  const periodLabel = rowFreq ? PERIOD_LABEL[rowFreq] ?? null : null

  // Max per period expressed in the row's unit (only meaningful for non-statutory).
  const maxForRow: number | null = useMemo(() => {
    if (statutory) return maxStatutory
    if (allocationAmount === null || !periodsPerYear) return null
    const perPeriodInAllocUnit = allocationAmount / periodsPerYear
    if (allocUnit === 'DAYS' && rowUnit === 'Hours') return perPeriodInAllocUnit * HOURS_PER_DAY
    if (allocUnit === 'HOURS' && rowUnit === 'Days') return perPeriodInAllocUnit / HOURS_PER_DAY
    return perPeriodInAllocUnit
  }, [statutory, maxStatutory, allocationAmount, periodsPerYear, rowUnit, allocUnit])

  const val = Number(fieldValue) || 0
  const exceedsMax = !statutory && maxForRow !== null && val > maxForRow
  const annualized = !statutory && periodsPerYear && val > 0 ? val * periodsPerYear : null

  return (
    <div
      className={cn(
        ROW_GRID,
        'items-start px-4 py-2.5 border-b last:border-0',
        statutory && 'bg-muted/30',
      )}
    >
      {/* 1. Leave Type (name only — rows are the plan's selected leave types) */}
      <div className="min-w-0">
        <div className="h-9 flex items-center gap-2 text-sm text-foreground font-medium">
          <span className="truncate">{typeName ?? 'Leave type'}</span>
          {statutory && (
            <Badge className="shrink-0 text-[10px] px-1.5 py-0 h-4 font-medium bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">
              Statutory
            </Badge>
          )}
        </div>
      </div>

      {/* 2. Value */}
      <div className="min-w-0">
        <Controller
          control={control}
          name={`distribution.posting_cycles.${index}.value`}
          render={({ field: f }) => (
            <div>
              <NumberValueInput
                value={f.value as number | null}
                onChange={f.onChange}
                disabled={statutory}
                max={maxForRow ?? undefined}
                invalid={exceedsMax}
              />
              <div className="h-4 mt-0.5">
                {exceedsMax ? (
                  <p className="text-[11px] text-destructive leading-4">
                    Max {maxForRow !== null ? Number(maxForRow.toFixed(1)) : ''} {unitLabel}/{periodLabel ?? 'period'}
                  </p>
                ) : annualized ? (
                  <p className="text-[11px] text-muted-foreground leading-4">
                    = {Number(annualized.toFixed(1))} {unitLabel}/year
                  </p>
                ) : null}
              </div>
            </div>
          )}
        />
      </div>

      {/* 3. Accrual frequency (per leave type) */}
      <div className="min-w-0">
        {statutory ? (
          <div className="h-9 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-3.5 w-3.5" /> Annual
          </div>
        ) : (
          <Controller
            control={control}
            name={`distribution.posting_cycles.${index}.accrual_frequency`}
            render={({ field: f }) => (
              <Select value={f.value ?? ''} onValueChange={(v) => f.onChange(v || null)}>
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue placeholder="Frequency" />
                </SelectTrigger>
                <SelectContent>
                  {ACCRUAL_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        )}
      </div>

      {/* 4. Carry forward */}
      <div className="flex h-9 items-center">
        <Controller
          control={control}
          name={`distribution.posting_cycles.${index}.carry_forward`}
          render={({ field: f }) => (
            <div className="flex items-center gap-2">
              <Switch checked={!!f.value} onCheckedChange={f.onChange} />
              <span className="text-xs text-muted-foreground">
                {f.value ? 'Carries' : 'Lapses'}
              </span>
            </div>
          )}
        />
      </div>
    </div>
  )
})

// ─── Main section ─────────────────────────────────────────────────────────────

interface DistributionSectionProps {
  planId?: string
  onCapChange?: (isOverCap: boolean) => void
}

export function DistributionSection({ planId, onCapChange }: DistributionSectionProps) {
  const { control, getValues } = useFormContext<EntitlementFormValues>()
  const mode = useWatch({ control, name: 'distribution.mode' })
  const postingCycles = useWatch({ control, name: 'distribution.posting_cycles' }) ?? []

  const { data: leaveTypesRaw } = useGetLeavePlanLeaveTypesQuery(planId!, { skip: !planId })
  const { data: grantPolicy } = useGetGrantPolicyQuery(planId!, { skip: !planId })

  const leaveTypes = useMemo(
    () => (Array.isArray(leaveTypesRaw) ? leaveTypesRaw.map((t: any) => t.leave_type) : []),
    [leaveTypesRaw],
  )

  const allocationAmount: number | null = grantPolicy?.allocation?.amount ?? null
  const allocUnit: string = grantPolicy?.allocation?.unit ?? 'DAYS'
  const allocUnitLabel = allocUnit === 'HOURS' ? 'hrs' : 'days'

  const isStatutoryType = useCallback(
    (ltId: string) => leaveTypes.find((lt) => lt._id === ltId)?.is_statutory_leave ?? false,
    [leaveTypes],
  )

  const { fields, replace } = useFieldArray({
    control,
    name: 'distribution.posting_cycles',
  })

  // ── Keep the rows in sync with the plan's SELECTED leave types ──────────────
  // Every selected type gets exactly one row; existing rows keep their values,
  // newly-selected types are added, and de-selected types are dropped.
  useEffect(() => {
    if (!leaveTypes.length) return
    const current = (getValues('distribution.posting_cycles') ?? []) as any[]
    const byId = new Map(current.map((c) => [c.leave_type_id, c]))
    const selectedIds = leaveTypes.map((lt) => lt._id)
    const sameSet =
      current.length === selectedIds.length && selectedIds.every((id) => byId.has(id))
    if (sameSet) return

    const planFreq = (getValues('distribution.accrual_frequency') as string | null) ?? 'monthly'
    const next = leaveTypes.map((lt) => {
      const existing = byId.get(lt._id)
      if (existing) return existing
      return {
        leave_type_id: lt._id,
        value: lt.is_statutory_leave ? Number(lt.max_statutory_days ?? 0) : 0,
        unit: lt.unit === 'HOURS' ? 'Hours' : 'Days',
        accrual_frequency: lt.is_statutory_leave ? null : planFreq,
        carry_forward: false,
      }
    })
    replace(next)
  }, [leaveTypes]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cap validation: sum of non-statutory annualized must match the grant ────
  const annualizedNonStatutory = useMemo(
    () =>
      postingCycles
        .filter((c) => !isStatutoryType(c.leave_type_id))
        .reduce((sum, c) => {
          const inAlloc = convertToAllocUnit(Number(c.value) || 0, c.unit ?? 'Days', allocUnit)
          const periods = c.accrual_frequency ? PERIODS_PER_YEAR[c.accrual_frequency] ?? 1 : 1
          return sum + inAlloc * periods
        }, 0),
    [postingCycles, isStatutoryType, allocUnit],
  )

  const hasNonStatutoryRow = useMemo(
    () => postingCycles.some((c) => !isStatutoryType(c.leave_type_id)),
    [postingCycles, isStatutoryType],
  )

  const isOverCap = allocationAmount !== null && annualizedNonStatutory > allocationAmount + 1e-6
  const isUnderCap =
    allocationAmount !== null &&
    hasNonStatutoryRow &&
    annualizedNonStatutory < allocationAmount - 1e-6
  const hasCapMismatch = isOverCap || isUnderCap

  useEffect(() => {
    onCapChange?.(hasCapMismatch)
  }, [hasCapMismatch, onCapChange])

  const sortedIndices = useMemo(
    () =>
      [...fields.keys()].sort((a, b) => {
        const aS = isStatutoryType(fields[a].leave_type_id) ? 0 : 1
        const bS = isStatutoryType(fields[b].leave_type_id) ? 0 : 1
        return aS - bS
      }),
    [fields, isStatutoryType],
  )

  return (
    <SectionCard
      title="Leave Entitlement"
      description="Control how leave credits are distributed throughout the service year."
    >
      <div className="space-y-5">
        <Controller
          control={control}
          name="distribution.mode"
          render={({ field }) => (
            <RadioGroup value={field.value} onValueChange={field.onChange} className="space-y-3">
              <label
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors',
                  field.value === 'all_at_once'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/30',
                )}
              >
                <RadioGroupItem value="all_at_once" id="dist-all" className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">All at once</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Employees receive the full leave balance at the beginning of their service year.
                  </p>
                </div>
              </label>

              <label
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors',
                  field.value === 'step_by_step'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/30',
                )}
              >
                <RadioGroupItem value="step_by_step" id="dist-step" className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Step by step</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Employees accrue leave periodically. Set the accrual frequency and carry-forward
                    for each leave type below.
                  </p>
                </div>
              </label>
            </RadioGroup>
          )}
        />

        {mode === 'step_by_step' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Configure each leave type</p>
              <p className="text-xs text-muted-foreground">
                For every selected leave type, set how much accrues per period, how often it accrues,
                and whether the balance carries forward at year-end. Non-statutory totals are
                annualized and validated against the grant allocation
                {allocationAmount !== null && (
                  <span className="ml-1">
                    of <span className="font-medium text-foreground">{allocationAmount} {allocUnitLabel}/year</span>
                  </span>
                )}.
              </p>
            </div>

            <div className="rounded-xl border overflow-hidden">
              <div className={cn(ROW_GRID, 'px-4 py-2 bg-table-header border-b border-table-border')}>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Leave Type</span>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Value / period</span>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Accrual</span>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Carry forward</span>
              </div>

              {fields.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No leave types selected. Add leave types in the previous step first.
                </div>
              ) : (
                sortedIndices.map((index) => {
                  const field = fields[index]
                  const statutory = isStatutoryType(field.leave_type_id)
                  const leaveTypeMeta = leaveTypes.find((lt) => lt._id === field.leave_type_id)
                  const maxStatutory = statutory ? (leaveTypeMeta?.max_statutory_days ?? null) : null
                  return (
                    <PostingCycleRow
                      key={field.id}
                      index={index}
                      statutory={statutory}
                      typeName={leaveTypeMeta?.name}
                      maxStatutory={maxStatutory}
                      allocationAmount={allocationAmount}
                      allocUnit={allocUnit}
                    />
                  )
                })
              )}
            </div>

            {isOverCap && allocationAmount !== null && (
              <p id="accruals-cap-error" className="text-xs text-destructive">
                Total annualized non-statutory leave ({Number(annualizedNonStatutory.toFixed(1))} {allocUnitLabel}/year)
                exceeds the grant allocation of {allocationAmount} {allocUnitLabel}/year — reduce the per-period values.
              </p>
            )}
            {isUnderCap && allocationAmount !== null && (
              <p id="accruals-cap-error" className="text-xs text-destructive">
                Total annualized non-statutory leave ({Number(annualizedNonStatutory.toFixed(1))} {allocUnitLabel}/year)
                is less than the grant allocation of {allocationAmount} {allocUnitLabel}/year — allocate the remaining{' '}
                {Number((allocationAmount - annualizedNonStatutory).toFixed(1))} {allocUnitLabel} across the leave types.
              </p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}
