/**
 * The expense list, shared by all three scopes (§12.6).
 *
 * My Expense, Team Expenses and Employee Expenses are the same table over three
 * different row sets. They stay one component because the differences are
 * genuinely small — which columns show, which tiles the server returns, and
 * whether bulk settlement is offered — while the month scoping, filtering,
 * calendar toggle and pagination are identical. Three copies would drift.
 *
 * Table markup is CLAUDE.md §17 Format A: flush inside the card, toolbars as
 * `border-b` rows, pagination inside at the bottom.
 */
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Inbox, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { ExpenseStatusChip } from './ExpenseStatusChip'
import { ExpenseDetailSheet } from './ExpenseDetailSheet'
import { ExpenseFormSheet } from './ExpenseFormSheet'
import { MonthScopeBar } from './MonthScopeBar'
import { DateWindowFilter } from './DateWindowFilter'
import { RecordCalendar } from './RecordCalendar'
import { SummaryTileRow } from './SummaryTileRow'
import { BulkMarkPaidBar } from './BulkMarkPaidBar'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { useExpenseListState } from '@/hooks/use-expense-list-state'
import { useEmployeeNames } from '@/hooks/use-employee-names'
import { useDebounce } from '@/hooks/use-debounce'
import {
  useGetExpenseCalendarQuery,
  useGetExpenseCategoriesQuery,
  useGetExpenseSummaryQuery,
  useGetExpensesQuery,
} from '@/store/api/expenseApi'
import { useProjectPicker } from '@/hooks/use-project-options'
import {
  APPROVER_STATUS_FILTER,
  EXPENSE_STATUS_FILTER,
  formatDate,
  formatMoney,
  statusLabel,
} from '@/lib/expense-utils'
import type { ListScope, RecordStatus, SummaryTile } from '@/types/expense'

