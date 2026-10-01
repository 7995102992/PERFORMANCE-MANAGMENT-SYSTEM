/**
 * Read-only trip detail, shown as a right-side drawer when a trip row is opened
 * — the slider counterpart to the trip full page, matching `ExpenseDetailSheet`.
 *
 * Payment Mode, Payment Ref# and Receipt are columns to mirror the design, but
 * the expense **list** row carries none of them (they live on each expense's
 * detail), so they render as placeholders and the real values are on the
 * expense the row links to.
 *
 * **This table is also the verification work surface.** Where the org's chain
 * has verifying levels, a trip's expenses are not submitted one at a time —
 * each verifying level marks them from here, in rung order, and an expense every
 * level has marked can be settled with the trip in a single action. The
 * Verification column and the Mark verified / Not verified / Undo buttons render
 * `verification.can_verify`, `can_not_verify` and `can_unverify` **exactly as
 * the server sends them**, the same way `available_actions` is treated: the
 * client knows neither who the next rung resolves to on this record nor who left
 * the mark below it, so any local "is this mine?" would be a second copy of the
 * sequencing rule, free to offer buttons the server refuses.
 *
 * A row click opens the expense **over** this drawer rather than navigating to
 * it, so reading one line does not cost the trip. The same verification actions
 * are on both surfaces and share `VerificationDialogs` — see the note there for
 * why the consequence wording cannot be written twice.
 */
import { useState } from 'react'
import {
  ChevronDown,
  CircleCheck,
  CircleSlash,
  Copy,
  Download,
  Pencil,
  Plus,
  Send,
  Undo2,
  Wallet,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  useBulkSettleTripMutation,
  useCloneTripMutation,
  useCloseTripMutation,
  useGetExpensesQuery,
  useGetTripQuery,
  useLazyExportTripQuery,
  useSubmitTripMutation,
  useApproveTripMutation,
  useRejectTripMutation,
  useSendBackTripMutation,
  useUnverifyExpenseMutation,
  useNotVerifyExpenseMutation,
  useMarkExpenseReadyMutation,
  useUnreadyExpenseMutation,
  useVerifyExpenseMutation,
} from '@/store/api/expenseApi'
import { formatDate, formatMoney } from '@/lib/expense-utils'
import { ApprovalLadder } from './ApprovalLadder'
import { GateActionBar } from './GateActionBar'
import { MarkPaidDialog } from './MarkPaidDialog'
import { ApprovalTimeline } from './ApprovalTimeline'
import { CommentThread } from './CommentThread'
import { ExpenseDetailSheet } from './ExpenseDetailSheet'
import { AttachExpenseDialog } from './AttachExpenseDialog'
import { ExpenseFormSheet } from './ExpenseFormSheet'
import {
  NotVerifiedDialog,
  UndoMarkDialog,
  VerificationCell,
} from './VerificationDialogs'
import { useApproverScope } from '@/hooks/use-approver-scope'
import { useAppSelector } from '@/store'
import type {
  ActorSnapshot,
  ExpenseRow,
  ListScope,
  TripDetail as TripDetailType,
} from '@/types/expense'
import { useEmployeeNames } from '@/hooks/use-employee-names'
import { ExpenseStatusChip } from './ExpenseStatusChip'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  tripId: string | null
  /** Opens the edit form for this trip. */
  onEdit?: (tripId: string) => void
  /** Opens the Add Expense form seeded with this trip. */
  onAddExpense?: (tripId: string) => void
  /** Switch the drawer to another trip (used after a clone). */
  onSelectTrip?: (tripId: string) => void
  /**
   * Which expense list the child rows are read from.
   *
   * Not always `'my'`: a manager opening a team member's trip has to read the
   * expenses through the scope that actually contains them. Querying their own
   * list filtered by someone else's trip id matches nothing, which is why the
   * section rendered empty for every trip but your own.
   */
  expenseScope?: ListScope
}

