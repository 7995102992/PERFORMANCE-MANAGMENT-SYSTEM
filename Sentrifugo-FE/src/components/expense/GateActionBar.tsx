/**
 * The approval action bar — shared by expenses, trips and advances (§18.1 G).
 *
 * **The server decides what appears here.** Every row and detail response
 * carries `available_actions`, computed from where the caller stands on *this*
 * record crossed with the record's *current* state. The client renders that
 * subset and nothing else — never a role flag, never an inference from status.
 * Two consequences worth stating, because both are easy to undo by accident:
 *
 * - A status the client has not been taught about degrades to view-only rather
 *   than offering an illegal action.
 * - A missing Approve is missing because the server omitted it, not because a
 *   `role === 'finance'` check hid it. Hiding a button is a convenience; the
 *   server's transition table is the control (§15).
 *
 * There is no client-side narrowing of that list left. The old bar removed
 * Approve itself when the org's leadership mode was `required`, which was a
 * second, drifting copy of a rule the server already enforced. Under the
 * configurable ladder there is no fixed Finance rung to special-case anyway:
 * whether this caller may sign, escalate, or only look is exactly what
 * `available_actions` says.
 *
 * **Send to Leadership takes no target.** It means "sign my rung and open the
 * optional one above it". Who receives it comes from the org's chain, so the
 * dialog is a confirmation with an optional reason and the request body carries
 * only that reason — the forwarder never sees or picks the names
 * (`approval-rule-config.md` §1.1, §8).
 *
 * One component across three subjects because the approval engine is one
 * implementation and the request bodies are already identical — three UIs over
 * one engine is how they drift.
 */
import { useState } from 'react'
import {
  Archive,
  CircleCheck,
  CircleX,
  CornerUpLeft,
  Info,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Field } from './FormField'
import { MarkPaidDialog } from './MarkPaidDialog'
import { formatMoney } from '@/lib/expense-utils'
import type { GateAction, SubjectType } from '@/types/expense'

export interface GateHandlers {
  onApprove?: (note?: string) => Promise<void>
  onReject: (reason: string) => Promise<void>
  onSendBack: (note: string) => Promise<void>
  /** No target — the org's approval rule resolves the recipients server-side. */
  onForward?: (reason?: string) => Promise<void>
  onRecall?: () => Promise<void>
  onMarkPaid?: (payload: {
    payment_reference: string
    payment_date: string
    note?: string
  }) => Promise<void>
  onSubmit?: () => Promise<void>
  /**
   * End the record's life — a trip's own tail, with no gate behind it.
   *
   * `AdvanceDetailSheet` filters `close` out before it gets here and renders its
   * own, so in practice this is the trip's. Left on the shared bar all the same:
   * it is an action the server publishes in `available_actions` like any other,
   * and the one place it was *not* rendered is how it came to be unreachable.
   */
  onClose?: () => Promise<void>
}

interface Props {
  subjectType: SubjectType
  availableActions: (GateAction | string)[]
  handlers: GateHandlers
  context?: {
    /**
     * The record's `blocked_reason` — why its chain cannot progress, in the
     * server's words (an empty rung, say). Rendered as a note beneath the
     * buttons so an approver who finds the bar unexpectedly bare is told why,
     * instead of being left to guess. Never composed here: the reason names
     * configuration the client cannot see.
     */
    blockedReason?: string | null
    hasAdvance?: boolean
    advanceApplied?: string
    netPayable?: string
    currency?: string
    /** Rendered next to Approve where the caller may adjust — the adjust panel. */
    approveSlot?: React.ReactNode
    /**
     * The org's name for the level `forward` would open, from the server.
     *
     * The button was hard-coded to *Send to Leadership*, which held only while
     * the three gates were fixed. The level above Finance is now whatever the
     * org named it, so the word comes from the record. The server derives it
     * from the same `escalation_after` call that decides whether `forward` is
     * offered at all, which is why this is never null when the button shows.
     */
    escalationLevelName?: string | null
  }
  disabled?: boolean
  /**
   * Button height, for the one surface that mounts this bar in a toolbar.
   *
   * The bar was born as a footer and its buttons are footer-sized. The trip
   * drawer now carries its approval actions in the header row beside Export,
   * which is `size="sm"` — a default-height Approve next to a small Export reads
   * as a mistake rather than as emphasis. A prop rather than a `[&_button]:h-9`
   * override on the caller, because the height belongs to the button and a
   * descendant selector would silently reach the dialogs' buttons too.
   */
  size?: 'default' | 'sm'
}

