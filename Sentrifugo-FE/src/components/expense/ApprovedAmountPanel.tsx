/**
 * Finance's Gate-2 amount adjustment (§18.1 B) — the substance of Gate 2, and
 * absent from every wireframe.
 *
 * The point of the live preview: lowering the approved amount also **trues up
 * the advance draw** (§9.6), so the approver should see the money returning to
 * the employee's advance *before* they commit, not discover it afterwards. The
 * preview endpoint recomputes `advance_applied` and `net_payable` without
 * writing anything.
 *
 * `approved_amount` is constrained to `≤ claimed_amount` here and enforced
 * server-side — the employee's claim is never raised by an approver, and the
 * claimed figure is never overwritten (§19.2).
 */
import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useDebounce } from '@/hooks/use-debounce'
import { usePreviewApprovedAmountMutation } from '@/store/api/expenseApi'
import { compareDecimal, formatMoney } from '@/lib/expense-utils'
import type { SettlementPreviewResponse } from '@/types/expense'

interface Props {
  expenseId: string
  claimedAmount: string
  currency: string
  /** Current settlement figures, before any adjustment. */
  baseline: SettlementPreviewResponse
  /** Lifted so the action bar's Approve can send them. */
  onChange: (value: { approvedAmount: string; reason: string; valid: boolean }) => void
}

export function ApprovedAmountPanel({
  expenseId,
  claimedAmount,
  currency,
  baseline,
  onChange,
}: Props) {
  const [amount, setAmount] = useState(baseline.approved_amount || claimedAmount)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<SettlementPreviewResponse | null>(null)

  const debouncedAmount = useDebounce(amount, 400)
  const [runPreview, { isLoading }] = usePreviewApprovedAmountMutation()

  const exceedsClaim = compareDecimal(amount || '0', claimedAmount) > 0
  const isAdjusted = amount !== claimedAmount && amount !== ''
  const valid = !exceedsClaim && amount !== '' && Number(amount) >= 0

  useEffect(() => {
    onChange({ approvedAmount: amount, reason, valid })
    // `onChange` is a fresh closure each render at the call site; tracking it
    // would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, reason, valid])

  useEffect(() => {
    if (!valid || !isAdjusted) {
      setPreview(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await runPreview({
          id: expenseId,
          approved_amount: debouncedAmount,
        }).unwrap()
        if (!cancelled) setPreview(res)
      } catch {
        if (!cancelled) setPreview(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedAmount, expenseId, valid, isAdjusted])

  const effective = preview ?? baseline

  return (
    <div className="space-y-4 rounded-xl border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Claimed Amount</Label>
          {/* Never overwritten and never hidden — the employee's assertion is
              evidence in a dispute (§19.2). */}
          <p className="text-lg font-semibold text-foreground">
            {formatMoney(claimedAmount, currency)}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="approved-amount">Approved Amount</Label>
          <Input
            id="approved-amount"
            className="h-9"
            type="number"
            min="0"
            step="0.01"
            max={claimedAmount}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {exceedsClaim && (
            <p className="text-xs text-destructive">
              Cannot exceed the claimed amount of{' '}
              {formatMoney(claimedAmount, currency)}.
            </p>
          )}
        </div>
      </div>

      {/* The downstream effect, before committing. */}
      <div className="space-y-1.5 border-t pt-3">
        <PreviewRow
          label="Payable"
          value={formatMoney(effective.payable, currency)}
        />
        {Number(effective.advance_applied) > 0 && (
          <PreviewRow
            label="Advance applied"
            value={`− ${formatMoney(effective.advance_applied, currency)}`}
          />
        )}
        <PreviewRow
          label="Net payable"
          value={formatMoney(effective.net_payable, currency)}
          emphasis
          pending={isLoading}
        />

        {/* The ₹1,000 going back to the employee's advance — the reason this
            preview exists at all. */}
        {preview &&
          Number(baseline.advance_applied) > Number(preview.advance_applied) && (
            <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <ArrowRight className="size-3.5" />
              {formatMoney(
                String(
                  Number(baseline.advance_applied) - Number(preview.advance_applied),
                ),
                currency,
              )}{' '}
              returns to the employee&rsquo;s advance balance.
            </p>
          )}
      </div>

      {isAdjusted && (
        <div className="space-y-2">
          <Label htmlFor="adjust-reason">Reason for adjustment</Label>
          <Textarea
            id="adjust-reason"
            className="min-h-[60px] resize-none"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Recorded against the approval in the record's history"
          />
        </div>
      )}
    </div>
  )
}

function PreviewRow({
  label,
  value,
  emphasis,
  pending,
}: {
  label: string
  value: string
  emphasis?: boolean
  pending?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={
          emphasis
            ? 'text-sm font-medium text-foreground'
            : 'text-sm text-muted-foreground'
        }
      >
        {label}
      </span>
      <span
        className={`${
          emphasis ? 'text-base font-bold text-foreground' : 'text-sm text-foreground'
        } ${pending ? 'opacity-50' : ''}`}
      >
        {value}
      </span>
    </div>
  )
}