interface Props {
  scope: ListScope
  title: string
  subtitle: string
  /** Employee scope only — opens the Add Expense sheet. */
  onCreate?: () => void
  /**
   * Finance's queue opens on its actionable slice rather than the whole
   * org-wide pipeline (§18.1 E). The server applies the same default.
   */
  defaultStatus?: RecordStatus[]
  /**
   * A second population this page can switch to, offered as the leading card.
   *
   * Finance reads the org-wide pipeline but also approves within it, and "the
   * ones I have to sign or have signed" is not a status — so it cannot be
   * another status tile. It is a different **scope**, which already exists as
   * its own route with its own gate, so the card only changes which of the two
   * the page asks for. Nothing new is authorised and no filter is invented.
   *
   * Omitted for a caller who is only ever served one population: Leadership is
   * given the approvals scope outright and has nothing to toggle to.
   */
  altScope?: ListScope
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

export function ExpenseListView({
  scope,
  title,
  subtitle,
  onCreate,
  defaultStatus,
  altScope,
  altLabel = 'My Approvals',
  altTitle,
  altSubtitle,
}: Props) {
  const { nameFor } = useEmployeeNames()
  const { state, patch, range, isCustomRange, hasActiveFilters, clearFilters } =
    useExpenseListState({ status: defaultStatus })

  const [selected, setSelected] = useState<string[]>([])
  // Row click opens the detail drawer; its Edit opens the form drawer.
  /**
   * Which expense the drawer is showing, held in the URL rather than in state.
   *
   * `/expenses/$expenseId` used to be a second, hand-maintained expense screen
   * that drifted behind this drawer — no approval ladder, so no `blocked_reason`
   * anywhere on it, and none of the verification actions — and that nothing in
   * the app linked to. It now redirects here, which only works if the drawer is
   * addressable. A claim becomes linkable, and Back closes the drawer instead of
   * leaving the list. Mirrors `TripList`.
   */
  const navigate = useNavigate()
  const { expense: expenseParam } = useSearch({ strict: false }) as { expense?: string }
  const detailId = expenseParam ?? null
  const setDetailId = useCallback(
    (id: string | null) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => {
          const next = { ...prev }
          // Presence is the state: an absent `expense` is a closed drawer, so
          // the key is deleted rather than set to undefined, which would leave
          // `?expense=` in the bar.
          if (id) next.expense = id
          else delete next.expense
          return next
        },
      })
    },
    [navigate],
  )
  const [editId, setEditId] = useState<string | null>(null)
  const debouncedSearch = useDebounce(state.search, 350)

  // Which of the two populations is on screen. Held here rather than on the
  // page because the month window and filter state live here too, and the card's
  // count has to be fetched for the same window the list is showing.
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

  const isEmployeeScope = activeScope === 'my'
  const showRaisedBy = activeScope !== 'my'
  const showFinanceColumns = activeScope === 'employees'
  // Every scope leads with the Expense ID column; Team & Employee then follow
  // the name with Raised By (and, for the finance scope, Approved By).
  const showExpenseId = true

  const listParams = useMemo(
    () => ({
      scope: activeScope,
      ...range,
      page: state.page,
      page_size: state.pageSize,
      search: debouncedSearch || undefined,
      project_id: state.project || undefined,
      client_id: state.client || undefined,
      category_code: state.category || undefined,
      reimbursable: state.reimbursable,
      status: state.status.length ? state.status : undefined,
    }),
    [activeScope, range, state, debouncedSearch],
  )

  const { data: page, isFetching } = useGetExpensesQuery(listParams, {
    skip: state.view === 'calendar',
  })

  const { data: summary, isLoading: summaryLoading } = useGetExpenseSummaryQuery({
    scope: activeScope,
    ...range,
    search: debouncedSearch || undefined,
    project_id: state.project || undefined,
    client_id: state.client || undefined,
    category_code: state.category || undefined,
    reimbursable: state.reimbursable,
  })

  // The card shows the size of the population it switches *to*, so it has to be
  // counted under the scope that is not currently rendered. Skipped entirely
  // when the page offers no alternative, and deliberately not filtered by
  // status — the card is a population, not a slice of one.
  const { data: altSummary } = useGetExpenseSummaryQuery(
    {
      scope: showingAlt ? scope : (altScope as ListScope),
      ...range,
      search: debouncedSearch || undefined,
      project_id: state.project || undefined,
      client_id: state.client || undefined,
      category_code: state.category || undefined,
      reimbursable: state.reimbursable,
    },
    { skip: !altScope },
  )

  const { data: calendar } = useGetExpenseCalendarQuery(
    {
      scope: activeScope,
      ...range,
      status: state.status.length ? state.status : undefined,
      category_code: state.category || undefined,
    },
    { skip: state.view !== 'calendar' },
  )

  const { data: categories = [] } = useGetExpenseCategoriesQuery()
  // Show the category's display name, not the stored uppercase code.
  const categoryName = (code: string) =>
    categories.find((c) => c.code === code)?.name ?? code

  // Admin routes -> the employee route; client narrows project.
  const { clientOptions, projectOptions, clientForProject } = useProjectPicker(state.client)

  const currency = summary?.currency ?? 'INR'
  const rows = page?.items ?? []
  const total = page?.total ?? 0


  // Only APPROVED rows can be settled, so the checkbox column appears only
  // where a batch is actually possible (§18.1 C).
  const settleableRows = showFinanceColumns
    ? rows.filter((r) => r.available_actions.includes('mark_paid'))
    : []
  const canBulkSettle = settleableRows.length > 0

  const statusOptions = isEmployeeScope
    ? EXPENSE_STATUS_FILTER
    : APPROVER_STATUS_FILTER

  const columnCount =
    8 +
    (showExpenseId ? 1 : 0) +
    (showRaisedBy ? 1 : 0) +
    (showFinanceColumns ? 1 : 0) +
    (canBulkSettle ? 1 : 0)

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-xl border bg-card px-6 py-5">
        <PageHeader
          className="items-center"
          title={heading}
          subtitle={headingSubtitle}
          action={
            onCreate && (
              <Button className="gap-2" onClick={onCreate}>
                <Plus className="size-4" /> Add Expense
              </Button>
            )
          }
        />
      </div>

      <SummaryTileRow
        tiles={labelledTiles(summary?.tiles ?? [], activeScope)}
        currency={currency}
        activeStatuses={state.status}
        onSelect={(statuses) => {
          setSelected([])
          patch({ status: statuses })
        }}
        scopeTile={
          altScope
            ? {
                label: altLabel,
                // When the card is active its own scope is the one on screen, so
                // the count is the current row set; otherwise it is the other.
                count: countOf(showingAlt ? summary?.tiles : altSummary?.tiles),
                active: showingAlt,
                onToggle: () => {
                  // Both selections are about the visible rows, and neither
                  // survives a change of population: a status chosen for one
                  // scope may select nothing in the other, and a checked row may
                  // not be in it at all.
                  setSelected([])
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
          onMonthChange={(month) => {
            setSelected([])
            patch({ month })
          }}
          view={state.view}
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

        {/* Toolbar — search + filters */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <Input
            placeholder="Search by name or expense ID..."
            className="h-9 max-w-[200px] flex-1"
            value={state.search}
            onChange={(e) => patch({ search: e.target.value })}
          />

          {/* Height matched to the <Select> triggers below so every filter in
              the toolbar sits on the same 36px line. */}
          {/* Client before project: it narrows the project list, and a filter
              pair that cannot co-occur would simply return nothing. */}
          <div className="w-[140px]">
            <SearchableSelect
              className="h-9 min-h-9 py-0"
              options={clientOptions}
              value={state.client}
              onChange={(v) => {
                const next = v as string
                const stale = state.project && clientForProject(state.project) !== next
                patch({ client: next, ...(stale ? { project: '' } : {}) })
              }}
              placeholder="Client"
            />
          </div>

          <div className="w-[140px]">
            <SearchableSelect
              className="h-9 min-h-9 py-0"
              options={projectOptions}
              value={state.project}
              onChange={(v) => {
                const next = v as string
                const owner = next ? clientForProject(next) : null
                patch({ project: next, ...(owner ? { client: owner } : {}) })
              }}
              placeholder="Project"
            />
          </div>

          <Select
            value={state.category || 'all'}
            onValueChange={(v) => patch({ category: v === 'all' ? '' : v })}
          >
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={
              state.reimbursable === undefined
                ? 'all'
                : String(state.reimbursable)
            }
            onValueChange={(v) =>
              patch({ reimbursable: v === 'all' ? undefined : v === 'true' })
            }
          >
            <SelectTrigger className="h-9 w-[150px]">
              <SelectValue placeholder="Reimbursable" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Reimbursable: All</SelectItem>
              <SelectItem value="true">Reimbursable: Yes</SelectItem>
              <SelectItem value="false">Reimbursable: No</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={state.status.length === 1 ? state.status[0] : 'all'}
            onValueChange={(v) =>
              patch({ status: v === 'all' ? [] : [v as RecordStatus] })
            }
          >
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              {statusOptions.map((s) => (
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
            onPatch={(next) => {
              // A window change can drop a checked row out of the list, and a
              // selection the reader can no longer see is one they cannot clear.
              setSelected([])
              patch(next)
            }}
          />

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={clearFilters}
            >
              <X className="size-3.5" /> Clear
            </Button>
          )}
        </div>

        {canBulkSettle && selected.length > 0 && (
          <BulkMarkPaidBar
            selectedIds={selected}
            rows={settleableRows}
            currency={currency}
            onDone={() => setSelected([])}
          />
        )}

        {state.view === 'calendar' ? (
          <RecordCalendar
            month={state.month}
            days={(calendar?.days ?? []).map((d) => ({
              day: d.day,
              count: d.count,
              cards: d.cards.map((c) => ({
                id: c.id,
                primary: c.title,
                secondary: formatMoney(c.claimed_amount, currency, {
                  decimals: false,
                }),
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
                  {canBulkSettle && (
                    <TableHead className="h-10 w-10">
                      <Checkbox
                        checked={
                          selected.length > 0 &&
                          selected.length === settleableRows.length
                        }
                        onCheckedChange={(v) =>
                          setSelected(v ? settleableRows.map((r) => r.id) : [])
                        }
                        aria-label="Select all settleable rows"
                      />
                    </TableHead>
                  )}
                  {showExpenseId && <Th>Expense ID</Th>}
                  <Th>Expense Name</Th>
                  {showRaisedBy && <Th>Raised By</Th>}
                  {showFinanceColumns && <Th>Approved By</Th>}
                  <Th>Project</Th>
                  <Th>Client</Th>
                  <Th>Category</Th>
                  <Th>Expense Date</Th>
                  <Th>Amount</Th>
                  <Th>Reimbursable</Th>
                  <Th>Status</Th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !isFetching && (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="p-0">
                      <EmptyState
                        icon={Inbox}
                        title={emptyTitle(activeScope)}
                        description={emptyDescription(activeScope, hasActiveFilters)}
                      />
                    </TableCell>
                  </TableRow>
                )}

                {rows.map((row) => {
                  const settleable = row.available_actions.includes('mark_paid')
                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => setDetailId(row.id)}
                    >
                      {canBulkSettle && (
                        <TableCell
                          className="w-10"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {settleable && (
                            <Checkbox
                              checked={selected.includes(row.id)}
                              onCheckedChange={(v) =>
                                setSelected((prev) =>
                                  v
                                    ? [...prev, row.id]
                                    : prev.filter((id) => id !== row.id),
                                )
                              }
                              aria-label={`Select ${row.display_id}`}
                            />
                          )}
                        </TableCell>
                      )}
                      {showExpenseId && (
                        <TableCell className="text-sm text-muted-foreground">
                          {row.display_id}
                        </TableCell>
                      )}
                      <TableCell className="text-sm text-muted-foreground">
                        {row.title}
                      </TableCell>
                      {showRaisedBy && (
                        <TableCell className="text-sm text-muted-foreground">
                          {nameFor(row.employee_id)}
                        </TableCell>
                      )}
                      {showFinanceColumns && (
                        <TableCell className="text-sm text-muted-foreground">
                          {row.approved_by?.name ?? '—'}
                        </TableCell>
                      )}
                      <TableCell className="text-sm text-muted-foreground">
                        {row.project?.name ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.client?.name ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {categoryName(row.category_code)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(row.expense_date)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <AmountCell
                          claimed={row.claimed_amount}
                          approved={row.approved_amount}
                          currency={row.currency}
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.reimbursable ? 'Yes' : 'No'}
                      </TableCell>
                      <TableCell>
                        <ExpenseStatusChip
                          status={row.status}
                          label={row.status_label}
                          levelNames={row.current_level_names}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            <TablePagination
              currentPage={state.page}
              totalPages={Math.max(1, Math.ceil(total / state.pageSize))}
              startIndex={(state.page - 1) * state.pageSize + 1}
              endIndex={Math.min(state.page * state.pageSize, total)}
              total={total}
              pageSize={state.pageSize}
              onPageChange={(p) => patch({ page: p })}
              onPageSizeChange={(s) => patch({ pageSize: s, page: 1 })}
            />
          </>
        )}
      </div>

      <ExpenseDetailSheet
        open={detailId !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        expenseId={detailId}
        onEdit={(id) => {
          setDetailId(null)
          setEditId(id)
        }}
      />

      <ExpenseFormSheet
        open={editId !== null}
        onOpenChange={(o) => !o && setEditId(null)}
        expenseId={editId}
      />
    </div>
  )
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
      className={`h-10 text-xs font-semibold text-muted-foreground ${className}`}
    >
      {children}
    </TableHead>
  )
}

/**
 * Both figures, always. The claimed amount is the employee's assertion and is
 * evidence in a dispute; showing only the approved figure is how disputes
 * become unresolvable (§19.2). They only differ once Finance has adjusted.
 */
function AmountCell({
  claimed,
  approved,
  currency,
}: {
  claimed: string
  approved?: string | null
  currency: string
}) {
  const adjusted = approved != null && approved !== claimed
  if (!adjusted) return <>{formatMoney(claimed, currency)}</>
  return (
    <span className="inline-flex flex-col items-start leading-tight">
      <span>{formatMoney(approved, currency)}</span>
      <span className="text-xs text-muted-foreground line-through">
        {formatMoney(claimed, currency)}
      </span>
    </span>
  )
}

/** The row count behind a tile set, read off its `all` tile. */
function countOf(tiles: SummaryTile[] | undefined): number {
  return tiles?.find((tile) => tile.key === 'all')?.count ?? 0
}

/**
 * The "All" tile is the one label the client owns (§12.2 correction 14).
 *
 * The server sends the neutral noun "All"; which noun completes it depends on
 * whose records are being counted. Every other tile is rendered exactly as the
 * server sent it.
 */
const ALL_LABEL: Record<ListScope, string> = {
  my: 'All Expenses',
  team: 'All Requests',
  approvals: 'All My Approvals',
  employees: 'All Requests',
}

/**
 * Render the server's tile row, re-labelling only "All".
 *
 * This deliberately does **not** merge over a fixed client-side skeleton. Doing
 * so put a zero-count *Saved* card on the team and finance queues, where the
 * server omits that tile on purpose — someone else's drafts are private — and
 * it dropped *Settled*, which every scope is supposed to carry: without it a
 * settled expense either vanishes from the month or masquerades as Approved
 * (§18.1 D). Which tiles a scope shows is the server's decision.
 */
function labelledTiles(tiles: SummaryTile[], scope: ListScope): SummaryTile[] {
  return tiles.map((tile) =>
    tile.key === 'all' ? { ...tile, label: ALL_LABEL[scope] ?? tile.label } : tile,
  )
}

function emptyTitle(scope: ListScope): string {
  if (scope === 'my') return 'No expenses this month'
  if (scope === 'team') return 'Nobody in your team claimed this month'
  if (scope === 'approvals') return 'You have not been asked to approve anything'
  return 'Nothing awaiting Finance this month'
}

function emptyDescription(scope: ListScope, filtered: boolean): string {
  if (filtered) return 'No records match the filters you have applied.'
  if (scope === 'my') return 'Add an expense to start a claim.'
  if (scope === 'team') return 'Claims raised by the people who report to you will appear here.'
  if (scope === 'approvals')
    return 'Claims you approve appear here when they reach your level, and stay after you have signed.'
  return 'Submitted records across the organisation will appear here as they reach Finance.'
}
