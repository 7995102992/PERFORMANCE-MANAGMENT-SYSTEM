/**
 * Read-only expense detail, shown as a right-side drawer when a row is opened.
 *
 * Owner view: Export / Edit in the header, Cancel / Submit in the footer. All
 * config values (type, category, payment mode) are resolved to their display
 * names from the same API the form uses, never shown as raw codes.
 *
 * **It is also a verification surface now.** This drawer opens over the trip's
 * expense table rather than replacing it, so the person who was marking rows
 * down there is the same person reading a line up here — and they arrived
 * precisely because the row was one they wanted to look at properly before
 * signing it. Sending them back to the table to act would make opening a row the
 * thing that costs you the action.
 *
 * Every one of those buttons is drawn from a `verification` flag the server
 * sent, never from `status` and never from a role. The client cannot answer "is
 * this rung mine?" — it does not know who the awaiting level resolves to on
 * *this* record, nor who left the mark below it — and a local guess would be a
 * second copy of the sequencing rule, free to offer buttons the server refuses.
 * Same contract as `available_actions`, same reasoning.
 */
import { useState } from 'react'
import {
  CircleCheck,
  CircleSlash,
  Download,
  FileText,
  Pencil,
  Send,
  Undo2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  useGetExpenseCategoriesQuery,
  useGetExpenseQuery,
  useGetExpenseTypesQuery,
  useGetPaymentModesQuery,
  useGetReceiptDownloadUrlMutation,
  useSubmitExpenseMutation,
  useApproveExpenseMutation,
  useRejectExpenseMutation,
  useSendBackExpenseMutation,
  useForwardExpenseMutation,
  useRecallExpenseMutation,
  useMarkExpensePaidMutation,
  useVerifyExpenseMutation,
  useUnverifyExpenseMutation,
  useNotVerifyExpenseMutation,
  useMarkExpenseReadyMutation,
  useUnreadyExpenseMutation,
} from '@/store/api/expenseApi'
import { ApprovalLadder } from './ApprovalLadder'
import { ApprovalTimeline } from './ApprovalTimeline'
import { CommentThread } from './CommentThread'
import { GateActionBar } from './GateActionBar'
import { ApprovedAmountPanel } from './ApprovedAmountPanel'
import { ExpenseStatusChip } from './ExpenseStatusChip'
import {
  NotVerifiedDialog,
  UndoMarkDialog,
  VerificationCell,
} from './VerificationDialogs'
import { formatDate, formatMoney } from '@/lib/expense-utils'
import { useEmployeeNames } from '@/hooks/use-employee-names'
import type {
  ActorSnapshot,
} from '@/types/expense'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  expenseId: string | null
  /** Opens the edit form for this expense. */
  onEdit?: (expenseId: string) => void
}

