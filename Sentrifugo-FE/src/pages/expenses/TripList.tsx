/**
 * Trips (§8) — the month-scoped list.
 *
 * Two columns here are **not** in the wireframe and are required by §8.7:
 * **Status** and **Total**. Without a status column you cannot tell whether you
 * may claim against a trip, which is the entire point of the list — an expense
 * attached to a trip cannot be submitted until that trip is `APPROVED` (§8.5).
 * Without a total, a trip is an authorisation with no visible consequence.
 *
 * Filters are Trip Type and Status. §12.5 records that none are drawn and names
 * these as the obvious pair.
 */
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  MapPinned,
  Plus,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/shared/EmptyState'
import { PageHeader } from '@/components/shared/PageHeader'
import { TablePagination } from '@/components/shared/TablePagination'
import { MonthScopeBar } from '@/components/expense/MonthScopeBar'
import { RecordCalendar } from '@/components/expense/RecordCalendar'
import { TripFormSheet } from '@/components/expense/TripFormSheet'
import { TripDetailSheet } from '@/components/expense/TripDetailSheet'
import { ExpenseFormSheet } from '@/components/expense/ExpenseFormSheet'
import { SummaryTileRow } from '@/components/expense/SummaryTileRow'
import { DateWindowFilter } from '@/components/expense/DateWindowFilter'
import { useExpenseListState } from '@/hooks/use-expense-list-state'
import { useDebounce } from '@/hooks/use-debounce'
import {
  useGetTripCalendarQuery,
  useGetTripSummaryQuery,
  useGetTripsQuery,
} from '@/store/api/expenseApi'
import {
  formatDate,
  statusLabel,
  TRIP_STATUS_FILTER,
} from '@/lib/expense-utils'
import {
  IN_FLIGHT_STATUSES,
  type ListScope,
  type RecordStatus,
  type SummaryTile,
  type TripScope,
  type TripSummaryResponse,
  type TripType,
} from '@/types/expense'

/** The two modules name the same row-sets differently. */
const TRIP_TO_EXPENSE_SCOPE: Record<TripScope, ListScope> = {
  mine: 'my',
  team: 'team',
  approvals: 'approvals',
  org: 'employees',
}

interface Props {
  /**
   * `TripScope`, not the expense list's `ListScope` — the trip router's enum is
   * `mine | team | org`. It was declared as `'employees'` here, which no trip
   * endpoint accepts and which no call site ever passed.
   */
  scope?: TripScope
  title?: string
  subtitle?: string
  /**
   * A second population offered as the leading card — see the same prop on
   * `ExpenseListView`. Finance reads the org-wide pipeline and also approves
   * within it, and "mine to sign, or signed by me" is a scope rather than a
   * status.
   */
  altScope?: TripScope
  altLabel?: string
  /**
   * Heading for the alternative population, used while its card is selected.
   *
   * The page opens on that card now, so a single heading would describe the
   * wrong rows on arrival: "Employee Expenses / across the organisation" over a
   * queue of four is how somebody concludes the org raised four claims. The
   * caller already holds both strings — `useApproverScope` picks between them —
   * so it passes both and the heading follows the card rather than the grant.
   */
  altTitle?: string
  altSubtitle?: string
}