export function TripDetailSheet({
  open,
  onOpenChange,
  tripId,
  onEdit,
  onAddExpense,
  onSelectTrip,
  expenseScope = 'my',
}: Props) {
  const { nameFor, codeFor } = useEmployeeNames()
  const { isOrgWide, scopeFor } = useApproverScope()

  /** "Rekha Iyer (ZEN0031)" — the code appended only when it resolves. */
  const actorLabel = (actor?: ActorSnapshot | null): string => {
    if (!actor) return '—'
    const name = actor.name ?? '—'
    const code = codeFor(actor.id)
    return code ? `${name} (${code})` : name
  }

  const { data: trip } = useGetTripQuery(tripId!, { skip: !tripId })
  const currentUser = useAppSelector((s) => s.auth.user)

  /**
   * Whether the caller owns this trip — the question the owner-only buttons are
   * really asking.
   *
   * It used to arrive as `isEmployeeScope`, computed by the list from which tab
   * you were on. That made a capability a property of *how you got here* rather
   * than of the record, so the same trip offered Edit and Clone under one
   * heading and not another, and a deep link had no tab to be judged by at all.
   * The record knows, so it answers.
   *
   * `false` while the trip loads: withholding a button for a moment costs
   * nothing, whereas offering Edit on somebody else's trip is a click the server
   * refuses.
   */
  const isOwner = Boolean(
    trip && currentUser?.id && trip.owner_employee_id === currentUser.id,
  )
  const [cloneTrip, { isLoading: cloning }] = useCloneTripMutation()
  const [closeTrip] = useCloseTripMutation()
  const [runExport, { isFetching: exporting }] = useLazyExportTripQuery()

  const [submitTrip] = useSubmitTripMutation()
  const [approveTrip] = useApproveTripMutation()
  const [rejectTrip] = useRejectTripMutation()
  const [sendBackTrip] = useSendBackTripMutation()

  const handlers = {
    onSubmit: async () => { await submitTrip(trip!.id).unwrap() },
    onApprove: async (note?: string) => { await approveTrip({ id: trip!.id, body: { note: note || '' } }).unwrap() },
    onReject: async (reason: string) => { await rejectTrip({ id: trip!.id, body: { reason } }).unwrap() },
    onSendBack: async (note: string) => { await sendBackTrip({ id: trip!.id, body: { note } }).unwrap() },
    onClose: async () => { await closeTrip(trip!.id).unwrap() },
  }

  /**
   * Which list the child rows are actually read from.
   *
   * The prop is right for every in-app entry point, because the list that opened
   * the drawer knows which scope it is allowed to ask for. A **deep link** has no
   * such list: `/expenses/trips/$tripId` redirects to the caller's own trips, so
   * a manager following a link to a colleague's trip arrives with `'my'` and the
   * server answers honestly with nothing — their own expenses filtered by
   * somebody else's trip match no rows. The old full-page trip view hard-coded
   * `'my'` and had exactly this hole.
   *
   * So a non-owner handed `'my'` is moved to a scope that can contain the rows:
   * org-wide where they hold the claims-view grant, their approvals queue
   * otherwise. `_trip_table_criteria` serves the whole trip to anyone entitled to
   * it under any scope but `MY`, so either one is enough — and both are separate
   * server routes with their own gates, so this widens nothing it could not
   * already ask for.
   *
   * Safe during load because the query below is skipped until `trip` arrives,
   * which is the same moment `isOwner` stops being provisionally `false`.
   */
  const resolvedExpenseScope: ListScope =
    !isOwner && expenseScope === 'my'
      ? scopeFor<ListScope>('employees', 'approvals')
      : expenseScope

  const { data: expensePage } = useGetExpensesQuery(
    {
      scope: resolvedExpenseScope,
      month_from: trip?.from_date ?? '1970-01-01',
      month_to: trip?.to_date ?? '2999-12-31',
      trip_id: tripId ?? undefined,
      page_size: 200,
    },
    { skip: !trip },
  )
  const expenses = expensePage?.items ?? []

  // ── Verification and bulk settle ──────────────────────────────────────────
  const [verifyExpense, { isLoading: verifying }] = useVerifyExpenseMutation()
  const [unverifyExpense, { isLoading: unverifying }] = useUnverifyExpenseMutation()
  const [notVerifyExpense, { isLoading: refusing }] = useNotVerifyExpenseMutation()
  const [bulkSettle, { isLoading: settling }] = useBulkSettleTripMutation()
  const [settleOpen, setSettleOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  /** The row whose mark is about to be undone — see {@link UndoMarkDialog}. */
  const [undoTarget, setUndoTarget] = useState<ExpenseRow | null>(null)
  /** The row about to be refused — see {@link NotVerifiedDialog}. */
  const [refuseTarget, setRefuseTarget] = useState<ExpenseRow | null>(null)
  /**
   * The expense the reader has opened on top of this drawer.
   *
   * A row click used to close this sheet and navigate to `/expenses/{id}`,
   * which threw away the whole reason someone is in here: they are working
   * *down a trip's lines*, and after reading one they want the next. Coming back
   * meant the browser's Back button and a refetched trip. Now the expense opens
   * over the trip and closing it leaves the table exactly where it was, marks
   * and all — `VERIFICATION_WIDE` has already refreshed the row underneath by
   * the time the drawer slides away.
   */
  const [focusedExpenseId, setFocusedExpenseId] = useState<string | null>(null)
  /**
   * The expense open in the edit form, hoisted out of the drawer above it.
   *
   * `ExpenseDetailSheet` offers Edit wherever the server says the caller may
   * edit, and it does nothing without a handler. This trip's page never mounted
   * an expense form because the drawer used to navigate away before Edit was
   * reachable from here; opening the expense in place makes that button live, so
   * it needs somewhere to land.
   */
  const [editExpenseId, setEditExpenseId] = useState<string | null>(null)

  /**
   * Whether verification is in play for this trip at all.
   *
   * Read off the rows the server sent rather than off the org's chain: an org
   * that has ticked nothing gets no `verification` block, and the verification
   * column must not appear at all in that case — behaviour there is exactly as
   * it always was, each expense submitted on its own.
   *
   * This governs the *column*, not the settle button. It answers "does this org
   * verify", which every viewer of a verified trip sees alike — see `canSettle`.
   */
  const showVerification = expenses.some(
    (exp) => (exp.verification?.required_levels?.length ?? 0) > 0,
  )
  const completeRows = expenses.filter((exp) => exp.verification?.complete)

  /**
   * Whether *this caller* may settle, as opposed to merely being on a trip that
   * gets settled by somebody.
   *
   * `showVerification` used to gate the Bulk Settle button, which was wrong in a
   * way the server caught but the screen did not: `required_levels` is on the
   * payload for every viewer, so the button rendered for approvers, for
   * verifying levels, and for the claimant reading their own trip — three people
   * who can only ever collect a 403 from it, since `bulk-settle` is gated on
   * `expense_finance_approval` exactly like `mark-paid`.
   *
   * `mark_paid` is the server's own answer to the same question. The engine
   * appends it only when the record is `APPROVED` **and** the caller holds that
   * grant (`gates/engine.py`), and a fully-marked expense is `APPROVED` — so a
   * row offering it is proof that this caller may settle this trip's money.
   *
   * The button therefore appears exactly when pressing it would do something,
   * rather than staying visible-but-disabled: that older behaviour was there so
   * a settler could see "nothing to settle yet", but it cannot be had without
   * telling everyone else they are a settler too.
   */
  const canSettle = completeRows.some((exp) =>
    exp.available_actions.includes('mark_paid'),
  )
  // Net payable is the money actually leaving, and it is what the settler is
  // authorising — the same total `BulkMarkPaidBar` shows for a selection.
  const settleTotal = completeRows.reduce(
    (sum, exp) =>
      sum + Number(exp.net_payable ?? exp.approved_amount ?? exp.claimed_amount ?? 0),
    0,
  )
  const settleCurrency = completeRows[0]?.currency ?? expenses[0]?.currency ?? 'INR'
  // One busy flag across all three mark actions: they act on the same rung, and
  // a second call landing while the first is in flight is refused by the server
  // anyway — better to grey the row than to collect the 409.
  const marking = verifying || unverifying || refusing

  // ── The claimant's hand-off ───────────────────────────────────────────────
  // `Submit to Trip` is what `Submit` is for every other expense. It lives on this table
  // rather than in the expense form because this is where the claimant sees the
  // trip's lines together and decides one is finished.
  const [markReady, { isLoading: sendingReady }] = useMarkExpenseReadyMutation()
  const [unready, { isLoading: takingBack }] = useUnreadyExpenseMutation()
  const readying = sendingReady || takingBack

  const handleReady = async (exp: ExpenseRow) => {
    try {
      await markReady({ id: exp.id, tripId: tripId ?? undefined }).unwrap()
      toast.success(`${exp.display_id} submitted to the trip`)
    } catch (err) {
      // The freeze runs here, so this is where a missing receipt or a future
      // date surfaces — the same refusals Submit gives on an ordinary expense.
      toast.error(errorDetail(err) ?? 'Could not hand this expense over')
    }
  }

  /**
   * Every draft on this trip, handed over in one press.
   *
   * A trip is written a line at a time and finished all at once, so submitting
   * each one individually is the same decision typed N times. The per-row button
   * stays: a claimant who has finished the hotel but is still arguing with a
   * taxi receipt needs to hand over one without the other.
   *
   * `can_mark_ready` is the server's own per-row answer — owner, and still a
   * draft — so this offers exactly the rows the individual button offers, and
   * never one it would refuse for a reason the list cannot see.
   */
  const readyRows = expenses.filter((exp) => exp.verification?.can_mark_ready)
  const [bulkReadying, setBulkReadying] = useState(false)

  const handleReadyAll = async () => {
    setBulkReadying(true)
    const failures: string[] = []
    let sent = 0

    // Sequential, not `Promise.all`. Each hand-off runs the freeze — receipts,
    // dates, the advance draw — and a parallel burst would race N of those
    // against the same advance ledger. N is a trip's worth of lines, not a page
    // of them.
    for (const exp of readyRows) {
      try {
        await markReady({ id: exp.id, tripId: tripId ?? undefined }).unwrap()
        sent += 1
      } catch (err) {
        failures.push(
          `${exp.display_id}: ${errorDetail(err) ?? 'could not be submitted'}`,
        )
      }
    }

    setBulkReadying(false)
    // Per row, because the freeze refuses per row: one expense missing a receipt
    // must not read as "the trip failed", and the four that went through must not
    // be re-pressed.
    if (sent) {
      toast.success(
        sent === 1
          ? '1 expense submitted to the trip'
          : `${sent} expenses submitted to the trip`,
      )
    }
    for (const failure of failures) toast.error(failure)
  }

  const handleUnready = async (exp: ExpenseRow) => {
    try {
      await unready({ id: exp.id, tripId: tripId ?? undefined }).unwrap()
      toast.success(`${exp.display_id} is back in your drafts`)
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not take this expense back')
    }
  }

  const handleMark = async (exp: ExpenseRow) => {
    try {
      await verifyExpense({ id: exp.id, tripId: tripId ?? undefined }).unwrap()
      toast.success(`${exp.display_id} marked verified`)
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not mark this expense verified')
    }
  }

  const handleUndo = async (exp: ExpenseRow, reason: string) => {
    try {
      await unverifyExpense({
        id: exp.id,
        tripId: tripId ?? undefined,
        reason,
      }).unwrap()
      toast.success(`Mark removed from ${exp.display_id}`)
      setUndoTarget(null)
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not undo this mark')
    }
  }

  const handleNotVerified = async (exp: ExpenseRow, reason: string) => {
    try {
      await notVerifyExpense({
        id: exp.id,
        tripId: tripId ?? undefined,
        reason,
      }).unwrap()
      toast.success(`${exp.display_id} sent back to its claimant`)
      setRefuseTarget(null)
      // The row is a DRAFT of somebody else's now. If it was the one being read
      // on top of this drawer, that view is about to become a stranger's draft
      // the caller may no longer even fetch — close it rather than leave a 403
      // to arrive underneath the toast.
      if (focusedExpenseId === exp.id) setFocusedExpenseId(null)
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not send this expense back')
    }
  }

  const handleBulkSettle = async (body: {
    payment_reference: string
    payment_date: string
    note?: string
  }) => {
    if (!trip) return
    try {
      const res = await bulkSettle({ id: trip.id, body }).unwrap()
      setSettleOpen(false)
      // Every count, not just the good one. A skip is a legitimate outcome — an
      // expense nobody has finished marking is left for the next run rather than
      // blocking this one — and reporting only the settlements would leave the
      // settler believing the trip was cleared in full.
      const parts = [`${res.settled} settled`]
      if (res.skipped > 0) parts.push(`${res.skipped} skipped`)
      if (res.failed > 0) parts.push(`${res.failed} failed`)
      const message = parts.join(' · ')
      if (res.failed > 0) toast.warning(message)
      else toast.success(message)
    } catch (err) {
      toast.error(errorDetail(err) ?? 'Could not settle this trip')
    }
  }

  const handleClone = async () => {
    if (!trip) return
    try {
      const clone = await cloneTrip(trip.id).unwrap()
      toast.success('Trip cloned as a new draft')
      onSelectTrip?.(clone.id)
    } catch {
      toast.error('Could not clone this trip')
    }
  }

  const handleExport = async () => {
    if (!trip) return
    try {
      const res = await runExport(trip.id).unwrap()
      downloadJson(res, `${trip.display_id}-export.json`)
      if (res.truncated) {
        toast.warning(
          `Export is capped at ${res.row_limit} expenses — this trip has more, so the file is partial.`,
        )
      } else {
        toast.success('Export downloaded')
      }
    } catch {
      toast.error('Could not export this trip')
    }
  }

  const fields: { label: string; value: string }[] = trip
    ? [
        // An approver opening someone else's trip needs to know whose it is
        // before anything else; the row had it, the drawer did not.
        { label: 'Raised By', value: nameFor(trip.owner_employee_id) },
        {
          label: 'Trip Type',
          value: trip.trip_type === 'INTERNATIONAL' ? 'International' : 'Domestic',
        },
        { label: 'Destination', value: destinationOf(trip) },
        { label: 'Project', value: trip.project_ref?.name ?? '—' },
        { label: 'Client', value: trip.client_ref?.name ?? '—' },
        { label: 'From Date', value: formatDate(trip.from_date) },
        { label: 'To Date', value: formatDate(trip.to_date) },
        // The claimant's manager, who is whoever a `reporting_manager` rung
        // resolves to on *this* record. It is the one part of the chain that is
        // not org-wide, so the ladder cannot name it until they sign.
        ...(trip.approval?.reporting_manager
          ? [
              {
                label: 'Reporting Manager',
                value: actorLabel(trip.approval.reporting_manager),
              },
            ]
          : []),
      ]
    : []

  /**
   * The action bar, split by who is acting rather than by what the action does.
   *
   * `submit` is the claimant finishing their own trip and takes the footer's
   * primary slot; everything else is a verdict on what the reader is looking at
   * and stays in the toolbar beside Export. Derived from one
   * `available_actions` list so neither half can offer something the server has
   * not; a `submit` the server withheld is simply absent from both.
   */
  const allActions = trip?.available_actions ?? []
  /**
   * The owner's own actions, which belong in the footer beside *Close* rather
   * than in the header where an approver's verdicts live.
   *
   * `close` was in `available_actions` all along and rendered nowhere: the
   * header bar had no handler for it and `GateActionBar` draws actions opt-in,
   * so the server published a capability the app silently dropped. `clone` and
   * `export` are owner actions too, but they already have their own header
   * buttons and are deliberately left out of both bars.
   */
  const OWNER_ACTIONS = ['submit', 'close']
  const claimantActions = allActions.filter((action) => OWNER_ACTIONS.includes(action))
  const approverActions = allActions.filter((action) => !OWNER_ACTIONS.includes(action))

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          showCloseButton={false}
          className="flex flex-col gap-0 p-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]"
        >
          {/* Header */}
          <SheetHeader className="flex-row items-start justify-between space-y-0 border-b px-6 py-5">
            <div className="min-w-0">
              <SheetTitle className="truncate">{trip?.name ?? 'Trip'}</SheetTitle>
              <div className="mt-1 flex items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  {trip?.display_id ? `Trip ID ${trip.display_id}` : ''}
                </p>
                {/* Where it stands. An approver could not see this at all. */}
                {trip && <ExpenseStatusChip status={trip.status} />}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Owner-only, read off the trip itself. An approver reading a
                  team member's trip cannot edit it, clone it into their own
                  list, or file expenses on it — the server refuses all three, so
                  offering them only misleads. */}
              {isOwner && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5"
                    onClick={() => trip && onEdit?.(trip.id)}
                  >
                    <Pencil className="size-4" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5"
                    onClick={handleClone}
                    disabled={cloning}
                  >
                    <Copy className="size-4" /> Clone
                  </Button>
                  {/* Split button (CLAUDE.md §6). The default click is the
                      unchanged create path; the caret adds the expense that
                      already exists. */}
                  <div className="flex items-center">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 rounded-r-none border-r-0"
                      onClick={() => trip && onAddExpense?.(trip.id)}
                    >
                      <Plus className="size-4" /> Add/Attach Expense
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 rounded-l-none px-2"
                          aria-label="More ways to add an expense"
                        >
                          <ChevronDown className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => trip && onAddExpense?.(trip.id)}
                        >
                          New expense
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setAttachOpen(true)}>
                          Attach existing…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </>
              )}
              {/* Finance only, and only with something to settle — see
                  `canSettle`. */}
              {canSettle && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5"
                  onClick={() => setSettleOpen(true)}
                  disabled={settling}
                >
                  <Wallet className="size-4" />
                  Bulk Settle
                  {completeRows.length > 0 && ` (${completeRows.length})`}
                </Button>
              )}
              {/* The approval actions live here rather than in a footer.
                  Every other record surface in this module puts what you can *do*
                  to the thing in the toolbar beside Export, and a drawer that
                  hid Approve at the bottom of a scrolling body made an approver
                  scroll past the expense table to reach the decision the table
                  exists to inform. Rendered at `sm` so it sits level with
                  Export — see `GateActionBar`'s `size` prop. */}
              {trip && approverActions.length > 0 && (
                <GateActionBar
                  subjectType="trip"
                  availableActions={approverActions}
                  handlers={handlers}
                  size="sm"
                />
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={handleExport}
                disabled={exporting}
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

            {/* The approval ladder. A draft has no chain frozen onto it yet. */}
            {trip && trip.status !== 'DRAFT' && (
              <ApprovalLadder approval={trip.approval} actorLabel={actorLabel} />
            )}

            {/* Description */}
            <div className="mt-6">
              <p className="text-xs text-muted-foreground">Description</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                {trip?.description || '—'}
              </p>
            </div>

            {/* Child expenses */}
            <div className="mt-6 overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-table-border bg-table-header hover:bg-table-header">
                    <Th>Expense Id</Th>
                    <Th>Expense Name</Th>
                    <Th>Amount</Th>
                    <Th>Date</Th>
                    {showVerification && (
                      <>
                        <Th>Verification</Th>
                        <Th className="text-right">Actions</Th>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expenses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={showVerification ? 6 : 4} className="p-0">
                        <EmptyState
                          title="No expenses filed under this trip"
                          description="Add an expense here and the trip's project and client pre-fill as defaults you can overwrite."
                        />
                      </TableCell>
                    </TableRow>
                  )}

                  {expenses.map((exp) => (
                    <TableRow
                      key={exp.id}
                      className="cursor-pointer"
                      // Opens over this drawer, which stays mounted and open
                      // underneath — see `focusedExpenseId`.
                      onClick={() => setFocusedExpenseId(exp.id)}
                    >
                      <TableCell className="text-sm text-muted-foreground">
                        {exp.display_id}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {exp.title}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatMoney(
                          exp.approved_amount ?? exp.claimed_amount,
                          exp.currency,
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(exp.expense_date)}
                      </TableCell>
                      {showVerification && (
                        <>
                          <TableCell>
                            <VerificationCell state={exp.verification} />
                          </TableCell>
                          {/* The row opens the expense, so every control in it
                              has to stop the click travelling — a Mark verified
                              that also opened the drawer would bury its own toast
                              behind a panel the marker did not ask for. */}
                          <TableCell
                            className="text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-end gap-2">
                              {/* The claimant's two actions come first: on their
                                  own row they are the only ones ever offered, and
                                  on somebody else's they never appear at all. */}
                              {exp.verification?.can_mark_ready && (
                                <Button
                                  size="sm"
                                  className="h-8 gap-1.5"
                                  disabled={readying || bulkReadying}
                                  onClick={() => void handleReady(exp)}
                                >
                                  <Send className="size-4" />
                                  Submit
                                </Button>
                              )}
                              {exp.verification?.can_unready && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 gap-1.5"
                                  disabled={readying}
                                  onClick={() => void handleUnready(exp)}
                                >
                                  <Undo2 className="size-4 text-destructive" />
                                  Take back
                                </Button>
                              )}
                              {exp.verification?.can_verify && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 gap-1.5"
                                  disabled={marking}
                                  onClick={() => void handleMark(exp)}
                                >
                                  <CircleCheck className="size-4" />
                                  Mark verified
                                </Button>
                              )}
                              {/* The counterpart to Mark verified, and the reason
                                  this column existed with only half an answer: a
                                  marker who would not pass the row had nothing to
                                  press. The chain never opens on a trip expense,
                                  so Reject and Send Back are not among its actions
                                  and refusing silently was the only option. */}
                              {exp.verification?.can_not_verify && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 gap-1.5"
                                  disabled={marking}
                                  onClick={() => setRefuseTarget(exp)}
                                >
                                  <CircleSlash className="size-4 text-destructive" />
                                  Not verified
                                </Button>
                              )}
                              {exp.verification?.can_unverify && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 gap-1.5"
                                  disabled={marking}
                                  onClick={() => setUndoTarget(exp)}
                                >
                                  {/* Outline with a red icon (§6): undoing is not
                                      as neutral as it looks — it takes every mark
                                      above this one with it. */}
                                  <Undo2 className="size-4 text-destructive" />
                                  Undo
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* The bulk hand-off sits under the rows it acts on, inside the
                  same card (CLAUDE.md §17: a table's own controls are `border`
                  rows of its card, not floating siblings).

                  Below rather than above because it is the last thing done to
                  this table, not a filter on it — the claimant reads down the
                  lines, agrees they are finished, and the button is where their
                  eye already is. Hidden outright when nothing is submittable:
                  the table above is the evidence for that, so a disabled button
                  would be restating what the reader can already see. */}
              {readyRows.length > 0 && (
                <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    {readyRows.length === 1
                      ? '1 expense is still a draft'
                      : `${readyRows.length} expenses are still drafts`}
                  </span>
                  <Button
                    size="sm"
                    className="h-9 gap-1.5"
                    onClick={() => void handleReadyAll()}
                    disabled={bulkReadying || readying}
                  >
                    <Send className="size-4" />
                    {bulkReadying
                      ? 'Submitting…'
                      : `Submit All (${readyRows.length})`}
                  </Button>
                </div>
              )}
            </div>

            {/* Conversation left, history right — the pair the expenses table sits
                above, rather than two full-width blocks stacked.

                The thread is the wide one because it is the only thing on this
                screen a person writes into: a comment box the width of the sheet
                reads as the place to type, where the same box squeezed beside a
                rail reads as a caption. The timeline is a fixed 320 because its
                rows are short and a wide one is mostly empty gutter — the same
                split and the same width the expense detail page uses.

                `items-start` so the two are independent: whichever is taller sets
                the row, and the shorter one is not stretched to match it.

                A trip is authorisation asked for in advance, so it attracts the
                question the comment thread exists to answer without a send-back —
                which would reset the trip to DRAFT and, with it, every expense
                filed against it. */}
            {trip ? (
              <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_320px]">
                <CommentThread
                  subjectType="trip"
                  subjectId={trip.id}
                  status={trip.status}
                />
                {/* See the same block on the expense detail page: Finance gets the
                    whole rail, an approver gets the chain's progress. */}
                <ApprovalTimeline
                  subjectType="trip"
                  subjectId={trip.id}
                  title={isOrgWide ? 'Trip Timeline' : 'Approval Progress'}
                  milestonesOnly={!isOrgWide}
                />
              </div>
            ) : null}
          </div>

          {/* Footer — Close left, the owner's Submit right (CLAUDE.md §7).

              The split is by *who is acting*, not by what the button does. An
              approver's decisions — Approve, Send Back, Reject — sit in the
              toolbar beside Export, where every other record surface in this
              module puts them, because an approver reads the expense table and
              then decides, and burying the decision below a scrolling body made
              them scroll past the evidence to reach it.

              Submitting is the claimant finishing their own trip, which is the
              last thing they do here rather than a verdict on what they are
              reading — so it takes the footer's primary slot, the same position
              Save holds in every form drawer.

              Close stays unconditional. It used to be the *else* of a ternary on
              `trip`, so a loaded trip got the action bar and no way out but the
              header's X; dismissing a drawer is not an approval action and must
              not be contingent on one. */}
          <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {trip && claimantActions.length > 0 && (
              <GateActionBar
                subjectType="trip"
                availableActions={claimantActions}
                handlers={handlers}
              />
            )}
          </div>
        </SheetContent>

        {/* The *same* payment dialog Mark Paid opens, relabelled for a batch. A
            second one would be a second copy of the reference/date rules and of
            the idempotency wording — see `MarkPaidDialog`. */}
        <MarkPaidDialog
          open={settleOpen}
          onClose={() => setSettleOpen(false)}
          netPayable={String(settleTotal)}
          currency={settleCurrency}
          busy={settling}
          onConfirm={(payload) => void handleBulkSettle(payload)}
          title="Settle this trip"
          amountLabel="Net payable across fully verified expenses"
          confirmLabel="Bulk Settle"
          description={settleDescription(completeRows.length, expenses.length)}
          zeroNote="Advances cover these claims in full. Recording a zero-value settlement is correct and closes them."
        />

        <UndoMarkDialog
          expense={undoTarget}
          busy={unverifying}
          onClose={() => setUndoTarget(null)}
          onConfirm={(reason) => undoTarget && void handleUndo(undoTarget, reason)}
        />

        <NotVerifiedDialog
          expense={refuseTarget}
          busy={refusing}
          onClose={() => setRefuseTarget(null)}
          onConfirm={(reason) =>
            refuseTarget && void handleNotVerified(refuseTarget, reason)
          }
        />
      </Sheet>

      {/* Attaching is a selection task, so it is a Dialog — the §8 rule, not one
          of this module's two exceptions to it. It sits above the trip sheet and
          the trip's table refreshes underneath from `TRIP_WIDE`. */}
      {trip && (
        <AttachExpenseDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          tripId={trip.id}
          tripName={trip.name}
          fromDate={trip.from_date}
          toDate={trip.to_date}
        />
      )}

      {/* The expense, opened on top of the trip rather than instead of it.

          A SIBLING of the sheet above, not a child of it — the same structure
          and the same reason as `ExpenseFormSheet -> TripFormSheet`. Both portal
          to the body and stack, so the trip stays mounted underneath with its
          table, its scroll position and its filters intact; a second
          `Dialog.Root` inside the first one's subtree is what makes nested
          sheets fight over focus trapping and dismissal, and Escape then closes
          whichever one Radix happens to be holding.

          §8 forbids opening a Sheet from a Sheet, and this is the second
          documented exception in this module. The rule is aimed at a nested
          *confirmation* burying the thing it is asking about — which is why the
          two dialogs above are Dialogs. This is not a confirmation: it is the
          full expense record, with its timeline, its comment thread, its
          receipts and its own action bar. A Dialog cannot hold that, and the
          alternative the rule leaves — navigating — is exactly what this
          replaced.

          Closing it clears the id and nothing else. `VERIFICATION_WIDE` has
          already invalidated the trip's expense list, so any mark made inside is
          on the row behind before the panel finishes sliding away. */}
      <ExpenseDetailSheet
        open={focusedExpenseId !== null}
        onOpenChange={(o) => !o && setFocusedExpenseId(null)}
        expenseId={focusedExpenseId}
        onEdit={(id) => {
          setFocusedExpenseId(null)
          setEditExpenseId(id)
        }}
      />

      {/* Edit, reopening the detail drawer on save — the same hand-off the trip
          list does between `TripFormSheet` and this sheet. The trip drawer is
          still the floor of the stack throughout; only the panel on top of it
          changes. */}
      <ExpenseFormSheet
        open={editExpenseId !== null}
        onOpenChange={(o) => !o && setEditExpenseId(null)}
        expenseId={editExpenseId}
        onSaved={(id) => {
          setEditExpenseId(null)
          setFocusedExpenseId(id)
        }}
      />
    </>
  )
}

/** What the settle dialog is actually about to act on, in the settler's terms. */
function settleDescription(complete: number, total: number): string {
  const left = total - complete
  const noun = complete === 1 ? 'expense' : 'expenses'
  if (left <= 0) {
    return `All ${complete} ${noun} on this trip are fully verified and will be settled.`
  }
  return `${complete} fully verified ${noun} will be settled. ${left} ${
    left === 1 ? 'is' : 'are'
  } still awaiting a mark and will be skipped — settle again once they are marked.`
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
 * `AdvanceDetailSheet` — three drawers over one chain must not drift.
 */

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <TableHead
      className={`h-10 text-xs font-medium uppercase tracking-wide text-muted-foreground ${className}`}
    >
      {children}
    </TableHead>
  )
}

function destinationOf(trip: TripDetailType): string {
  return (
    [trip.destination_city, trip.destination_state, trip.destination_country]
      .filter(Boolean)
      .join(', ') || '—'
  )
}

/** The service's own sentence for a refusal — see the twin in `GateActionBar`. */
function errorDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  return null
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default TripDetailSheet
