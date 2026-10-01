import { useEffect, useMemo } from 'react'
import { useFormContext, useFieldArray, Controller, useWatch } from 'react-hook-form'
import { Trash2 } from 'lucide-react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '../shared/SectionCard'
import type { EntitlementFormValues } from '../schema'
import { cn } from '@/lib/utils'
import { stripZerosOnChange } from '@/lib/number-input'

// Days per month (Feb = 29 so 29-Feb slabs are allowed) and cumulative
// start-of-month day-of-year offsets used to size a slab's date range.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const CUM_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// The API stores slab dates as "DD-MM" strings — the UI uses Day + Month
// dropdowns and converts at this boundary so the wire format never changes.
function parseDDMM(v: string | null | undefined): { d: number; m: number } | null {
  if (!v || !/^\d{2}-\d{2}$/.test(v)) return null
  const [d, m] = v.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > DAYS_IN_MONTH[m - 1]) return null
  return { d, m }
}

function toDDMM(d: number, m: number): string {
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}`
}

function dayOfYear(d: number, m: number): number {
  return CUM_DAYS[m - 1] + d
}

// Inclusive number of days the slab's [from, to] range covers, handling
// year-crossing ranges (e.g. Nov → Feb). null when either date is incomplete.
function daysInRange(from?: string | null, to?: string | null): number | null {
  const a = parseDDMM(from)
  const b = parseDDMM(to)
  if (!a || !b) return null
  const fa = dayOfYear(a.d, a.m)
  const tb = dayOfYear(b.d, b.m)
  return fa <= tb ? tb - fa + 1 : 366 - fa + 1 + tb
}

// Comparable month-day ordinal (MMDD) for overlap detection.
function ddmmToOrdinal(v: string | null | undefined): number | null {
  const p = parseDDMM(v)
  return p ? p.m * 100 + p.d : null
}

// Months (names) NOT fully covered by the union of the slab ranges. Every day
// of the year must fall inside some slab, so all 12 months are mandatory.
function uncoveredMonths(
  slabs: { from_date?: string; to_date?: string }[],
): string[] {
  const covered = new Array(367).fill(false)
  for (const r of slabs) {
    const a = parseDDMM(r.from_date)
    const b = parseDDMM(r.to_date)
    if (!a || !b) return [] // incomplete dates handled by per-row errors
    const fa = dayOfYear(a.d, a.m)
    const tb = dayOfYear(b.d, b.m)
    const mark = (s: number, e: number) => { for (let i = s; i <= e; i++) covered[i] = true }
    if (fa <= tb) mark(fa, tb)
    else { mark(fa, 366); mark(1, tb) }
  }
  const out: string[] = []
  for (let m = 1; m <= 12; m++) {
    const start = CUM_DAYS[m - 1] + 1
    const end = CUM_DAYS[m - 1] + DAYS_IN_MONTH[m - 1]
    let full = true
    for (let i = start; i <= end; i++) if (!covered[i]) { full = false; break }
    if (!full) out.push(MONTHS[m - 1])
  }
  return out
}

// ── Day + Month picker (reads/writes a single "DD-MM" string) ────────────────

function DateMonthPicker({
  value, onChange, invalid,
}: {
  value?: string | null
  onChange: (v: string) => void
  invalid?: boolean
}) {
  const parsed = parseDDMM(value)
  const day = parsed?.d ?? 0
  const month = parsed?.m ?? 0
  const maxDay = month ? DAYS_IN_MONTH[month - 1] : 31

  const setDay = (d: number) => onChange(toDDMM(d, month || 1))
  const setMonth = (m: number) => {
    const d = day ? Math.min(day, DAYS_IN_MONTH[m - 1]) : 1
    onChange(toDDMM(d, m))
  }

  const triggerCls = cn('h-9 text-sm', invalid && 'border-destructive focus-visible:ring-destructive')

  return (
    <div className="flex gap-2">
      <Select value={day ? String(day) : undefined} onValueChange={(v) => setDay(Number(v))}>
        <SelectTrigger className={cn(triggerCls, 'w-[72px]')}>
          <SelectValue placeholder="Day" />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <SelectItem key={d} value={String(d)}>{d}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={month ? String(month) : undefined} onValueChange={(v) => setMonth(Number(v))}>
        <SelectTrigger className={cn(triggerCls, 'w-[88px]')}>
          <SelectValue placeholder="Month" />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((label, i) => (
            <SelectItem key={label} value={String(i + 1)}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface MidYearJoinersSectionProps {
  planId?: string
  onCapChange?: (exceeded: boolean) => void
}

export function MidYearJoinersSection({ onCapChange }: MidYearJoinersSectionProps) {
  const { control } = useFormContext<EntitlementFormValues>()
  const mode = useWatch({ control, name: 'mid_year_joining.mode' })
  const slabRules = useWatch({ control, name: 'mid_year_joining.slab_rules' }) ?? []

  const { fields, append, remove, replace } = useFieldArray({
    control,
    name: 'mid_year_joining.slab_rules',
  })

  const isCreditMonth = mode === 'credit_joining_month'

  // Clear slab rules when leaving credit-joining-month so a hidden config can't
  // block submission.
  useEffect(() => {
    if (!isCreditMonth && slabRules.length > 0) replace([])
  }, [isCreditMonth, slabRules.length, replace])

  // Rows whose date range overlaps another row's range.
  const overlappingIndices = useMemo(() => {
    const overlapping = new Set<number>()
    const ranges = slabRules.map((r) => {
      const from = ddmmToOrdinal(r.from_date)
      const to = ddmmToOrdinal(r.to_date)
      if (from === null || to === null || from > to) return null
      return { from, to }
    })
    for (let i = 0; i < ranges.length; i++) {
      const a = ranges[i]
      if (!a) continue
      for (let j = i + 1; j < ranges.length; j++) {
        const b = ranges[j]
        if (!b) continue
        if (a.from <= b.to && b.from <= a.to) {
          overlapping.add(i)
          overlapping.add(j)
        }
      }
    }
    return overlapping
  }, [slabRules])

  // A slab is invalid when either date is missing, the allocation is negative,
  // or the allocation exceeds the number of days in the range. Allocation is
  // mandatory but 0 is allowed.
  const rowInvalid = (r: { from_date?: string; to_date?: string; allocation?: number | null }) => {
    const cap = daysInRange(r.from_date, r.to_date)
    if (cap === null) return true
    if (r.allocation === null || r.allocation === undefined) return true // mandatory
    const alloc = Number(r.allocation)
    if (Number.isNaN(alloc) || alloc < 0) return true
    if (alloc > cap) return true
    return false
  }

  const datesComplete = slabRules.every(
    (r) => parseDDMM(r.from_date) !== null && parseDDMM(r.to_date) !== null,
  )
  const uncovered = isCreditMonth && datesComplete ? uncoveredMonths(slabRules) : []
  const noSlabs = isCreditMonth && fields.length === 0
  const anyRowInvalid = isCreditMonth && slabRules.some(rowInvalid)
  const hasBlockingError =
    isCreditMonth &&
    (noSlabs || anyRowInvalid || overlappingIndices.size > 0 || uncovered.length > 0)

  useEffect(() => {
    onCapChange?.(hasBlockingError)
  }, [hasBlockingError, onCapChange])

  return (
    <SectionCard
      title="Leave for Mid-Year Joiners"
      description="Define how leave is allocated for employees joining mid-year."
    >
      <div className="space-y-5" data-invalid={hasBlockingError ? 'true' : undefined}>
        <Controller
          control={control}
          name="mid_year_joining.mode"
          render={({ field }) => (
            <RadioGroup
              value={field.value ?? ''}
              onValueChange={(v) => field.onChange(v || null)}
              className="space-y-2"
            >
              <label className="flex items-center gap-3 cursor-pointer">
                <RadioGroupItem value="pro_rate" id="mj-prorate" />
                <span className="text-sm">Pro-Rata by Joining Date</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <RadioGroupItem value="credit_joining_month" id="mj-credit-month" />
                <span className="text-sm">Credit for Joining Month</span>
              </label>
            </RadioGroup>
          )}
        />

        {isCreditMonth && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold">
                Slab Rules<span className="text-destructive ml-0.5">*</span>
              </p>
              <p className="text-xs text-muted-foreground">
                All 12 months must be covered — add one slab per month, one slab
                for the whole year, or any mix, with no gaps. Each allocation can
                be 0 but no more than the number of days its range spans.
              </p>
            </div>

            {noSlabs && (
              <p id="midyear-slab-error" className="text-sm text-destructive">
                Add at least one slab rule for Credit for Joining Month.
              </p>
            )}

            {!noSlabs && uncovered.length > 0 && (
              <p id="midyear-coverage-error" className="text-sm text-destructive">
                All 12 months must be covered. Not covered: {uncovered.join(', ')}.
              </p>
            )}

            <div className="space-y-3">
              {fields.map((field, index) => {
                const row = slabRules[index]
                const cap = daysInRange(row?.from_date, row?.to_date)
                const allocMissing = row?.allocation === null || row?.allocation === undefined
                const exceedsCap = cap !== null && !allocMissing && Number(row?.allocation) > cap
                const fromValid = parseDDMM(row?.from_date) !== null
                const toValid = parseDDMM(row?.to_date) !== null
                const overlaps = overlappingIndices.has(index)

                return (
                  <div
                    key={field.id}
                    className="rounded-lg border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-start gap-4">
                      <div>
                        <Label className="text-xs text-muted-foreground">From Date</Label>
                        <Controller
                          control={control}
                          name={`mid_year_joining.slab_rules.${index}.from_date`}
                          render={({ field: f }) => (
                            <DateMonthPicker
                              value={f.value}
                              onChange={f.onChange}
                              invalid={(!fromValid || overlaps)}
                            />
                          )}
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">To Date</Label>
                        <Controller
                          control={control}
                          name={`mid_year_joining.slab_rules.${index}.to_date`}
                          render={({ field: f }) => (
                            <DateMonthPicker
                              value={f.value}
                              onChange={f.onChange}
                              invalid={(!toValid || overlaps)}
                            />
                          )}
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          Allocation
                          {cap !== null && (
                            <span className="normal-case font-normal ml-1">
                              (max {cap} days)
                            </span>
                          )}
                        </Label>
                        <div className="flex items-center gap-2">
                          <Controller
                            control={control}
                            name={`mid_year_joining.slab_rules.${index}.allocation`}
                            render={({ field: f }) => (
                              <Input
                                type="number"
                                min={0}
                                step={0.5}
                                max={cap ?? undefined}
                                placeholder="e.g. 0"
                                className={cn(
                                  'h-9 text-sm w-28',
                                  (exceedsCap || allocMissing) &&
                                    'border-destructive focus-visible:ring-destructive',
                                )}
                                value={
                                  f.value === null || f.value === undefined || Number.isNaN(f.value)
                                    ? ''
                                    : f.value
                                }
                                onChange={stripZerosOnChange(f.onChange, { parse: 'float' })}
                              />
                            )}
                          />
                          <span className="text-xs text-muted-foreground">days</span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 mt-5 text-destructive hover:bg-destructive/10"
                        onClick={() => remove(index)}
                      >
                        <Trash2  />
                      </Button>
                    </div>

                    {/* Per-row error messages */}
                    {(!fromValid || !toValid) && (
                      <p className="text-[11px] text-destructive">Select both a From and To date.</p>
                    )}
                    {fromValid && toValid && overlaps && (
                      <p className="text-[11px] text-destructive">This range overlaps another slab.</p>
                    )}
                    {fromValid && toValid && allocMissing && (
                      <p className="text-[11px] text-destructive">Allocation is required (enter 0 or more).</p>
                    )}
                    {fromValid && toValid && !allocMissing && exceedsCap && cap !== null && (
                      <p className="text-[11px] text-destructive">
                        Allocation cannot exceed {cap} days (the length of this date range).
                      </p>
                    )}
                  </div>
                )
              })}

              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-8 text-xs"
                onClick={() => append({ from_date: '', to_date: '', allocation: null, unit: 'Days' })}
              >
                Add New Slab
              </Button>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  )
}