export function TripList({
  scope = 'mine',
  title = 'Trips',
  subtitle = 'Manage your business trips and travel requests',
  altScope,
  altLabel = 'My Approvals',
  altTitle,
  altSubtitle,
}: Props) {
  // Opens on the approver's own queue whenever there is one. A page offers this
  // card only to somebody who both reads the org-wide pipeline and signs inside
  // it, and only one of those two is work waiting on them — the queue is what
  // they came to act on, the pipeline is what they read when asked a question.
  // The card is one click away either way, so the default only decides which of
  // the two they should not have to ask for.
  const [showingAlt, setShowingAlt] = useState(Boolean(altScope))
  // The heading names the rows on screen, not the grant that got you here.
  const heading = showingAlt ? (altTitle ?? title) : title
  const headingSubtitle = showingAlt ? (altSubtitle ?? subtitle) : subtitle
  const activeScope = showingAlt && altScope ? altScope : scope
  const isEmployeeScope = activeScope === 'mine'
  const [formOpen, setFormOpen] = useState(false)
  const [tripType, setTripType] = useState<TripType | 'all'>('all')
  // Row click opens the detail drawer; its Edit / Add Expense open the form drawers.
  /**
   * Which trip the drawer is showing, held in the URL rather than in state.
   *
   * `/expenses/trips/$tripId` used to be a second, hand-maintained trip screen
   * that drifted four releases behind this drawer — no timeline, no gate
   * actions, no verification, no bulk settle — and that nothing in the app
   * linked to. It now redirects here, which only works if the drawer is
   * addressable. Two things fall out for free: a trip is linkable to a
   * colleague, and Back closes the drawer instead of leaving the list.
   */
  const navigate = useNavigate()
  const { trip: tripParam } = useSearch({ strict: false }) as { trip?: string }
  const detailId = tripParam ?? null
  const setDetailId = useCallback(
    (id: string | null) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => {
          const next = { ...prev }
          // Presence is the state: an absent `trip` is a closed drawer, so the
          // key is deleted rather than set to undefined, which would leave
          // `?trip=` in the bar.
          if (id) next.trip = id
          else delete next.trip
          return next
        },
      })
    },
    [navigate],
  )
  const [editTripId, setEditTripId] = useState<string | null>(null)
  const [addExpenseTripId, setAddExpenseTripId] = useState<string | null>(null)

  const {
    state,
    patch,
    range,
    monthWindow,
    isCustomRange,
    hasActiveFilters,
    clearFilters,
  } = useExpenseListState()
  // The calendar cannot draw an arbitrary span, so a range forces the list. The
  // toggle that would switch back is hidden for the same reason.
  const view = isCustomRange ? 'list' : state.view
  const debouncedSearch = useDebounce(state.search, 350)

  // The trip list takes a **single** status, unlike the expense list's
  // repeatable filter — the router declares `status: RecordStatus | None`.
  const singleStatus = state.status[0]

  const listParams = useMemo(
    () => ({
      scope: activeScope,
      ...range,
      page: state.page,
      page_size: state.pageSize,
      search: debouncedSearch || undefined,
      trip_type: tripType === 'all' ? undefined : tripType,
      status: singleStatus,
    }),
    [activeScope, range, state.page, state.pageSize, debouncedSearch, tripType, singleStatus],
  )

  const { data: page, isFetching } = useGetTripsQuery(listParams, {
    skip: view === 'calendar',
  })

  const { data: summary, isLoading: summaryLoading } = useGetTripSummaryQuery({
    scope: activeScope,
    ...range,
  })

  // Counted under whichever scope is not on screen — the card advertises the
  // population it switches to. Skipped when the page offers no alternative.
  const { data: altSummary } = useGetTripSummaryQuery(
    { scope: showingAlt ? scope : (altScope as TripScope), ...range },
    { skip: !altScope },
  )

  // `monthWindow`, not `range`: the calendar draws a month grid, so it asks for a
  // month even in the branch where the list is following a range. It is skipped
  // while one is set — this is what makes that skip belt-and-braces rather than
  // the only thing standing between the grid and a 90-day window.
  const { data: calendar } = useGetTripCalendarQuery(
    { scope, ...monthWindow },
    { skip: view !== 'calendar' },
  )

  const rows = page?.items ?? []
  const total = page?.total ?? 0

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-xl border bg-card px-6 py-5">
        <PageHeader
          className="items-center"
          title={heading}
          subtitle={headingSubtitle}
          action={
            isEmployeeScope ? (
              <Button className="gap-2" onClick={() => setFormOpen(true)}>
                <Plus className="size-4" /> Add Trip
              </Button>
            ) : undefined
          }
        />
      </div>

      <SummaryTileRow
        tiles={tripTiles(activeScope, summary)}
        currency="INR"
        activeStatuses={state.status}
        onSelect={(statuses) => {
          patch({ status: statuses })
        }}
        scopeTile={
          altScope
            ? {
                label: altLabel,
                count:
                  (showingAlt ? summary?.total_trips : altSummary?.total_trips) ?? 0,
                active: showingAlt,
                onToggle: () => {
                  // A status chosen for one population may select nothing in the
                  // other, so it is cleared with the switch.
                  patch({ status: [], page: 1 })
                  setShowingAlt((v) => !v)
                },
              }
            : undefined
        }
        isLoading={summaryLoading}
      />

      <div className="overflow-hidden rounded-xl border bg-card">
        <MonthScopeBar
          month={state.month}
          onMonthChange={(month) => patch({ month })}
          view={view}
          // The calendar is a month grid, so opening it hands the window back
          // to the month stepper. Without this, picking `All time` or a custom
          // range would leave the toggle offering a view that quietly ignores
          // the filter.
          onViewChange={(next) =>
            patch(
              next === 'calendar'
                ? { view: next, datePreset: 'month', fromDate: '', toDate: '' }
                : { view: next },
            )
          }
          scopeOverridden={isCustomRange}
        />

        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <Input
            placeholder="Search by trip name or ID..."
            className="h-9 max-w-sm flex-1"
            value={state.search}
            onChange={(e) => patch({ search: e.target.value })}
          />

          <Select
            value={tripType}
            onValueChange={(v) => {
              setTripType(v as TripType | 'all')
              patch({ page: 1 })
            }}
          >
            <SelectTrigger className="h-9 w-[170px]">
              <SelectValue placeholder="All Trip Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Trip Types</SelectItem>
              <SelectItem value="DOMESTIC">Domestic</SelectItem>
              <SelectItem value="INTERNATIONAL">International</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={singleStatus ?? 'all'}
            onValueChange={(v) =>
              patch({ status: v === 'all' ? [] : [v as RecordStatus] })
            }
          >
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              {TRIP_STATUS_FILTER.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DateWindowFilter
            preset={state.datePreset}
            fromDate={state.fromDate}
            toDate={state.toDate}
            onPatch={patch}
            className="w-[160px]"
          />

          {(hasActiveFilters || tripType !== 'all' || singleStatus) && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => {
                setTripType('all')
                clearFilters()
              }}
            >
              <X className="size-3.5" /> Clear
            </Button>
          )}
        </div>


        {view === 'calendar' ? (
          <RecordCalendar
            month={state.month}
            days={(calendar?.days ?? []).map((d) => ({
              day: d.day,
              count: d.count,
              cards: d.cards.map((c) => ({
                id: c.id,
                primary: c.name,
                secondary: c.destination ?? undefined,
                tertiary: c.display_id,
                status: c.status,
              })),
            }))}
            onCardClick={(id) => setDetailId(id)}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="border-b border-table-border bg-table-header hover:bg-table-header">
                  <Th>Trip ID</Th>
                  <Th>Trip Name</Th>
                  <Th>Trip Type</Th>
                  <Th>Destination City</Th>
                  <Th>Destination State</Th>
                  <Th>From Date</Th>
                  <Th>To Date</Th>
                  <Th>Project</Th>
                  <Th>Client</Th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !isFetching && (
                  <TableRow>
                    <TableCell colSpan={9} className="p-0">
                      <EmptyState
                        icon={MapPinned}
                        title="No trips this month"
                        description={
                          hasActiveFilters || tripType !== 'all' || singleStatus
                            ? 'No trips match the filters you have applied.'
                            : 'Add a trip to authorise travel before you file expenses against it.'
                        }
                      />
                    </TableCell>
                  </TableRow>
                )}

                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => setDetailId(row.id)}
                  >
                    <TableCell className="text-sm text-muted-foreground">
                      {row.display_id}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.name}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.trip_type === 'INTERNATIONAL'
                        ? 'International'
                        : 'Domestic'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.destination_city || '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.destination_state || '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.from_date)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.to_date)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.project_ref?.name ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.client_ref?.name ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
              <span>
                {total > 0
                  ? `Showing ${(state.page - 1) * state.pageSize + 1}–${Math.min(
                      state.page * state.pageSize,
                      total,
                    )} of ${total}`
                  : ''}
              </span>
              <TablePagination
                currentPage={state.page}
                totalPages={Math.max(1, Math.ceil(total / state.pageSize))}
                startIndex={(state.page - 1) * state.pageSize}
                endIndex={Math.min(state.page * state.pageSize, total)}
                total={total}
                pageSize={state.pageSize}
                onPageChange={(p) => patch({ page: p })}
                onPageSizeChange={(s) => patch({ pageSize: s, page: 1 })}
              />
            </div>
          </>
        )}
      </div>

      {/* New trip — opens the detail drawer on save. */}
      <TripFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        tripId={null}
        onSaved={(id) => setDetailId(id)}
      />

      {/* Read-only detail drawer opened from a row / calendar card. */}
      <TripDetailSheet
        open={detailId !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        tripId={detailId}
        // Trip and expense scopes name the same three row-sets differently.
        expenseScope={TRIP_TO_EXPENSE_SCOPE[activeScope]}
        onEdit={(id) => {
          setDetailId(null)
          setEditTripId(id)
        }}
        onAddExpense={(id) => {
          setDetailId(null)
          setAddExpenseTripId(id)
        }}
        onSelectTrip={(id) => setDetailId(id)}
      />

      {/* Edit form — reopens the detail drawer on save. */}
      <TripFormSheet
        open={editTripId !== null}
        onOpenChange={(o) => !o && setEditTripId(null)}
        tripId={editTripId}
        onSaved={(id) => {
          setEditTripId(null)
          setDetailId(id)
        }}
      />

      {/* Add Expense seeded with the trip. */}
      <ExpenseFormSheet
        open={addExpenseTripId !== null}
        onOpenChange={(o) => !o && setAddExpenseTripId(null)}
        expenseId={null}
        presetTripId={addExpenseTripId ?? undefined}
      />
    </div>
  )
}