export function ExpenseDetailSheet({
  open,
  onOpenChange,
  expenseId,
  onEdit,
}: Props) {
  // Lifted out of ApprovedAmountPanel so Approve can send the adjusted figure.
  const [adjust, setAdjust] = useState<{
    approvedAmount: string
    reason: string
    valid: boolean
  } | null>(null)

  const { data: expense } = useGetExpenseQuery(expenseId!, { skip: !expenseId })
  const { data: types = [] } = useGetExpenseTypesQuery()
  const { data: categories = [] } = useGetExpenseCategoriesQuery()
  const { data: paymentModes = [] } = useGetPaymentModesQuery()
  const [submitExpense, { isLoading: submitting }] = useSubmitExpenseMutation()
  const [approveExpense] = useApproveExpenseMutation()
  const [rejectExpense] = useRejectExpenseMutation()
  const [sendBackExpense] = useSendBackExpenseMutation()
  const [forwardExpense] = useForwardExpenseMutation()
  const [recallExpense] = useRecallExpenseMutation()
  const [markExpensePaid] = useMarkExpensePaidMutation()
  const [getDownloadUrl] = useGetReceiptDownloadUrlMutation()

  // ── The trip verification pass ────────────────────────────────────────────
  const [verifyExpense, { isLoading: verifying }] = useVerifyExpenseMutation()
  const [unverifyExpense, { isLoading: unverifying }] = useUnverifyExpenseMutation()
  const [notVerifyExpense, { isLoading: refusing }] = useNotVerifyExpenseMutation()
  const [markReady, { isLoading: sendingReady }] = useMarkExpenseReadyMutation()
  const [unready, { isLoading: takingBack }] = useUnreadyExpenseMutation()
  /** Which reason dialog is open — neither can be open at once by construction. */
  const [verificationDialog, setVerificationDialog] = useState<
    null | 'undo' | 'not_verified'
  >(null)
  const verificationBusy =
    verifying || unverifying || refusing || sendingReady || takingBack

  const nameOf = (
    list: { code: string; name: string }[],
    code?: string | null,
  ) => (code ? (list.find((x) => x.code === code)?.name ?? code) : '—')

  const closeSheet = () => onOpenChange(false)

  const handleSubmit = async () => {
    if (!expense) return
    try {
      await submitExpense(expense.id).unwrap()
      toast.success('Expense submitted for approval')
      closeSheet()
    } catch (err) {
      // Verbatim. The refusals that reach here name what is wrong and who can
      // fix it — an approval chain the organisation never configured, a level
      // that resolves to nobody — and a generic sentence throws away the only
      // part the claimant can act on.
      toast.error(errorDetail(err) ?? 'Could not submit this expense')
    }
  }

  /**
   * Whether to offer the approved-amount panel.
   *
   * This used to ask "is the record at the Finance gate?", which a ladder cannot
   * answer: there is no fixed second rung to call Finance, and the block carries
   * no flag naming the rung that may cut the amount. What it does carry is the
   * caller's legal actions on *this* record, so the panel is offered wherever the
   * server says this person may approve. The server stays the control — it
   * honours an adjustment only where the chain allows one, and only downward
   * (§19.2). This is the convenience, not the gate.
   */
  // Server-declared, not derived. `available_actions` includes 'approve' for
  // every approver at every rung; only the money-grant holder standing on the
  // open rung may cut the figure, and the server refuses the rest.
  const canAdjustAmount = expense?.can_adjust_amount ?? false
  const settlementPreview = expense?.settlement_preview

  const handlers = {
    onApprove: async (note?: string) => {
      if (!expense) return
      await approveExpense({
        id: expense.id,
        body: {
          note,
          // Sent only when the approver actually touched the figure; the server
          // honours it downward only (§19.2) and ignores it at a rung with no
          // say over the amount.
          approved_amount:
            canAdjustAmount && adjust?.valid ? adjust.approvedAmount : undefined,
          adjustment_reason:
            canAdjustAmount && adjust?.reason ? adjust.reason : undefined,
        },
      }).unwrap()
      closeSheet()
    },
    onReject: async (reason: string) => {
      if (!expense) return
      await rejectExpense({ id: expense.id, body: { reason } }).unwrap()
      closeSheet()
    },
    onSendBack: async (note: string) => {
      if (!expense) return
      await sendBackExpense({ id: expense.id, body: { note } }).unwrap()
      closeSheet()
    },
    // Escalating names nobody: the org's chain decides which rung opens next and
    // who sits on it, so only the reason travels.
    onForward: async (reason?: string) => {
      if (!expense) return
      await forwardExpense({ id: expense.id, body: { reason } }).unwrap()
      closeSheet()
    },
    onRecall: async () => {
      if (!expense) return
      await recallExpense(expense.id).unwrap()
      closeSheet()
    },
    onMarkPaid: async (payload: { payment_reference: string; payment_date: string; note?: string }) => {
      if (!expense) return
      await markExpensePaid({ id: expense.id, body: payload }).unwrap()
      closeSheet()
    },
  }

  /**
   * The trip this expense hangs off, for invalidation only.
   *
   * `VERIFICATION_WIDE(id, tripId)` is what makes the trip's table, its rollup
   * and *both* timelines refresh — every verification action writes a history
   * row against the trip as well as the expense. Without the trip id the
   * invalidation still runs, just more broadly than it needs to; with it, the
   * row behind this drawer is already correct by the time the drawer closes,
   * which is the whole point of acting from here rather than from the table.
   */
  const tripId = expense?.trip?.trip_id ?? undefined

  /**
   * Every verification action ends the same way: say what happened, then get out
   * of the way.
   *
   * Closing rather than staying open is deliberate. All five actions move the
   * record to somewhere this view no longer describes — a mark advances the rung
   * the header is showing, Ready freezes the record, Not verified hands it to
   * somebody else entirely — and a drawer that lingers on stale flags invites a
   * second press of a button the server will now refuse. The table underneath is
   * already refreshed, so closing lands the person on the truth.
   *
   * **Never navigate.** This drawer is frequently stacked over the trip's, and
   * a route change would take that with it — which is exactly the behaviour the
   * in-place drawer replaced.
   */
  const runVerification = async (
    fn: () => Promise<unknown>,
    successMsg: string,
    failMsg: string,
  ) => {
    try {
      await fn()
      toast.success(successMsg)
      setVerificationDialog(null)
      closeSheet()
    } catch (err) {
      // Verbatim, as everywhere else in this module: a refusal here names the
      // rung, the missing receipt or the mark that already landed, and only the
      // server's own sentence tells the person which.
      toast.error(errorDetail(err) ?? failMsg)
    }
  }

  const openReceipt = async (receiptId: string) => {
    try {
      const res = await getDownloadUrl(receiptId).unwrap()
      window.open(res.url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error('Could not open that receipt')
    }
  }

  const currency = expense?.currency ?? 'INR'
  const live = (expense?.receipts ?? []).filter((r) => !r.deleted)

  const { codeFor } = useEmployeeNames()

  /**
   * "Anita Desai (SGS0142)" — the code appended only when the IAM pool can
   * resolve it, so an unresolved id degrades to the plain name rather than to
   * empty brackets. The name itself comes off the decision's own snapshot, so
   * the trail still reads correctly after somebody leaves.
   */
  const actorLabel = (actor?: ActorSnapshot | null): string => {
    if (!actor) return '—'
    const name = actor.name ?? '—'
    const code = codeFor(actor.id)
    return code ? `${name} (${code})` : name
  }

  const fields: { label: string; value: string }[] = expense
    ? [
        { label: 'Expense Type', value: nameOf(types, expense.expense_type_code) },
        { label: 'Category', value: nameOf(categories, expense.category_code) },
        { label: 'Project', value: expense.project?.name ?? '—' },
        { label: 'Client', value: expense.client?.name ?? '—' },
        { label: 'Expense Date', value: formatDate(expense.expense_date) },
        { label: 'Amount', value: formatMoney(expense.claimed_amount, currency) },
        {
          label: 'Payment Mode',
          value: nameOf(paymentModes, expense.payment_mode),
        },
        { label: 'Claim Reimbursement', value: expense.reimbursable ? 'Yes' : 'No' },
        { label: 'Payment Ref#', value: expense.payment_reference || '—' },
        {
          label: 'Select Advance',
          value: expense.advance?.applied_amount
            ? formatMoney(expense.advance.applied_amount, currency)
            : '—',
        },
        {
          label: 'Add To Trip',
          value: expense.trip?.name ?? (expense.trip ? 'Yes' : 'No'),
        },
        // The claimant's manager, who is whoever a `reporting_manager` rung
        // resolves to on *this* record. It is the one part of a chain that is
        // not org-wide, so the ladder cannot name them until they sign.
        ...(expense.approval?.reporting_manager
          ? [
              {
                label: 'Reporting Manager',
                value: actorLabel(expense.approval.reporting_manager),
              },
            ]
          : []),
      ]
    : []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={false}
        className="flex flex-col gap-0 p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]"
      >
        {/* Header */}
        <SheetHeader className="flex-row items-start justify-between space-y-0 border-b px-6 py-5">
          <div className="min-w-0">
            <SheetTitle className="truncate">
              {expense?.title ?? 'Expense'}
            </SheetTitle>
            {/* Where it stands, in the server's own words.
                `status_label` is composed server-side out of the org's rung
                names — "Awaiting verification", "Pending — Finance" — and is the
                same string the trip's table renders. Composing it here would let
                the drawer and the row a reader can still see behind it disagree
                about what the expense is waiting on, and PENDING_VERIFICATION is
                exactly the status where they would: it looks like a plain
                "Pending" to anyone inventing wording from the enum. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-xs text-muted-foreground">
                {expense?.display_id ? `Expense ID ${expense.display_id}` : ''}
              </p>
              {expense && (
                <ExpenseStatusChip
                  status={expense.status}
                  label={expense.status_label}
                  levelNames={expense.current_level_names}
                />
              )}
              {/* The rungs, marked and unmarked, from the same component the
                  trip's Verification column uses. A marker who opened this row
                  to decide whether to sign it needs to see who has already
                  signed *without* going back to the table — and the unmarked
                  rungs are the half that says who is still to come. Renders
                  nothing at all where the org has no verifying level. */}
              {(expense?.verification?.required_levels?.length ?? 0) > 0 && (
                <VerificationCell state={expense?.verification} />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {expense && (
              <GateActionBar
                subjectType="expense"
                availableActions={expense.available_actions.filter((a) => a !== 'submit' && a !== 'send_back')}
                handlers={handlers}
                context={{
                  currency: expense.currency,
                  escalationLevelName: expense.escalation_level_name,
                  netPayable:
                    settlementPreview?.net_payable ??
                    expense.net_payable ??
                    undefined,
                  hasAdvance: !!expense.advance,
                  advanceApplied:
                    settlementPreview?.advance_applied ??
                    expense.advance?.applied_amount ??
                    undefined,
                }}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-9"
              onClick={() => toast.info('Export coming soon')}
            >
              <Download className="size-4" /> Export
            </Button>
            {expense?.available_actions.includes('edit') && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-9"
                onClick={() => onEdit?.(expense.id)}
              >
                <Pencil className="size-4" /> Edit
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </div>
        </SheetHeader>

        {/* Body — content left, timeline right, each scrolling on its own.

            `min-h-0` on the row is what makes that work: a flex child defaults to
            `min-height: auto`, so without it the tall column refuses to shrink,
            both `overflow-y-auto` are dead, and the sheet scrolls as one block. */}
        <div className="flex min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="grid grid-cols-3 gap-x-6 gap-y-5">
              {fields.map((f) => (
                <div key={f.label}>
                  <p className="text-xs text-muted-foreground">{f.label}</p>
                  <p className="mt-1 text-sm text-foreground">{f.value}</p>
                </div>
              ))}
            </div>

            {/* Amount adjustment — offered wherever the server says this caller may
                approve. Without it the drawer can approve but never approve *for
                less*, which is the substance of the verifying rung (§18.1 B). */}
            {expense && canAdjustAmount && settlementPreview && (
              <div className="mt-6 rounded-lg border bg-card p-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Approved Amount
                </p>
                <ApprovedAmountPanel
                  expenseId={expense.id}
                  claimedAmount={expense.claimed_amount}
                  currency={currency}
                  baseline={settlementPreview}
                  onChange={setAdjust}
                />
              </div>
            )}

            {/* The approval ladder. A draft has not been submitted, so no chain has
                been frozen onto it and there is nothing to draw. */}
            {expense && expense.status !== 'DRAFT' && (
              <ApprovalLadder approval={expense.approval} actorLabel={actorLabel} />
            )}

            {/* Description */}
            <div className="mt-6">
              <p className="text-xs text-muted-foreground">Description</p>
              <p className="mt-1 text-sm text-foreground">
                {expense?.description || '—'}
              </p>
            </div>

            {/* Attachments */}
            <div className="mt-6">
              <p className="mb-2 text-xs text-muted-foreground">Attachments</p>
              {live.length === 0 ? (
                <p className="text-sm text-muted-foreground">No attachments</p>
              ) : (
                <div className="space-y-2">
                  {live.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => openReceipt(r.id)}
                      className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {r.filename}
                      </span>
                      <X className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* The conversation, under the record it is about.

                Already built — `src/comments` on the server, `CommentThread`
                here — and until now mounted only on the full page at
                `/expenses/{id}`, which is not the screen anyone opens: a row
                click lands in this drawer. So the lightweight channel that exists
                precisely so a question does not have to become a send-back was,
                in practice, unreachable.

                In the content column rather than the rail: the rail is a record
                of what the system did, and this is people talking. */}
            {expense && (
              <div className="mt-6">
                <CommentThread
                  subjectType="expense"
                  subjectId={expense.id}
                  status={expense.status}
                />
              </div>
            )}
          </div>

          {/* The record's whole history, on the right.

              This drawer is where an expense is actually read — the row click
              opens it, not the full page — and it was the only one of the three
              without a timeline. Trips and advances both had one; expenses had
              the ladder alone, which answers "where is it in the chain" and not
              "what has happened to it". Settlement, an adjusted amount, a recall
              and a send-back all live here and nowhere else in this sheet.

              Complete rather than `milestonesOnly`: the ladder immediately to the
              left is already the chain-progress view, so a second, shorter copy of
              it would be the one thing this rail should not be.

              Stripped of its card chrome — the rail's own border and padding are
              the frame, and a card inside it is a second box around one list. */}
          {expense && (
            <div className="w-72 shrink-0 overflow-y-auto border-l px-5 py-5">
              <ApprovalTimeline
                subjectType="expense"
                subjectId={expense.id}
                title="Expense Timeline"
                className="border-0 bg-transparent p-0"
              />
            </div>
          )}
        </div>

        {/* Footer — Close, then whatever this caller may do to the record.

            The verification actions sit here rather than beside `GateActionBar`
            in the header for a reason that is not layout: they are not chain
            actions. A trip expense is never submitted, so the chain never opens
            on it and `available_actions` carries no approve, reject or send_back
            to sit next to. Putting them in the header would read as an approval
            bar that had lost most of its buttons; in the footer they are what
            Submit is on an ordinary expense — the one thing this record is
            waiting on somebody to do.

            Each is rendered off its own server flag and nothing else. In
            practice at most two ever show at once (a marker gets Mark verified
            and Not verified; the claimant gets Submit to Trip or Take back), but the
            flags are the server's to combine and this must not encode an
            assumption about which pairs are legal. */}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>

          {/* The claimant's hand-off. `Submit to Trip` is what `Submit` is for every
              other expense — it freezes the record so no level ever marks
              figures the claimant can still change underneath them. */}
          {expense?.verification?.can_mark_ready && (
            <Button
              className="gap-1.5"
              disabled={verificationBusy}
              onClick={() =>
                void runVerification(
                  () => markReady({ id: expense.id, tripId }).unwrap(),
                  `${expense.display_id} submitted to the trip`,
                  'Could not hand this expense over',
                )
              }
            >
              <Send className="size-4" />
              Submit to Trip
            </Button>
          )}

          {/* Withdrawn by the server the instant any level marks it, which is
              why there is no confirmation: nothing has been given yet to take
              away. Outline with a red icon all the same (§6) — it pulls the row
              out of everyone else's queue. */}
          {expense?.verification?.can_unready && (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={verificationBusy}
              onClick={() =>
                void runVerification(
                  () => unready({ id: expense.id, tripId }).unwrap(),
                  `${expense.display_id} is back in your drafts`,
                  'Could not take this expense back',
                )
              }
            >
              <Undo2 className="size-4 text-destructive" />
              Take back
            </Button>
          )}

          {/* No confirmation on the mark itself: it is additive, it is the
              expected outcome, and Undo is one button away. The two that are
              hard to walk back are the two that ask. */}
          {expense?.verification?.can_verify && (
            <Button
              className="gap-1.5"
              disabled={verificationBusy}
              onClick={() =>
                void runVerification(
                  () => verifyExpense({ id: expense.id, tripId }).unwrap(),
                  `${expense.display_id} marked verified`,
                  'Could not mark this expense verified',
                )
              }
            >
              <CircleCheck className="size-4" />
              Mark verified
            </Button>
          )}

          {expense?.verification?.can_not_verify && (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={verificationBusy}
              onClick={() => setVerificationDialog('not_verified')}
            >
              <CircleSlash className="size-4 text-destructive" />
              Not verified
            </Button>
          )}

          {expense?.verification?.can_unverify && (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={verificationBusy}
              onClick={() => setVerificationDialog('undo')}
            >
              <Undo2 className="size-4 text-destructive" />
              Undo
            </Button>
          )}

          {expense?.available_actions.includes('submit') && (
            <Button
              className="bg-primary/10 text-foreground hover:bg-primary/15"
              onClick={handleSubmit}
              disabled={submitting || expense?.status !== 'DRAFT'}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </Button>
          )}
        </div>
      </SheetContent>

      {/* The two destructive verification confirmations, shared verbatim with
          the trip's table — see `VerificationDialogs`. Outside `SheetContent`
          so they portal on their own rather than inside a panel that is about to
          unmount underneath them: `runVerification` closes this sheet on
          success, and a dialog living in its subtree would go with it mid-toast.

          Passed `expense` rather than an id because both dialogs count the marks
          standing on the record to say what is about to be swept away, and
          `ExpenseDetail` extends the `ExpenseRow` the table hands them. */}
      <UndoMarkDialog
        expense={verificationDialog === 'undo' ? (expense ?? null) : null}
        busy={unverifying}
        onClose={() => setVerificationDialog(null)}
        onConfirm={(reason) =>
          expense &&
          void runVerification(
            () => unverifyExpense({ id: expense.id, tripId, reason }).unwrap(),
            `Mark removed from ${expense.display_id}`,
            'Could not undo this mark',
          )
        }
      />

      <NotVerifiedDialog
        expense={verificationDialog === 'not_verified' ? (expense ?? null) : null}
        busy={refusing}
        onClose={() => setVerificationDialog(null)}
        onConfirm={(reason) =>
          expense &&
          void runVerification(
            () => notVerifyExpense({ id: expense.id, tripId, reason }).unwrap(),
            `${expense.display_id} sent back to its claimant`,
            'Could not send this expense back',
          )
        }
      />
    </Sheet>
  )
}

/**
 * The approval ladder — every rung of the chain frozen at submit, in order,
 * with the verdicts recorded at each.
 *
 * Built by joining `approval.levels` (where each rung stands right now) to
 * `approval.decisions` (who signed what, at which rung). Three properties of a
 * configurable ladder rule out the old three-field layout, and each is easy to
 * lose again:
 *
 * - **A rung can carry several verdicts.** A `quorum: 'all'` level collects a
 *   signature from everyone eligible, so one "approved by" line per rung would
 *   name the first signatory and silently drop the rest.
 * - **A skipped rung is drawn, not omitted.** An `optional` rung the level below
 *   chose not to open still happened — it was declined. A rung that disappears
 *   reads as a chain that never had one.
 * - **Rung names belong to the org and are frozen when used.** A decided rung is
 *   titled from its own decision's `level_name`, so renaming a level in settings
 *   cannot retroactively change what an approver was told they were signing.
 *   Only an undecided rung falls back to the chain's frozen name.
 *
 * Kept in step with the identical component in `TripDetailSheet` and
 * `AdvanceDetailSheet` — three drawers over one chain must not drift.
 */

/** The server's own sentence for a refusal, or null when it did not send one. */
function errorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  return typeof detail === 'string' ? detail : null
}
