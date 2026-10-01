/**
 * The verification pass's shared UI — the two reason dialogs and the rung
 * readout, used by both surfaces that can now act on a mark.
 *
 * All three lived in `TripDetailSheet` while the trip's expense table was the
 * only place verification happened. The expense drawer opens over that table
 * now instead of navigating away from it, so the same expense can be marked,
 * refused or unmarked from either — and a second copy of *"undoing takes every
 * mark above it with it"* or of *"this clears every mark"* is exactly the copy
 * that gets updated in one place and not the other. The consequence text is the
 * only warning a person gets before a destructive verification action; it has to
 * be one string.
 *
 * `VerificationCell` is not a dialog and sits here anyway: it is the same shared
 * concern — the trip's table column and the expense drawer's header must not
 * disagree about which rungs have signed — and a third module holding one
 * component would only make that pair easier to overlook.
 *
 * Both dialogs take an `ExpenseRow`, which `ExpenseDetail` extends, so the row
 * the table holds and the detail the drawer holds go in unchanged.
 */
import { useState } from 'react'
import { AlertTriangle, Check, Clock, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Field } from './FormField'
import { formatDateTime } from '@/lib/expense-utils'
import { cn } from '@/lib/utils'
import type { ExpenseRow, VerificationState } from '@/types/expense'

/**
 * How far an expense has got through the trip's verification pass.
 *
 * Every required level is drawn, marked or not — the unmarked ones are what
 * tell a reader *who they are still waiting on*, and a column showing only the
 * signatures collected would read as complete at every stage. The order is the
 * server's; it is the ticked levels in rung order, which is not the same as the
 * chain's numbering (§1).
 */
export function VerificationCell({
  state,
}: {
  state?: VerificationState | null
}) {
  if (!state || state.required_levels.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>
  }

  // Said out loud rather than shown as a row of empty ticks. A marker looking at
  // a line with nothing on it cannot tell "nobody has got to this yet" from
  // "the claimant has not finished it", and only one of those is theirs to act
  // on — an unexplained missing button reads as a broken screen.
  if (state.awaiting_claimant) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" />
        With the claimant
      </span>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {state.required_levels.map((mark) => (
        <span
          key={mark.level}
          className={cn(
            'inline-flex items-center gap-1 text-xs',
            mark.marked ? 'text-success' : 'text-muted-foreground',
          )}
          // Who signed and when, without a column apiece. The rail carries the
          // same facts permanently; this is the glance.
          title={
            mark.marked
              ? `Marked by ${mark.actor?.name ?? 'an approver'} · ${formatDateTime(mark.at)}`
              : 'Not yet marked'
          }
        >
          {mark.marked ? (
            <Check className="size-3.5 shrink-0" />
          ) : (
            <Minus className="size-3.5 shrink-0" />
          )}
          {mark.name}
        </span>
      ))}
    </div>
  )
}

/**
 * Confirmation for undoing a mark, because undoing one is not local to it.
 *
 * **Every mark above it goes too.** A higher level marked on the strength of the
 * one beneath, so withdrawing the lower withdraws what rested on it — the same
 * principle as a send-back discarding the decisions beneath it. That is a
 * destructive action in the §6 sense and cannot be a bare button click.
 *
 * The reason is required rather than optional because of who reads it: the
 * levels whose marks this sweeps away are not here and are not asked. Their only
 * account of why their signature disappeared is the timeline row this writes, so
 * an empty one leaves the record saying a mark was withdrawn by somebody, for
 * nothing. That is why the confirm stays disabled until something is typed
 * instead of validating on press — a button that refuses after the click reads
 * as a fault, where a disabled one names its own condition.
 *
 * A Dialog rather than a nested Sheet, per §8.
 */