/**
 * The status tiles above a trip list.
 *
 * **Composed here, unlike the expense row.** Expenses have a server-side
 * `tiles_for(scope)`; `GET /trips/summary` returns a raw `count_by_status`, so
 * the same decisions are made on this side. The two must stay recognisably the
 * same row — which is why this mirrors `tiles_for` rather than inventing a
 * second policy — and moving it to the server would be the better fix if trips
 * ever grow money totals per tile.
 *
 * Two ways it differs from the expense row, both forced by the subject:
 *
 * - **"Closed", not "Settled".** A trip's post-approval tail is
 *   `APPROVED -> CLOSED`; only an expense settles. The tile occupies the same
 *   slot and answers the same question — *which of these are finished* — under
 *   the only status a trip can actually reach.
 * - **"Saved" is the owner's tile.** Every other scope filters drafts out at the
 *   query (`_scope_clause` on the server), so the tile could only ever read zero
 *   on Team and Employee Trips. It was doing exactly that; adding a sixth tile is
 *   what made a permanently-empty one worth removing rather than tolerating.
 */
function tripTiles(
  scope: TripScope,
  summary: TripSummaryResponse | undefined,
): SummaryTile[] {
  const at = (status: RecordStatus) => summary?.count_by_status?.[status] ?? 0
  // Trip tiles count rows; the money columns exist only to satisfy the shared
  // tile shape, and `showAmounts` is off on this row.
  const tile = (key: string, label: string, count: number): SummaryTile => ({
    key,
    label,
    count,
    claimed_amount: '0',
    approved_amount: '',
    net_payable: '',
  })

  return [
    tile('all', 'All', summary?.total_trips ?? 0),
    ...(scope === 'mine' ? [tile('saved', 'Saved', at('DRAFT'))] : []),
    tile(
      'submitted',
      'Submitted',
      IN_FLIGHT_STATUSES.reduce((sum, s) => sum + at(s), 0),
    ),
    tile('approved', 'Approved', at('APPROVED')),
    tile('rejected', 'Rejected', at('REJECTED')),
    tile('closed', 'Closed', at('CLOSED')),
  ]
}

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

export default TripList
