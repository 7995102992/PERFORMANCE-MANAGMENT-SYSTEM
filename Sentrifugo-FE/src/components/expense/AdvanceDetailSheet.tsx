/**
 * Read-only advance detail, shown as a right-side drawer when a row is opened.
 * Matches the layout of ExpenseDetailSheet.
 */
import { useState } from 'react'
import {
  Download,
  Landmark,
  Lock,
  Undo2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { ApprovalLadder } from './ApprovalLadder'
import { ApprovalRoutePreview } from './ApprovalRoutePreview'
import { GateActionBar } from './GateActionBar'
import { ApprovalTimeline } from './ApprovalTimeline'
import { CommentThread } from './CommentThread'
import { useApproverScope } from '@/hooks/use-approver-scope'
import { useAppSelector } from '@/store'
import { ReturnAdvanceSheet } from './ReturnAdvanceSheet'

import { ExpenseStatusChip } from './ExpenseStatusChip'
import {
  useApproveAdvanceMutation,
  useCloseAdvanceMutation,
  useDisburseAdvanceMutation,
  useForwardAdvanceMutation,
  useGetAdvanceQuery,
  useGetApproverCandidatesQuery,
  useGetPaymentModesQuery,
  useRecallAdvanceMutation,
  useRejectAdvanceMutation,
  useSendBackAdvanceMutation,
  useSubmitAdvanceMutation,
} from '@/store/api/expenseApi'
import { formatDate, formatMoney } from '@/lib/expense-utils'
import { useEmployeeNames } from '@/hooks/use-employee-names'
import type {
  ActorSnapshot,
} from '@/types/expense'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  advanceId: string | null
}

