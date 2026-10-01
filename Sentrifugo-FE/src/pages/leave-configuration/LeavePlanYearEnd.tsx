import { forwardRef, useImperativeHandle, useEffect, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useGetLeavePlanLeaveTypesQuery } from '@/store/api/lmsApi'

export interface LeavePlanYearEndHandle {
  triggerSubmit: () => Promise<boolean>
  scrollToFirstError: () => void
}

interface Props {
  planId?: string
  onDirtyChange?: (dirty: boolean) => void
}

interface Row {
  id: string
  name: string
  color: string
  unit: string
  annual: number | null
  isStatutory: boolean
  carryForward: boolean
  count: number | null
  encashable: boolean
  encashPct: number | null
}

function AmountCell({
  value, sub, tone, dim,
}: {
  value: string
  sub: string
  tone: string
  dim?: boolean
}) {
  return (
    <div className="text-right">
      <div className={`text-sm font-semibold leading-tight ${dim ? 'text-muted-foreground' : tone}`}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{sub}</div>
    </div>
  )
}

const LeavePlanYearEnd = forwardRef<LeavePlanYearEndHandle, Props>(
  function LeavePlanYearEnd({ planId, onDirtyChange }, ref) {
    const { data: leaveTypesData } = useGetLeavePlanLeaveTypesQuery(planId!, { skip: !planId })

    // This step is read-only — it never has unsaved edits.
    useEffect(() => {
      onDirtyChange?.(false)
    }, [onDirtyChange])

    const rows = useMemo<Row[]>(() => {
      const arr = Array.isArray(leaveTypesData) ? leaveTypesData : []
      return arr
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((t: any) => t.leave_type)
        .filter(Boolean)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((lt: any) => {
          const acc = lt.accrual ?? {}
          return {
            id: lt._id,
            name: lt.name,
            color: lt.color ?? '#94a3b8',
            unit: lt.unit === 'HOURS' ? 'hrs' : 'days',
            annual: acc.annual_count ?? null,
            isStatutory: !!lt.is_statutory_leave,
            carryForward: !!acc.carry_forward,
            count: acc.carry_forward_count ?? null,
            encashable: !!acc.encashable,
            encashPct: acc.encash_percentage ?? null,
          }
        })
    }, [leaveTypesData])

    // Year-end behaviour is derived entirely from the leave types — this step is
    // a read-only overview, so there is nothing to save.
    useImperativeHandle(ref, () => ({
      scrollToFirstError: () => {},
      triggerSubmit: async () => true,
    }))

    // ── Per-type year-end split (illustrated using the yearly allocation) ────
    const toDays = (n: number, unit: string) => (unit === 'hrs' ? n / 8 : n)
    const fmt = (n: number) => Number(n.toFixed(1))
    const computed = rows.map((r) => {
      const annual = r.annual
      const carries = !r.isStatutory && r.carryForward
      const isEncash = r.encashable && !r.isStatutory
      const carryAmt = carries && annual != null ? Math.min(annual, r.count ?? annual) : 0
      const leftover = annual != null ? annual - carryAmt : 0
      const encashAmt = isEncash && r.encashPct != null ? (leftover * r.encashPct) / 100 : 0
      const resetAmt = annual != null ? leftover - encashAmt : 0
      return { r, annual, carries, isEncash, carryAmt, encashAmt, resetAmt }
    })
    const totalCarry = computed.reduce((s, c) => s + toDays(c.carryAmt, c.r.unit), 0)
    const totalEncash = computed.reduce((s, c) => s + toDays(c.encashAmt, c.r.unit), 0)
    const totalReset = computed.reduce((s, c) => s + toDays(c.resetAmt, c.r.unit), 0)

    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Year End Leave Processing Overview</CardTitle>
          <CardDescription>
            What happens to unused leave at year-end is defined on each leave type
            (its carry-forward and encashment settings). This is a summary of what
            will happen for the leave types in this plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No leave types assigned to this plan yet. Add them in the “Assign Leave
              Types” step.
            </p>
          ) : (
            <>
              {/* Totals (per employee, illustrated on a full year's allocation) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3">
                  <p className="text-2xl font-bold leading-none text-success">
                    {fmt(totalCarry)}<span className="text-sm font-normal text-muted-foreground ml-1.5">days</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1.5">Carried forward</p>
                </div>
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
                  <p className="text-2xl font-bold leading-none text-primary">
                    {fmt(totalEncash)}<span className="text-sm font-normal text-muted-foreground ml-1.5">days</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1.5">Encashed</p>
                </div>
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
                  <p className="text-2xl font-bold leading-none text-warning">
                    {fmt(totalReset)}<span className="text-sm font-normal text-muted-foreground ml-1.5">days</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1.5">Reset / expired</p>
                </div>
              </div>

              {/* Per-type overview */}
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="grid grid-cols-[minmax(0,1.6fr)_1fr_1fr_1fr] gap-4 px-4 py-2.5 bg-muted/40 border-b border-border">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Leave Type</span>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground text-right">Carry forward</span>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground text-right">Encash</span>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground text-right">Reset</span>
                </div>

                {computed.map(({ r, annual, carries, isEncash, carryAmt, encashAmt, resetAmt }) => {
                  const v = (n: number) => `${fmt(n)} ${r.unit}`
                  return (
                    <div
                      key={r.id}
                      className="grid grid-cols-[minmax(0,1.6fr)_1fr_1fr_1fr] gap-4 items-center px-4 py-3 border-b border-border last:border-0"
                    >
                      {/* Leave type */}
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                        <div className="min-w-0">
                          <span className="text-sm font-medium truncate block">{r.name}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {annual != null ? `${annual} ${r.unit}/yr` : r.isStatutory ? 'Statutory' : '—'}
                          </span>
                        </div>
                      </div>
                      <AmountCell
                        value={carries && annual != null ? v(carryAmt) : '—'}
                        sub={carries ? `up to ${r.count ?? '—'} ${r.unit}` : r.isStatutory ? 'does not carry' : 'lapses'}
                        tone="text-success"
                        dim={!carries || annual == null}
                      />
                      <AmountCell
                        value={isEncash && annual != null ? v(encashAmt) : '—'}
                        sub={isEncash && r.encashPct != null ? `${r.encashPct}% of leftover` : 'not encashable'}
                        tone="text-primary"
                        dim={!isEncash || annual == null}
                      />
                      <AmountCell
                        value={annual != null && resetAmt > 0 ? v(resetAmt) : annual != null ? `0 ${r.unit}` : '—'}
                        sub="resets at year-end"
                        tone="text-warning"
                        dim={resetAmt <= 0 || annual == null}
                      />
                    </div>
                  )
                })}

                {/* Total row */}
                <div className="grid grid-cols-[minmax(0,1.6fr)_1fr_1fr_1fr] gap-4 items-center px-4 py-3 bg-muted/50 border-t-2 border-border">
                  <span className="text-sm font-bold">
                    Total <span className="text-[10px] font-normal text-muted-foreground">/ employee / year</span>
                  </span>
                  <AmountCell value={`${fmt(totalCarry)} days`} sub="carried" tone="text-success" dim={totalCarry <= 0} />
                  <AmountCell value={`${fmt(totalEncash)} days`} sub="encashed" tone="text-primary" dim={totalEncash <= 0} />
                  <AmountCell value={`${fmt(totalReset)} days`} sub="reset" tone="text-warning" dim={totalReset <= 0} />
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Figures assume a full year's allocation per employee. At year-end the same split is applied to each employee's actual unused balance.
              </p>
              <p className="text-[11px] text-muted-foreground">
                To change any of this, edit the leave type → <span className="font-medium">Accrual &amp; Carry-Forward</span>{' '}
                (carry forward, how many, and encashment).
              </p>
            </>
          )}
        </CardContent>
      </Card>
    )
  },
)

export default LeavePlanYearEnd
