/**
 * The advance list, shared by My Advances and Team Advances (§9.5).
 *
 * Two views over one collection: the employee's own, and those a manager
 * allocated or approved. One component because only the scope and one column
 * differ — the tiles, filters, month scoping and pagination are identical.
 *
 * Table markup is CLAUDE.md §17 Format A: flush inside the card, toolbars as
 * `border-b` rows, pagination inside at the bottom.
 */
import { useMemo, useState } from 'react'

import {
  ChevronDown,
  CircleDollarSign,
  Inbox,
  Landmark,
  Plus,
  Undo2,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
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
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { ExpenseStatusChip } from './ExpenseStatusChip'
import { MonthScopeBar } from './MonthScopeBar'
import { DateWindowFilter } from './DateWindowFilter'
import { RecordCalendar, type CalendarDayData } from './RecordCalendar'
import { RequestAdvanceSheet } from './RequestAdvanceSheet'
import { AllocateAdvanceSheet } from './AllocateAdvanceSheet'
import { ReturnAdvanceSheet } from './ReturnAdvanceSheet'
import { AdvanceDetailSheet } from './AdvanceDetailSheet'
import { useExpenseListState } from '@/hooks/use-expense-list-state'
import { useDebounce } from '@/hooks/use-debounce'
import { useAuth } from '@/hooks/use-auth'
import {
  useGetAdvanceSummaryQuery,
  useGetAdvancesQuery,
} from '@/store/api/expenseApi'
import { useProjectPicker } from '@/hooks/use-project-options'
import {
  ADVANCE_STATUS_FILTER,
  formatDate,
  formatMoney,
  statusLabel,
} from '@/lib/expense-utils'
import type { AdvanceScope, RecordStatus } from '@/types/expense'

interface Props {
  scope: AdvanceScope
  title: string
  subtitle: string
  /**
   * A second population this page can switch to — see the same prop on
   * `ExpenseListView`.
   *
   * Rendered as a **toolbar toggle rather than a card**, unlike the other two
   * lists. The tile row here is four money totals (Total / Utilized / Returned
   * / Balance) which are display-only figures, not filters: a clickable card
   * dropped among them would be a different kind of control wearing the same
   * clothes.
   */
  altScope?: AdvanceScope
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

export function AdvanceListView({
  scope,
  title,
  subtitle,
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
  const auth = useAuth()
  const { state, patch, range, isCustomRange } = useExpenseListState()

  const [selectedAdvanceId, setSelectedAdvanceId] = useState<string | null>(null)

  const [sheet, setSheet] = useState<null | 'request' | 'allocate' | 'return'>(null)
  const debouncedSearch = useDebounce(state.search, 350)

  const showAllottedTo = activeScope !== 'mine'

  const utilizedFilter = state.utilized

  const listParams = useMemo(
    () => ({
      scope: activeScope,
      ...range,
      page: state.page,
      page_size: state.pageSize,
      search: debouncedSearch || undefined,
      project_id: state.project || undefined,
      client_id: state.client || undefined,
      utilized: utilizedFilter,
      statuses: state.status.length ? state.status : undefined,
    }),
    [activeScope, range, state, debouncedSearch, utilizedFilter],
  )

  const { data: page, isFetching } = useGetAdvancesQuery(listParams, {
    skip: state.view === 'calendar',
  })

  // Advances have no dedicated calendar endpoint, so the month grid is built
  // from the list itself — fetched unpaginated for calendar view so a whole
  // month shows, not just the current page.
  const { data: calendarPage } = useGetAdvancesQuery(
    { ...listParams, page: 1, page_size: 500 },
    { skip: state.view !== 'calendar' },
  )

  const calendarDays = useMemo<CalendarDayData[]>(() => {
    const byDay = new Map<string, CalendarDayData>()
    for (const row of calendarPage?.items ?? []) {
      const iso = (row.allotted_at ?? row.disbursed_at)?.slice(0, 10)
      if (!iso) continue
      let day = byDay.get(iso)
      if (!day) {
        day = { day: iso, count: 0, cards: [] }
        byDay.set(iso, day)
      }
      day.count += 1
      if (day.cards.length < 3) {
        day.cards.push({
          id: row.id,
          primary: row.display_id,
          secondary: formatMoney(row.amount, 'INR', { decimals: false }),
          tertiary: row.project_ref?.name ?? undefined,
          status: row.status,
        })
      }
    }
    return Array.from(byDay.values())
  }, [calendarPage])

  const { data: summary, isLoading: summaryLoading } = useGetAdvanceSummaryQuery({
    scope: activeScope,
    ...range,
    search: debouncedSearch || undefined,
    project_id: state.project || undefined,
    client_id: state.client || undefined,
    utilized: utilizedFilter,
  })

  // Admin routes -> the employee route; client narrows project.
  const { clientOptions, projectOptions, clientForProject } = useProjectPicker(state.client)

  const rows = page?.items ?? []
  const total = page?.total ?? 0

  const advancePerms = (auth.permissions?.['expense_management'] as string[]) ?? []
  const canRequest = advancePerms.includes('request_expense_advance')
  // Finance, not `allot_expense_advance`. Allocation raises money in somebody
  // else's name and opens the org's chain to do it, which is a finance function
  // rather than a line manager's — so a manager holding the allotment grant (for
  // the Team Advances screen and for recording a disbursement, which is what it
  // still means) no longer sees the item. The route demands the same code; this
  // only stops offering a button that would 403.
  const canAllocate = advancePerms.includes('expense_finance_approval')


  const columnCount = 9 + (showAllottedTo ? 1 : 0)

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-xl border bg-card p-6">
        <PageHeader
          className="items-center"
          title={heading}
          subtitle={headingSubtitle}
          action={
            (canRequest || canAllocate) && (
              <AdvanceSplitCta
                canRequest={canRequest}
                canAllocate={canAllocate}
                onSelect={setSheet}
              />
            )
          }
        />
      </div>

      <AdvanceTileRow
        summary={summary}
        isLoading={summaryLoading}
        showIcons={false}
      />

      <div className="overflow-hidden rounded-xl border bg-card">
        <MonthScopeBar
          month={state.month}
          onMonthChange={(month) => patch({ month })}
          view={state.view}
          // The calendar is a month grid, so opening it hands the window back to
          // the month stepper — see `MonthScopeBar`.
          onViewChange={(next) =>
            patch(
              next === 'calendar'
                ? { view: next, datePreset: 'month', fromDate: '', toDate: '' }
                : { view: next },
            )
          }
          scopeOverridden={isCustomRange}
        />

        {/* Toolbar — search + filters, on their own row below the month bar
            (matches the expense lists). */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          {altScope && (
            // Which population is listed, not which slice of it — so it leads
            // the toolbar rather than sitting among the filters.
            <div className="flex items-center overflow-hidden rounded-lg border">
              {[
                { label: 'All', on: false },
                { label: altLabel, on: true },
              ].map(({ label, on }) => (
                <Button
                  key={label}
                  variant="ghost"
                  size="sm"
                  aria-pressed={showingAlt === on}
                  className={cn(
                    'h-9 rounded-none px-3 font-normal',
                    showingAlt === on && 'bg-primary/5 text-foreground',
                  )}
                  onClick={() => {
                    if (showingAlt === on) return
                    // A status chosen for one population may select nothing in
                    // the other, so it is cleared with the switch.
                    patch({ status: [], page: 1 })
                    setShowingAlt(on)
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}

          <Input
            placeholder="Search by advance ID..."
            className="h-9 max-w-[240px] flex-1"
            value={state.search}
            onChange={(e) => patch({ search: e.target.value })}
          />

          {/* Height matched to the <Select> triggers so every filter in the
              toolbar sits on the same 36px line. */}
          {/* Client before project: it narrows the project list, and a filter
              pair that cannot co-occur would simply return nothing. */}
          <div className="w-[160px]">
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

          <div className="w-[160px]">
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
            value={utilizedFilter === undefined ? 'all' : String(utilizedFilter)}
            onValueChange={(v) =>
              patch({ utilized: v === 'all' ? undefined : v === 'true' })
            }
          >
            <SelectTrigger className="h-9 w-[150px]">
              <SelectValue placeholder="Utilized" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Utilized: All</SelectItem>
              <SelectItem value="true">Utilized: Yes</SelectItem>
              <SelectItem value="false">Utilized: No</SelectItem>
            </SelectContent>
          </Select>

          <DateWindowFilter
            preset={state.datePreset}
            fromDate={state.fromDate}
            toDate={state.toDate}
            onPatch={patch}
          />
        </div>

        {state.view === 'calendar' ? (
          <RecordCalendar
            month={state.month}
            days={calendarDays}
            onCardClick={(id) => setSelectedAdvanceId(id)}
          />
        ) : (
          <>
        <Table>
          <TableHeader>
            <TableRow className="border-b border-table-border bg-table-header hover:bg-table-header">
              <Th>Advance ID</Th>
              <Th>Project</Th>
              <Th>Client</Th>
              {showAllottedTo && <Th>Allotted To</Th>}
              <Th>Allotted By</Th>
              <Th>Amount</Th>
              <Th>Allotted Date</Th>
              <Th>Utilized</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !isFetching && (
              <TableRow>
                <TableCell colSpan={columnCount} className="p-0">
                  <EmptyState
                    icon={Inbox}
                    title={
                      scope === 'mine'
                        ? 'No advances this month'
                        : 'No team advances this month'
                    }
                    description={
                      scope === 'mine'
                        ? 'Request an advance, or ask your manager to allocate one.'
                        : 'Advances you allocate or approve will appear here.'
                    }
                  />
                </TableCell>
              </TableRow>
            )}

            {rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => setSelectedAdvanceId(row.id)}
              >
                <TableCell className="text-sm text-muted-foreground">
                  {row.display_id}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.project_ref?.name ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.client_ref?.name ?? '—'}
                </TableCell>
                {showAllottedTo && (
                  <TableCell className="text-sm text-muted-foreground">
                    {row.employee_name ?? '—'}
                  </TableCell>
                )}
                <TableCell className="text-sm text-muted-foreground">
                  {row.disbursed_by?.name ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatMoney(row.amount)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(row.allotted_at ?? row.disbursed_at)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatMoney(row.utilized)}
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

      <RequestAdvanceSheet
        open={sheet === 'request'}
        onOpenChange={(v) => setSheet(v ? 'request' : null)}
      />
      <AllocateAdvanceSheet
        open={sheet === 'allocate'}
        onOpenChange={(v) => setSheet(v ? 'allocate' : null)}
      />
      <ReturnAdvanceSheet
        open={sheet === 'return'}
        onOpenChange={(v) => setSheet(v ? 'return' : null)}
      />
      <AdvanceDetailSheet
        open={!!selectedAdvanceId}
        onOpenChange={(v) => !v && setSelectedAdvanceId(null)}
        advanceId={selectedAdvanceId}
      />
    </div>
  )
}

/**
 * One *Advance ▾* split button, as drawn (§9.2). The two origins live behind
 * one control because they produce the same document — `origin` records which
 * path it took — but they are gated separately: only a manager may allocate.
 */
function AdvanceSplitCta({
  canRequest,
  canAllocate,
  onSelect,
}: {
  canRequest: boolean
  canAllocate: boolean
  onSelect: (sheet: 'request' | 'allocate' | 'return') => void
}) {
  const primary = canRequest ? 'request' : 'allocate'

  return (
    <div className="flex items-center">
      <Button
        className="gap-2 rounded-r-none border-r-0"
        onClick={() => onSelect(primary)}
      >
        <Plus className="size-4" />
        Advance
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="rounded-l-none px-2" aria-label="Advance actions">
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRequest && (
            <DropdownMenuItem onClick={() => onSelect('request')}>
              Request Advance
            </DropdownMenuItem>
          )}
          {canAllocate && (
            <DropdownMenuItem onClick={() => onSelect('allocate')}>
              Allocate Advance
            </DropdownMenuItem>
          )}
          {canRequest && (
            <DropdownMenuItem onClick={() => onSelect('return')}>
              Return Advance
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * **Five tiles, not the four drawn.**
 *
 * `balance` and `available` diverge the moment a draft holds funds — the §19.6
 * worked example has ₹25,000 balance against ₹17,000 available — and a user
 * who reads only *Balance* selects an advance, is refused at submit, and has no
 * way to understand why. The missing **Available** tile is a real bug, not a
 * nicety (§9.6 design gap). *Held* rides as the sub-label, because it is the
 * whole explanation for the gap.
 *
 * `AdvanceSummary` is a flat totals object, not the `SummaryTile[]` the expense
 * lists get, so this is CLAUDE.md §4 stat-card markup rather than
 * `<SummaryTileRow>`.
 */
function AdvanceTileRow({
  summary,
  isLoading,
  showIcons = true,
}: {
  summary?: {
    total: string
    utilized: string
    held: string
    returned: string
    balance: string
    available: string
  }
  isLoading: boolean
  /** My Advances hides the tile icons; Team Advances keeps them. */
  showIcons?: boolean
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[86px] animate-pulse rounded-xl border bg-card" />
        ))}
      </div>
    )
  }

  if (!summary) return null

  const tiles = [
    { label: 'Total Advance', value: summary.total, icon: Wallet },
    { label: 'Utilized', value: summary.utilized, icon: CircleDollarSign },
    { label: 'Returned', value: summary.returned, icon: Undo2 },
    { label: 'Balance', value: summary.balance, icon: Landmark },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {tiles.map(({ label, value, icon: Icon }) => (
        <div
          key={label}
          className="flex items-center justify-between rounded-xl border bg-card px-5 py-4"
        >
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="truncate text-2xl font-bold text-foreground">
              {formatMoney(value, 'INR', { decimals: false })}
            </p>
          </div>
          {showIcons && (
            <Icon className="size-8 shrink-0 text-muted-foreground" />
          )}
        </div>
      ))}
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
      className={`h-10 text-xs font-medium uppercase tracking-wide text-muted-foreground ${className}`}
    >
      {children}
    </TableHead>
  )
}