export function AdvanceDetailSheet({ open, onOpenChange, advanceId }: Props) {
  const [disburseOpen, setDisburseOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)

  const { data: advance } = useGetAdvanceQuery(advanceId!, { skip: !advanceId })

  /**
   * The live chain, for a draft that has none of its own.
   *
   * Skipped unless this is actually an unsubmitted request — every other status
   * has a snapshot, and the ladder below is the honest source for those.
   */
  const { data: route, isLoading: routeLoading } = useGetApproverCandidatesQuery(undefined, {
    skip: advance?.status !== 'DRAFT',
  })
  const { codeFor } = useEmployeeNames()
  const { isOrgWide } = useApproverScope()

  /** "Rekha Iyer (ZEN0031)" — the code appended only when it resolves. */
  const actorLabel = (actor?: ActorSnapshot | null): string => {
    if (!actor) return '—'
    const name = actor.name ?? '—'
    const code = codeFor(actor.id)
    return code ? `${name} (${code})` : name
  }

  const [submit, { isLoading: submitting }] = useSubmitAdvanceMutation()
  const [approve] = useApproveAdvanceMutation()
  const [reject] = useRejectAdvanceMutation()
  const [sendBack] = useSendBackAdvanceMutation()
  const [forward] = useForwardAdvanceMutation()
  const [recall] = useRecallAdvanceMutation()
  const [closeAdvance] = useCloseAdvanceMutation()

  const closeSheet = () => onOpenChange(false)

  const handleSubmit = async () => {
    if (!advance) return
    try {
      await submit(advance.id).unwrap()
      toast.success('Advance submitted for approval')
      closeSheet()
    } catch (err) {
      // Verbatim — see ExpenseDetailSheet. An unconfigured approval chain names
      // who can fix it, and the claimant cannot act on anything less.
      toast.error(errorDetail(err) ?? 'Could not submit this advance')
    }
  }

  const handlers = {
    onApprove: async (note?: string) => {
      if (!advance) return
      await approve({ id: advance.id, body: { note } }).unwrap()
      closeSheet()
    },
    onReject: async (reason: string) => {
      if (!advance) return
      await reject({ id: advance.id, body: { reason } }).unwrap()
      closeSheet()
    },
    onSendBack: async (note: string) => {
      if (!advance) return
      await sendBack({ id: advance.id, body: { note } }).unwrap()
      closeSheet()
    },
    // Escalating names nobody: the org's chain decides which rung opens next and
    // who sits on it, so the forward carries a reason and nothing else.
    onForward: async (reason?: string) => {
      if (!advance) return
      await forward({ id: advance.id, body: { reason } }).unwrap()
      closeSheet()
    },
    onRecall: async () => {
      if (!advance) return
      await recall(advance.id).unwrap()
      closeSheet()
    },
  }

  /**
   * The claimant's own advance, as opposed to one they are approving.
   *
   * `milestonesOnly` drops everything that is not chain progress, which is right
   * for an approver — disbursement and return are rows they do not need. It was
   * applied to everyone outside the org-wide scope, so it also hid the owner's
   * **own** return from them: they filed it, the money left, and the timeline
   * showed nothing. Read off the record rather than from `canReturn`, which goes
   * false the moment the balance reaches zero — exactly when the history of how
   * it got there matters most.
   */
  const currentUser = useAppSelector((s) => s.auth.user)
  const isOwner = Boolean(
    advance?.employee_id && currentUser?.id && advance.employee_id === currentUser.id,
  )

  const actions = advance?.available_actions ?? []
  const canDisburse = actions.includes('disburse')
  const canReturn = actions.includes('return')
  const canClose = actions.includes('close')

  const fields: { label: string; value: string }[] = advance
    ? [
        { label: 'Project', value: advance.project_ref?.name ?? '—' },
        { label: 'Client', value: advance.client_ref?.name ?? '—' },
        { label: 'Origin', value: advance.origin === 'ALLOCATED' ? 'Allocated' : 'Requested' },
        { label: 'Allotted Date', value: formatDate(advance.allotted_at ?? advance.disbursed_at) },
        { label: 'Allotted To', value: advance.employee_name ?? '—' },
        { label: 'Allotted By', value: advance.disbursed_by?.name ?? advance.requested_by?.name ?? '—' },
        { label: 'Payment Mode', value: advance.payment_mode ?? '—' },
        { label: 'Payment Ref#', value: advance.payment_reference || '—' },
        { label: 'Amount', value: formatMoney(advance.amount) },
        // The claimant's manager, who is whoever a `reporting_manager` rung
        // resolves to on *this* record. It lives inside the approval block now —
        // it is chain state, and was only ever a top-level field because the old
        // gate model had nowhere to put it with the rest.
        ...(advance.approval?.reporting_manager
          ? [
              {
                label: 'Reporting Manager',
                value: actorLabel(advance.approval.reporting_manager),
              },
            ]
          : []),
      ]
    : []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={false}
        className="flex flex-col gap-0 p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px] overflow-hidden"
      >
        {/* Header */}
        <SheetHeader className="flex-row items-start justify-between space-y-0 border-b px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {/* An advance carries no name of its own — it is identified by its
                  display id and its amount — so the header states the subject
                  rather than inventing a title the record does not have. */}
              <SheetTitle className="truncate">Advance Request</SheetTitle>
              {advance && <ExpenseStatusChip status={advance.status} variant="badge" />}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {advance?.display_id ? `Advance ID ${advance.display_id}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canReturn && (
              <Button variant="outline" size="sm" className="gap-1.5 h-9" onClick={() => setReturnOpen(true)}>
                <Undo2 className="size-4" /> Return
              </Button>
            )}
            {canDisburse && (
              <Button size="sm" className="gap-1.5 h-9" onClick={() => setDisburseOpen(true)}>
                <Landmark className="size-4" /> Disburse
              </Button>
            )}
            {canClose && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-9"
                onClick={async () => {
                  try {
                    await closeAdvance(advance!.id).unwrap()
                    toast.success('Advance closed')
                    closeSheet()
                  } catch {
                    toast.error('Could not close this advance')
                  }
                }}
              >
                <Lock className="size-4" /> Close
              </Button>
            )}
            {advance && (
              // No leadership flag to pass: whether this caller may open the rung
              // above is already the presence of `forward` in the server's
              // `available_actions`, which the bar reads straight off the record.
              <GateActionBar
                subjectType="advance"
                availableActions={actions.filter((a) => a !== 'submit' && a !== 'send_back' && a !== 'disburse' && a !== 'return' && a !== 'close')}
                handlers={handlers}
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-3 gap-x-6 gap-y-5">
            {fields.map((f) => (
              <div key={f.label}>
                <p className="text-xs text-muted-foreground">{f.label}</p>
                <p className="mt-1 text-sm text-foreground">{f.value}</p>
              </div>
            ))}
          </div>

          {/* A draft has no chain frozen onto it yet, so there is no ladder to
              draw — but "no ladder" was rendering as *nothing*, leaving the owner
              of an unsubmitted request with no idea where it would go. The live
              chain answers that, and only for the owner: an approver reading
              somebody's draft is not deciding whether to send it. */}
          {advance && advance.status === 'DRAFT' && isOwner && (
            <ApprovalRoutePreview
              levels={route?.chain_preview}
              approvalRequired={route?.approval_required ?? true}
              loading={routeLoading}
            />
          )}

          {/* The approval ladder, once the chain is frozen onto the record. */}
          {advance && advance.status !== 'DRAFT' && (
            <ApprovalLadder approval={advance.approval} actorLabel={actorLabel} />
          )}

          <div className="mt-6">
            <p className="text-xs text-muted-foreground">Description</p>
            <p className="mt-1 text-sm text-foreground">
              {advance?.description || '—'}
            </p>
          </div>

          {/* Conversation left, history right — the same pair, and the same
              split, `TripDetailSheet` and the expense detail page use. Stacked
              full-width they pushed the timeline below the fold on any advance
              with more than a couple of comments, which is exactly the advance
              whose history somebody wants.

              The thread is the wide one because it is the only thing on this
              screen a person writes into: a comment box the width of the sheet
              reads as the place to type, where the same box squeezed beside a
              rail reads as a caption. The timeline is a fixed 320 because its
              rows are short and a wide one is mostly empty gutter.

              `items-start` so whichever is taller sets the row and the shorter
              one is not stretched to match it.

              An advance is money asked for before it is spent, so it attracts the
              question the comment thread exists to answer without a send-back —
              which resets the record to DRAFT and releases its draw. */}
          {advance ? (
            <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_320px]">
              <CommentThread
                subjectType="advance"
                subjectId={advance.id}
                status={advance.status}
              />
              {/* Disbursement and return are exactly the rows an approver does
                  not need and Finance does — hence `milestonesOnly`. */}
              <ApprovalTimeline
                subjectType="advance"
                subjectId={advance.id}
                title={isOrgWide ? 'Advance Timeline' : 'Approval Progress'}
                milestonesOnly={!isOrgWide && !isOwner}
              />
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <Button variant="outline" onClick={closeSheet}>
            Close
          </Button>
          {actions.includes('submit') && (
            <Button className="bg-primary/10 text-foreground hover:bg-primary/15" onClick={handleSubmit} disabled={submitting || advance?.status !== 'DRAFT'}>
              {submitting ? 'Submitting…' : 'Submit'}
            </Button>
          )}
        </div>

        {/* Dialogs */}
        {advance && (
          <>
            <DisburseDialog
              open={disburseOpen}
              onClose={() => setDisburseOpen(false)}
              advanceId={advance.id}
              amount={advance.amount}
            />
            <ReturnAdvanceSheet
              open={returnOpen}
              onOpenChange={setReturnOpen}
              presetAdvanceId={advance.id}
            />
          </>
        )}
      </SheetContent>
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
 * Kept in step with the identical component in `ExpenseDetailSheet` and
 * `TripDetailSheet` — three drawers over one chain must not drift.
 */

function DisburseDialog({
  open,
  onClose,
  advanceId,
  amount,
}: {
  open: boolean
  onClose: () => void
  advanceId: string
  amount: string
}) {
  const [paymentMode, setPaymentMode] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')

  const { data: paymentModes = [] } = useGetPaymentModesQuery()
  const [disburse, { isLoading }] = useDisburseAdvanceMutation()

  const close = () => {
    setPaymentMode('')
    setReference('')
    setNote('')
    onClose()
  }

  const save = async () => {
    try {
      await disburse({
        id: advanceId,
        body: {
          payment_mode: paymentMode,
          payment_reference: reference.trim() || null,
          note: note.trim() || null,
        },
      }).unwrap()
      toast.success('Disbursement recorded — the advance is now active')
      close()
    } catch {
      toast.error('Could not record the disbursement')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Record disbursement</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {formatMoney(amount)} becomes available to draw against once you record how it was paid out.
        </p>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>
              Payment Mode <span className="text-destructive">*</span>
            </Label>
            <Select value={paymentMode} onValueChange={setPaymentMode}>
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="disburse-ref">Payment Ref#</Label>
            <Input
              id="disburse-ref"
              className="h-9"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="NEFT-88210"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="disburse-note">Note</Label>
            <Textarea
              id="disburse-note"
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
          <Button disabled={!paymentMode || isLoading} onClick={save}>
            {isLoading ? 'Recording…' : 'Record Disbursement'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The server's own sentence for a refusal, or null when it did not send one. */
function errorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  return typeof detail === 'string' ? detail : null
}
