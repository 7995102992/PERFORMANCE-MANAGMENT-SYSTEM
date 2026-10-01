/**
 * Return Advance (§9.7) — the employee pays back what they did not spend.
 *
 * **The employee initiates the return**, not the manager. Two rules make the
 * ledger reconcilable, and both are visible in this form rather than only
 * enforced behind it:
 *
 * - **Return To is locked to the advance's disburser.** Money goes back where
 *   it came from; an arbitrary recipient would make the advance ledger
 *   impossible to reconcile.
 * - **A return can never exceed the current balance.** Capped here for the
 *   employee's benefit, and refused server-side under an optimistic version
 *   guard — so two concurrent returns cannot overdraw between them (§19.8).
 *
 * The picker lists only the caller's own advances with a non-zero balance.
 * Returning the last of it closes the advance.
 */
import { useEffect, useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { Field } from './FormField'
import {
  useGetPaymentModesQuery,
  useGetReturnableAdvancesQuery,
  useReturnAdvanceMutation,
} from '@/store/api/expenseApi'
import { compareDecimal, formatMoney } from '@/lib/expense-utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-select an advance when opened from its detail page. */
  presetAdvanceId?: string
}

export function ReturnAdvanceSheet({
  open,
  onOpenChange,
  presetAdvanceId,
}: Props) {
  const [advanceId, setAdvanceId] = useState(presetAdvanceId ?? '')
  const [amount, setAmount] = useState('')
  const [paymentMode, setPaymentMode] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const { data: advances = [], isLoading: advancesLoading } =
    useGetReturnableAdvancesQuery(undefined, { skip: !open })
  const { data: paymentModes = [] } = useGetPaymentModesQuery()
  const [returnAdvance, { isLoading: returning }] = useReturnAdvanceMutation()

  useEffect(() => {
    if (open && presetAdvanceId) setAdvanceId(presetAdvanceId)
  }, [open, presetAdvanceId])

  const selected = useMemo(
    () => advances.find((a) => a.advance_id === advanceId),
    [advances, advanceId],
  )

  const exceedsBalance = Boolean(
    selected && amount && compareDecimal(amount, selected.balance) > 0,
  )

  const reset = () => {
    setAdvanceId('')
    setAmount('')
    setPaymentMode('')
    setPaymentReference('')
    setDescription('')
    setErrors({})
  }

  const close = () => {
    reset()
    onOpenChange(false)
  }

  /** Drop a field's error as soon as the employee corrects it. */
  const clearError = (key: string) =>
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })

  /** Required-field check, surfaced on the fields rather than by a dead button. */
  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!advanceId) next.advanceId = 'Advance is required'
    if (!amount || Number(amount) <= 0) next.amount = 'Valid amount is required'
    else if (exceedsBalance && selected) {
      next.amount = `Cannot exceed the current balance of ${formatMoney(selected.balance)}.`
    }
    if (!paymentMode) next.paymentMode = 'Payment mode is required'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const save = async () => {
    if (!validate() || !selected) return
    try {
      await returnAdvance({
        id: selected.advance_id,
        body: {
          amount,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || null,
          // Locked to the disburser; sent explicitly so the server records who
          // the money went back to rather than inferring it.
          returned_to_employee_id: selected.returned_to?.id ?? null,
          description: description.trim() || null,
        },
      }).unwrap()
      toast.success('Return recorded')
      close()
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not record this return')
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <SheetContent className="flex flex-col p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>Return Advance</SheetTitle>
          <SheetDescription>
            Pay back unused funds. Returning the full balance closes the advance.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Advance ID"
              required
              error={errors.advanceId}
              hint="Only your own advances that still carry a balance."
            >
              <SearchableSelect
                options={advances.map((a) => ({
                  label: `${a.display_id ?? a.advance_id} · ${formatMoney(
                    a.balance,
                  )} balance`,
                  value: a.advance_id,
                }))}
                value={advanceId}
                onChange={(v) => {
                  setAdvanceId(v as string)
                  setAmount('')
                  clearError('advanceId')
                }}
                placeholder={
                  advancesLoading ? 'Loading…' : 'Select Advance ID'
                }
                emptyMessage="No advances with a balance to return"
                loading={advancesLoading}
              />
            </Field>

            <Field label="Amount" required error={errors.amount}>
              <Input
                className="h-9"
                type="number"
                min="0"
                step="0.01"
                max={selected?.balance}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  clearError('amount')
                }}
                placeholder="Enter Amount"
                disabled={!selected}
              />
              {!errors.amount && selected ? (
                <p className="text-xs text-muted-foreground">
                  Balance {formatMoney(selected.balance)}
                </p>
              ) : null}
            </Field>

            <Field label="Payment Mode" required error={errors.paymentMode}>
              <Select
                value={paymentMode}
                onValueChange={(v) => {
                  setPaymentMode(v)
                  clearError('paymentMode')
                }}
                disabled={!selected}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select Payment" />
                </SelectTrigger>
                <SelectContent>
                  {paymentModes
                    .filter((m) => m.active)
                    .map((m) => (
                      <SelectItem key={m.code} value={m.code}>
                        {m.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Payment Ref#">
              <Input
                className="h-9"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="Enter Payment Ref"
                disabled={!selected}
              />
            </Field>

            {/* Pre-filled and locked — the disburser is the only valid
                recipient, so this is displayed rather than chosen. */}
            <Field label="Return To" required>
              <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3">
                <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm text-foreground">
                  {selected?.returned_to?.name ??
                    (selected ? 'Whoever disbursed this advance' : '—')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Money goes back to whoever disbursed it, so the ledger
                reconciles.
              </p>
            </Field>

            <div className="col-span-2 space-y-2">
              <Label htmlFor="return-description">Add Description</Label>
              <Textarea
                id="return-description"
                className="min-h-[80px] resize-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button
            className="bg-[#EAE6FF] text-foreground hover:bg-[#EAE6FF]/90"
            disabled={returning}
            onClick={save}
          >
            {returning ? 'Recording…' : 'Return'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function errorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  return null
}
