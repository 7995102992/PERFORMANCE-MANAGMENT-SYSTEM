/**
 * Put expenses you have already written onto a trip (§8.3).
 *
 * Until now the link could only be made from inside one expense — open it, pick
 * a trip in *Add To Trip*, save — so putting five loose claims on one trip meant
 * five round trips through a form. This is the same operation from the trip's
 * side, several at a time.
 *
 * **A Dialog, not a Sheet.** `TripDetailSheet` is itself a Sheet and CLAUDE.md
 * §8 forbids opening one from inside another; `ExpenseFormSheet` carves out an
 * exception for its nested trip form, and a selection task does not need to
 * widen it.
 *
 * **No new endpoint.** Attachment lives on the expense, not the trip: this is
 * `PATCH /expenses/{id} { trip_id, draft_version }` per row, the same call the
 * *Add To Trip* select has always made. N selected rows is N patches, which is
 * why the result is reported per row rather than as one toast.
 */
import { useEffect, useMemo, useState } from 'react'
import { Inbox, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/shared/EmptyState'
import { useDebounce } from '@/hooks/use-debounce'
import {
  useAttachExpenseToTripMutation,
  useGetExpensesQuery,
  useLazyGetExpenseQuery,
} from '@/store/api/expenseApi'
import { formatDate, formatMoney } from '@/lib/expense-utils'
import type { ExpenseRow } from '@/types/expense'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  tripId: string
  tripName: string
  /** The trip's own window, used to seed the candidate list. */
  fromDate?: string | null
  toDate?: string | null
  /** Fired once, after at least one row attached. */
  onAttached?: () => void
}

/**
 * How far either side of the trip to look for candidates.
 *
 * A claim is routinely dated a day or two outside the trip it belongs to — a
 * flight booked the evening before, a cab home the morning after. The window is
 * arbitrary server-side, so widening it costs nothing and narrowing it to the
 * exact dates would hide the two expenses people most often forget.
 */
const WINDOW_PAD_DAYS = 7

/** The server's message for a refused patch, or null when it sent none. */
function extractDetail(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const detail = (data as { detail?: unknown })?.detail
  if (typeof detail === 'string') return detail
  return null
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + days)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function AttachExpenseDialog({
  open,
  onOpenChange,
  tripId,
  tripName,
  fromDate,
  toDate,
  onAttached,
}: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [attaching, setAttaching] = useState(false)
  const debouncedSearch = useDebounce(search, 350)

  // Reopening with a stale selection would attach rows the user picked, changed
  // their mind about, and closed the dialog to discard.
  useEffect(() => {
    if (open) {
      setSelected([])
      setSearch('')
    }
  }, [open])

  const dateWindow = useMemo(() => {
    // No dates on the trip yet — it is a draft nobody has filled in — so fall
    // back to a span wide enough that the list is never mysteriously empty.
    if (!fromDate || !toDate) return { month_from: '1970-01-01', month_to: '2999-12-31' }
    return {
      month_from: shiftDate(fromDate, -WINDOW_PAD_DAYS),
      month_to: shiftDate(toDate, WINDOW_PAD_DAYS),
    }
  }, [fromDate, toDate])

  const { data, isFetching } = useGetExpensesQuery(
    {
      scope: 'my',
      status: ['DRAFT'],
      page_size: 100,
      search: debouncedSearch || undefined,
      ...dateWindow,
    },
    { skip: !open },
  )

  const [fetchExpense] = useLazyGetExpenseQuery()
  const [attach] = useAttachExpenseToTripMutation()

  /**
   * Only drafts with no trip yet.
   *
   * Filtered here rather than on the wire because `ExpenseListParams.trip_id` is
   * a positive filter with no "is null" form — asking the server for unattached
   * rows would mean a new list parameter for one dialog.
   *
   * Rows already on *another* trip are excluded rather than offered for
   * re-pointing. Re-pointing is a real need, but it silently takes a line off a
   * trip someone may already be verifying, and that is a decision to make on the
   * expense itself where the current trip is in front of you — not a side effect
   * of ticking a box in a list headed *Attach existing*.
   */
  const candidates: ExpenseRow[] = useMemo(
    () => (data?.items ?? []).filter((row) => !row.trip?.trip_id),
    [data],
  )

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )

  const handleAttach = async () => {
    setAttaching(true)
    const failures: { id: string; message: string }[] = []
    let attached = 0

    for (const id of selected) {
      const row = candidates.find((c) => c.id === id)
      const label = row?.display_id ?? id
      try {
        // `draft_version` is the optimistic guard and the list row does not
        // carry one — only `ExpenseDetail` has it. Read immediately before the
        // write rather than at selection time, so a row edited in another tab
        // while this dialog sat open is refused rather than clobbered.
        const detail = await fetchExpense(id).unwrap()
        await attach({ id, tripId, draftVersion: detail.draft_version }).unwrap()
        attached += 1
      } catch (err) {
        failures.push({
          id,
          message: `${label}: ${extractDetail(err) ?? 'could not be attached'}`,
        })
      }
    }

    setAttaching(false)

    // Per row, not one verdict for the batch. Each patch carries its own version
    // guard and can lose its own race, so "3 of 5 attached" is a real outcome and
    // the two that failed have to be nameable.
    if (attached) {
      toast.success(
        attached === 1
          ? `1 expense attached to ${tripName}`
          : `${attached} expenses attached to ${tripName}`,
      )
      onAttached?.()
    }
    for (const failure of failures) toast.error(failure.message)
    if (!failures.length) {
      onOpenChange(false)
      return
    }
    // Leave exactly the rows that failed ticked, so a retry is one more click and
    // cannot re-attach the ones that already landed. Keyed on the id, never on
    // the message — the message leads with `display_id`, which is not the id.
    setSelected(failures.map((failure) => failure.id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Attach existing expenses</DialogTitle>
          <DialogDescription>
            Your saved expenses that are not on a trip yet. Attaching moves them
            onto {tripName} — they are then verified from the trip and settled
            with it, rather than submitted on their own.
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="Search by name or expense ID..."
          className="h-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="max-h-[320px] overflow-y-auto rounded-xl border">
          {isFetching && candidates.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : candidates.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing to attach"
              description="You have no saved expenses without a trip in this period. Use Add Expense to write a new one."
            />
          ) : (
            candidates.map((row) => (
              <label
                key={row.id}
                className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-0 hover:bg-muted/50"
              >
                <Checkbox
                  checked={selected.includes(row.id)}
                  onCheckedChange={() => toggle(row.id)}
                  aria-label={`Attach ${row.title}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{row.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.display_id} · {formatDate(row.expense_date)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-medium text-foreground">
                  {formatMoney(row.claimed_amount, row.currency)}
                </span>
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAttach} disabled={!selected.length || attaching}>
            {attaching
              ? 'Attaching…'
              : selected.length === 1
                ? 'Attach 1 expense'
                : `Attach ${selected.length} expenses`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
