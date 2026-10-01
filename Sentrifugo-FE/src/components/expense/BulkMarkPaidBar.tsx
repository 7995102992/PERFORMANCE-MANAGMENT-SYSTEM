/**
 * Batch settlement for Finance (§18.1 C).
 *
 * Settlement is the one action Finance performs in batches, and one-at-a-time
 * will not survive contact with a real month-end. Two behaviours matter:
 *
 * - **The total shown is net payable, not claimed.** That is the money actually
 *   leaving, and it is what the approver is authorising.
 * - **The response is per-row, not a single verdict.** Rows settle
 *   independently so one stale row cannot abort the run, and an already-settled
 *   row is a *skip*, not a failure — rendering it as an error would train
 *   Finance to ignore the dialog.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useBulkMarkPaidMutation } from '@/store/api/expenseApi'
import { formatMoney, toISODate } from '@/lib/expense-utils'
import type { BulkMarkPaidResponse, ExpenseRow } from '@/types/expense'

interface Props {
  selectedIds: string[]
  rows: ExpenseRow[]
  currency: string
  onDone: () => void
}

export function BulkMarkPaidBar({ selectedIds, rows, currency, onDone }: Props) {
  const [open, setOpen] = useState(false)
  const [reference, setReference] = useState('')
  const [date, setDate] = useState(toISODate(new Date()))
  const [note, setNote] = useState('')
  const [result, setResult] = useState<BulkMarkPaidResponse | null>(null)

  const [bulkMarkPaid, { isLoading }] = useBulkMarkPaidMutation()

  const selectedRows = rows.filter((r) => selectedIds.includes(r.id))
  const totalNet = selectedRows.reduce(
    (sum, r) => sum + Number(r.net_payable ?? r.approved_amount ?? r.claimed_amount ?? 0),
    0,
  )

  const submit = async () => {
    try {
      const res = await bulkMarkPaid({
        expense_ids: selectedIds,
        payment_reference: reference.trim(),
        payment_date: date,
        note: note.trim() || undefined,
      }).unwrap()
      setResult(res)
      if (res.settled > 0) {
        toast.success(`${res.settled} expense${res.settled === 1 ? '' : 's'} settled`)
      }
    } catch {
      toast.error('Could not settle the selected expenses')
    }
  }

  const closeAll = () => {
    setOpen(false)
    setResult(null)
    setReference('')
    setNote('')
    onDone()
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b bg-primary/5 px-4 py-2.5">
        <span className="text-sm font-medium text-foreground">
          {selectedIds.length} selected
        </span>
        <span className="text-sm text-muted-foreground">
          · net payable {formatMoney(String(totalNet), currency)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            Clear
          </Button>
          <Button size="sm" onClick={() => setOpen(true)}>
            Mark Paid
          </Button>
        </div>
      </div>

      {/* Collect the payment, then report per-row outcomes in the same dialog. */}
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeAll())}>
        <DialogContent className="sm:max-w-[480px]">
          {result ? (
            <>
              <DialogHeader>
                <DialogTitle>Settlement complete</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-2">
                <Outcome
                  icon={CheckCircle}
                  tone="text-success"
                  text={`${result.settled} settled`}
                />
                {result.skipped > 0 && (
                  <Outcome
                    icon={AlertTriangle}
                    tone="text-warning"
                    text={`${result.skipped} skipped — already settled or no longer approved`}
                  />
                )}
                {result.failed > 0 && (
                  <Outcome
                    icon={XCircle}
                    tone="text-destructive"
                    text={`${result.failed} failed`}
                  />
                )}

                {result.outcomes.some((o) => !o.settled) && (
                  <div className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-lg border p-3">
                    {result.outcomes
                      .filter((o) => !o.settled)
                      .map((o) => (
                        <p key={o.expense_id} className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {o.expense_id.slice(-6)}
                          </span>{' '}
                          — {o.detail ?? o.code ?? 'not settled'}
                        </p>
                      ))}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button onClick={closeAll}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Mark {selectedIds.length} expenses paid</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="rounded-lg border bg-muted/30 px-4 py-3">
                  <p className="text-xs text-muted-foreground">Total net payable</p>
                  <p className="text-xl font-bold text-foreground">
                    {formatMoney(String(totalNet), currency)}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="bulk-ref">
                    Payment Reference <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="bulk-ref"
                    className="h-9"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="NEFT-99120"
                  />
                  <p className="text-xs text-muted-foreground">
                    Settlement is idempotent on this reference — replaying it is a
                    no-op, not a second payment.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>
                    Payment Date <span className="text-destructive">*</span>
                  </Label>
                  <DatePicker value={date} onChange={setDate} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="bulk-note">Note</Label>
                  <Textarea
                    id="bulk-note"
                    className="min-h-[80px] resize-none"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeAll}>
                  Cancel
                </Button>
                <Button
                  onClick={submit}
                  disabled={!reference.trim() || !date || isLoading}
                >
                  {isLoading ? 'Settling…' : 'Mark Paid'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Outcome({
  icon: Icon,
  tone,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>
  tone: string
  text: string
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`size-4 ${tone}`} />
      <span>{text}</span>
    </div>
  )
}
