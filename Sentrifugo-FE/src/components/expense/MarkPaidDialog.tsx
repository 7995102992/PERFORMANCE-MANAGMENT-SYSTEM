/**
 * The one dialog that records a payment — for a single expense and for a batch.
 *
 * It was a private function inside `GateActionBar`, which was correct while
 * settlement had exactly one entry point. Bulk settling a trip collects the
 * *same three fields* against the *same* `mark_paid` body, so a second dialog
 * would be a second copy of the reference/date validation and, worse, a second
 * place for the idempotency wording to drift from what the server actually does.
 * Lifted here rather than duplicated: two callers, one form.
 *
 * The overridable labels exist only so the batch caller can say *how many* rows
 * it is about to settle. Everything that decides behaviour — what is required,
 * what the body looks like — is fixed, because that part is the server's and
 * must not vary by caller.
 */
import { useState } from 'react'
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
import { Field } from './FormField'
import { formatMoney, isZeroAmount, toISODate } from '@/lib/expense-utils'

export interface MarkPaidDialogProps {
  open: boolean
  onClose: () => void
  netPayable?: string
  currency: string
  busy: boolean
  onConfirm: (payload: {
    payment_reference: string
    payment_date: string
    note?: string
  }) => void
  /** Defaults suit one expense; the batch caller renames them for many. */
  title?: string
  amountLabel?: string
  confirmLabel?: string
  /** An extra line under the amount — what exactly is about to be settled. */
  description?: React.ReactNode
  /** Replaces the zero-amount explanation, which is written for one claim. */
  zeroNote?: string
}

export function MarkPaidDialog({
  open,
  onClose,
  netPayable,
  currency,
  busy,
  onConfirm,
  title = 'Record payment',
  amountLabel = 'Net payable',
  confirmLabel = 'Mark Paid',
  description,
  zeroNote = 'An advance covers this claim in full. Recording a zero-value settlement is correct and closes the expense.',
}: MarkPaidDialogProps) {
  const [reference, setReference] = useState('')
  const [date, setDate] = useState(toISODate(new Date()))
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<{ reference?: string; date?: string }>({})

  const close = () => {
    setReference('')
    setNote('')
    setErrors({})
    onClose()
  }

  const confirm = () => {
    const next: { reference?: string; date?: string } = {}
    if (!reference.trim()) next.reference = 'Payment reference is required'
    if (!date) next.date = 'Payment date is required'
    setErrors(next)
    if (Object.keys(next).length) return
    onConfirm({
      payment_reference: reference.trim(),
      payment_date: date,
      note: note.trim() || undefined,
    })
  }

  const zero = isZeroAmount(netPayable)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 px-4 py-3">
            <p className="text-xs text-muted-foreground">{amountLabel}</p>
            <p className="text-xl font-bold text-foreground">
              {formatMoney(netPayable ?? '0', currency)}
            </p>
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            )}
            {/* A zero net payable is legitimate — an advance covered the claim.
                The screen must not read as an error or a no-op (§9.8). */}
            {zero && <p className="mt-1 text-xs text-muted-foreground">{zeroNote}</p>}
          </div>

          <Field
            label="Payment Reference"
            required
            error={errors.reference}
            hint="Idempotent on this reference — replaying it is a no-op, not a second payment."
          >
            <Input
              id="pay-ref"
              className="h-9"
              value={reference}
              onChange={(e) => {
                setReference(e.target.value)
                setErrors((prev) => ({ ...prev, reference: undefined }))
              }}
              placeholder="NEFT-99120"
            />
          </Field>

          <Field label="Payment Date" required error={errors.date}>
            <DatePicker
              value={date}
              onChange={(v) => {
                setDate(v)
                setErrors((prev) => ({ ...prev, date: undefined }))
              }}
            />
          </Field>

          <div className="space-y-2">
            <Label htmlFor="pay-note">Note</Label>
            <Textarea
              id="pay-note"
              className="min-h-[70px] resize-none"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