export function UndoMarkDialog({
  expense,
  busy,
  onClose,
  onConfirm,
}: {
  expense: ExpenseRow | null
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const above = expense?.verification
    ? expense.verification.required_levels.filter((m) => m.marked).length - 1
    : 0

  return (
    <ReasonConfirmDialog
      open={Boolean(expense)}
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Undo this verification?"
      body={
        above > 0
          ? `Your mark on ${expense?.display_id} is removed, and so ${
              above === 1 ? 'is the mark' : `are the ${above} marks`
            } given above it — each was given on the strength of yours. The expense goes back to waiting on your level.`
          : `Your mark on ${expense?.display_id} is removed and the expense goes back to waiting on your level. It can be marked again at any time.`
      }
      label="Why are you undoing this?"
      hint="Recorded on the expense and the trip, where the levels above you will read it."
      confirmLabel="Undo mark"
    />
  )
}

/**
 * Refusing the rung: the expense goes back to its claimant as a draft.
 *
 * The action verification had no button for. A trip expense is never submitted,
 * so the approval chain never opens on it and neither Reject nor Send Back is
 * ever among its actions — a verifier who would not pass a row could previously
 * only decline to press Verify, which records nothing and tells nobody. This is
 * the counterpart, and it is deliberately *not* worded as a rejection: the claim
 * survives, it is the claimant's again, and they can fix it and hand it back.
 *
 * The body names both consequences because both surprise people. The row leaving
 * the marker's queue is the obvious half; **every mark on it being cleared** is
 * the half nobody expects — including marks below this rung, given by levels who
 * will not be told until they look. The server does that on purpose (the figures
 * those signatures were given against are about to be edited), so the person
 * pressing it should not learn it afterwards from the timeline.
 */
export function NotVerifiedDialog({
  expense,
  busy,
  onClose,
  onConfirm,
}: {
  expense: ExpenseRow | null
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const marked = expense?.verification
    ? expense.verification.required_levels.filter((m) => m.marked).length
    : 0

  return (
    <ReasonConfirmDialog
      open={Boolean(expense)}
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Send this back as not verified?"
      body={
        `${expense?.display_id} returns to its claimant as a draft for them to correct and hand over again. ` +
        (marked > 0
          ? `${marked === 1 ? 'The one mark' : `All ${marked} marks`} already on it ${
              marked === 1 ? 'is' : 'are'
            } cleared — they were given against figures that are about to change — so verification restarts from the first level.`
          : 'Verification restarts from the first level when they do.') +
        ' Its advance stays reserved; nothing is paid out or released.'
      }
      label="Why is this not verified?"
      hint="The claimant sees this — it is the only thing telling them what to fix."
      confirmLabel="Send back"
    />
  )
}

/**
 * The shape both of the above wear: §8 Variant A, plus a mandatory reason.
 *
 * Not `GateActionBar`'s `ReasonDialog`. That one belongs to the approval chain
 * and carries its optional-reason and non-destructive paths; these two are
 * always destructive and always require a reason, so reusing it would mean
 * threading it through a second surface to keep three unused branches alive.
 * What they share instead is the *rule* — Cancel takes focus, the confirm is an
 * outline button with destructive tokens rather than a red block (§6), and the
 * footer verb says what happens (§8).
 */
function ReasonConfirmDialog({
  open,
  busy,
  title,
  body,
  label,
  hint,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  title: string
  body: string
  label: string
  hint: string
  confirmLabel: string
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [wasOpen, setWasOpen] = useState(open)

  // Cleared on *open*, not on close, and during render rather than in an effect.
  //
  // Both callers keep this mounted and toggle it by swapping the target expense,
  // so without a reset the state survives between openings and a reason
  // abandoned on one row arrives pre-filled on the next — sent, if nobody
  // notices, under a signature it was never written for. Clearing on close
  // instead would be worse: a failed confirm leaves the dialog open with the
  // server's refusal to read, and the text the person has to correct must still
  // be there.
  //
  // This is React's own "reset state when a prop changes" pattern rather than an
  // effect. An effect would render the stale reason once, then blank it on a
  // second pass — visible on a slow frame, and a cascading render the lint rule
  // exists to stop.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setReason('')
  }

  const filled = reason.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 shrink-0 text-warning" />
            <DialogTitle>{title}</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{body}</p>
        <div className="py-1">
          <Field label={label} required hint={hint}>
            <Textarea
              className="min-h-[80px] resize-none"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          {/* Cancel takes focus — the destructive action is never what Enter
              triggers, and here Enter is a key the person is already using. */}
          <Button variant="outline" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            disabled={busy || !filled}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