export function GateActionBar({
  subjectType,
  availableActions,
  handlers,
  context = {},
  disabled = false,
  size = 'default',
}: Props) {
  // Applied to every button in the row so the toolbar variant cannot end up
  // half-converted — the failure a per-button className invites.
  const compact = size === 'sm'
  const sizing = {
    size: compact ? ('sm' as const) : undefined,
    className: compact ? 'h-9' : undefined,
  }
  const [dialog, setDialog] = useState<
    | null
    | 'reject'
    | 'send_back'
    | 'forward'
    | 'recall'
    | 'mark_paid'
    | 'submit'
    | 'close'
  >(null)
  const [busy, setBusy] = useState(false)

  const has = (a: string) => availableActions.includes(a as GateAction)

  // Falls back only for a record rendered before the server sent the name — an
  // older cached row, say. It never reads as a level the org does not have.
  const escalationTarget = context.escalationLevelName?.trim() || 'the next level'
  const forwardLabel = `Send for ${escalationTarget}`
  // Named, not just "Close": this bar sits beside a footer button of that word
  // meaning *dismiss the drawer*, and the two are not remotely the same act.
  const closeLabel = subjectType === 'trip' ? 'Close Trip' : 'Close'
  const currency = context.currency ?? 'INR'

  const run = async (fn: () => Promise<void>, successMsg: string) => {
    setBusy(true)
    try {
      await fn()
      toast.success(successMsg)
      setDialog(null)
    } catch (err) {
      // Keyed on the CODE, not the status. The service returns 409 for several
      // unrelated refusals — an unconfigured approval chain, a chain that cannot
      // clear — and every one of them carries a sentence the person can act on.
      // Reading the status alone told all of them "this record changed while you
      // were looking at it", which is both wrong and unactionable: nothing had
      // changed, and refreshing fixes none of them.
      if (errorCode(err) === 'VERSION_CONFLICT') {
        toast.error('This record changed while you were looking at it. Refreshing…')
      } else {
        toast.error(errorDetail(err) ?? 'That action could not be completed')
      }
    } finally {
      setBusy(false)
    }
  }

  const anyAction =
    has('approve') ||
    has('reject') ||
    has('send_back') ||
    has('forward') ||
    has('recall') ||
    has('mark_paid') ||
    has('submit') ||
    has('close')

  // A record whose chain cannot progress should say so, rather than presenting
  // an empty bar and leaving the approver to wonder (§18.1 F).
  const blockedReason = context.blockedReason?.trim()

  if (!anyAction && !blockedReason) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {has('submit') && (
          <Button
            {...sizing}
            disabled={disabled || busy}
            onClick={() => setDialog('submit')}
          >
            Submit
          </Button>
        )}

        {has('approve') && (
          <>
            {context.approveSlot}
            <Button
              {...sizing}
              className={cn('gap-1.5', sizing.className)}
              disabled={disabled || busy}
              onClick={() => run(() => handlers.onApprove!(), 'Approved')}
            >
              <CircleCheck className="size-4" />
              Approve
            </Button>
          </>
        )}

        {has('forward') && (
          <Button
            variant="outline"
            {...sizing}
            className={cn('gap-1.5', sizing.className)}
            disabled={disabled || busy}
            onClick={() => setDialog('forward')}
          >
            <Users className="size-4" />
            {forwardLabel}
          </Button>
        )}

        {has('recall') && (
          <Button
            variant="outline"
            {...sizing}
            className={cn('gap-1.5', sizing.className)}
            disabled={disabled || busy}
            onClick={() => setDialog('recall')}
          >
            {/* Red icon on an outline button — the same shape Reject uses
                (CLAUDE.md §6). Withdrawing pulls a submitted claim back out of
                the chain and discards every approval already given on it, so it
                should not read as neutral as Send Back. */}
            <Undo2 className="size-4 text-destructive" />
            Withdraw
          </Button>
        )}

        {/* Send back must not read like Reject: one is a correction, the other
            is terminal and unrecoverable (§6 step 7). */}
        {has('close') && (
          <Button
            variant="outline"
            {...sizing}
            className={cn('gap-1.5', sizing.className)}
            disabled={disabled || busy}
            onClick={() => setDialog('close')}
          >
            <Archive className="size-4" />
            {closeLabel}
          </Button>
        )}

        {has('send_back') && (
          <Button
            variant="outline"
            {...sizing}
            className={cn('gap-1.5', sizing.className)}
            disabled={disabled || busy}
            onClick={() => setDialog('send_back')}
          >
            <CornerUpLeft className="size-4" />
            Send Back
          </Button>
        )}

        {has('reject') && (
          <Button
            variant="outline"
            {...sizing}
            className={cn('gap-1.5', sizing.className)}
            disabled={disabled || busy}
            onClick={() => setDialog('reject')}
          >
            <CircleX className="size-4 text-destructive" />
            Reject
          </Button>
        )}

        {has('mark_paid') && (
          <Button
            {...sizing}
            className={cn('gap-1.5', sizing.className)}
            disabled={disabled || busy}
            onClick={() => setDialog('mark_paid')}
          >
            <Wallet className="size-4" />
            Mark Paid
          </Button>
        )}
      </div>

      {blockedReason && (
        <p className="mt-2 inline-flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {blockedReason}
        </p>
      )}

      {/* ── Submit ────────────────────────────────────────────────────────── */}
      <ConfirmDialog
        open={dialog === 'submit'}
        onClose={() => setDialog(null)}
        title={`Submit this ${subjectType}?`}
        body="It will go to your reporting manager for approval. You will not be able to edit it while it is in flight."
        confirmLabel="Submit"
        busy={busy}
        onConfirm={() => run(() => handlers.onSubmit!(), 'Submitted for approval')}
      />

      {/* ── Reject — terminal, so it confirms and Cancel takes focus ──────── */}
      <ReasonDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title={`Reject this ${subjectType}?`}
        description="Rejection is final. The employee cannot edit or resubmit this record — they would have to raise a new one."
        label="Reason"
        required
        destructive
        confirmLabel="Reject"
        busy={busy}
        onConfirm={(reason) => run(() => handlers.onReject(reason), 'Rejected')}
      />

      {/* ── Send back — non-terminal, but it releases the advance draw ────── */}
      <ReasonDialog
        open={dialog === 'send_back'}
        onClose={() => setDialog(null)}
        title="Send back for changes"
        description={
          context.hasAdvance
            ? `This returns the record to the employee as a draft and releases its advance draw${
                context.advanceApplied
                  ? ` of ${formatMoney(context.advanceApplied, currency)}`
                  : ''
              } back to their available balance. A comment is the lighter option if you only need a question answered.`
            : 'This returns the record to the employee as a draft. A comment is the lighter option if you only need a question answered.'
        }
        label="What needs to change?"
        required
        confirmLabel="Send Back"
        busy={busy}
        onConfirm={(note) => run(() => handlers.onSendBack(note), 'Sent back to the employee')}
      />

      {/* ── Send to Leadership ────────────────────────────────────────────
          Same dialog as Send Back and Reject, with the reason left optional —
          there is nothing else to collect. The recipients come from the org's
          rule, so naming them here would both leak the rule and risk disagreeing
          with what the server actually resolves at forward time. */}
      <ReasonDialog
        open={dialog === 'forward'}
        onClose={() => setDialog(null)}
        title={`${forwardLabel}?`}
        description={`This records your approval and sends the claim for ${escalationTarget}. Approving instead ends the chain here — you cannot send it up afterwards.`}
        label="Reason"
        hint="Optional — it is shown to the approvers alongside the record."
        confirmLabel={forwardLabel}
        busy={busy}
        onConfirm={(reason) =>
          run(() => handlers.onForward!(reason || undefined), `Sent for ${escalationTarget}`)
        }
      />

      {/* ── Withdraw ──────────────────────────────────────────────────────
          The claimant taking back their own claim. It was Finance's undo of a
          forward under the three fixed gates, and the wording still described
          that: it asked about recalling "from leadership", on a dialog only the
          claimant can open, and cited a restriction that no longer exists.
          The action is still `recall` on the wire — see the union above. */}
      <ConfirmDialog
        open={dialog === 'recall'}
        onClose={() => setDialog(null)}
        title="Withdraw this claim?"
        body="It returns to your drafts, where you can edit and resubmit it. Approval starts again from the first level. Once anyone has approved, it can no longer be withdrawn."
        confirmLabel="Withdraw"
        busy={busy}
        onConfirm={() => run(() => handlers.onRecall!(), 'Withdrawn')}
      />

      {/* ── Close ─────────────────────────────────────────────────────────── */}
      {/* Confirmed because there is no way back: the status table has no
          transition out of CLOSED, so this is the record's last state. The body
          says what survives — everything — because "close" reads as *delete* to
          anyone who has not been told otherwise. */}
      <ConfirmDialog
        open={dialog === 'close'}
        onClose={() => setDialog(null)}
        title={subjectType === 'trip' ? 'Close this trip?' : 'Close this record?'}
        body="Nothing is deleted or detached. It stays readable and exportable, and expenses already on it can still be settled — but no new expense can be attached or submitted against it, and it cannot be reopened."
        confirmLabel={closeLabel}
        busy={busy}
        onConfirm={() => run(() => handlers.onClose!(), 'Closed')}
      />

      {/* ── Mark paid ─────────────────────────────────────────────────────── */}
      <MarkPaidDialog
        open={dialog === 'mark_paid'}
        onClose={() => setDialog(null)}
        netPayable={context.netPayable}
        currency={currency}
        busy={busy}
        onConfirm={(payload) => run(() => handlers.onMarkPaid!(payload), 'Payment recorded')}
      />
    </>
  )
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  body: string
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{body}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy} autoFocus>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReasonDialog({
  open,
  onClose,
  title,
  description,
  label,
  required,
  hint,
  destructive,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  label: string
  required?: boolean
  /** Shown under an optional field, so "no asterisk" is not the only signal. */
  hint?: string
  destructive?: boolean
  confirmLabel: string
  busy: boolean
  onConfirm: (value: string) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  const close = () => {
    setValue('')
    setError('')
    onClose()
  }

  const confirm = () => {
    if (required && !value.trim()) {
      setError(`${label} is required`)
      return
    }
    onConfirm(value.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="py-2">
          <Field
            label={label}
            required={required}
            hint={hint}
            error={error || undefined}
          >
            <Textarea
              id="reason-field"
              className="min-h-[90px] resize-none"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                if (error) setError('')
              }}
            />
          </Field>
        </div>
        <DialogFooter>
          {/* Cancel takes focus on the destructive path — the danger action is
              never what Enter triggers. */}
          <Button variant="outline" onClick={close} autoFocus={destructive}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'outline' : 'default'}
            className={
              destructive
                ? 'border-destructive text-destructive hover:bg-destructive/10'
                : undefined
            }
            disabled={busy}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The service's own error code, keyed on rather than parsed out of the text. */
function errorCode(err: unknown): string | null {
  const code = (err as { data?: { code?: unknown } })?.data?.code
  return typeof code === 'string' ? code : null
}

function errorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  return null
}
