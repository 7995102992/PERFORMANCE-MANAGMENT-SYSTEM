/**
 * List state for the expense surfaces, held in the URL.
 *
 * Month, view mode, page and every filter live in search params so a filtered
 * month is a shareable link and the Back button behaves. The month is separate
 * from row pagination by design — every list is month-scoped independently of
 * how many rows fit on a page (§12.1).
 *
 * `status` stays repeatable even though there is only one pending status now:
 * a Finance view routinely wants APPROVED (settleable) and PENDING_APPROVAL
 * (in flight) together, and the advance list adds ACTIVE on top. What it can no
 * longer express is a *stage* — "waiting on me" is `actor_levels.length > 0` on
 * the row, not a status anyone can put in a URL (§18.1 E).
 */
import { useCallback, useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  currentMonthKey,
  isValidMonthKey,
  monthRange,
  type MonthKey,
} from '@/lib/expense-utils'
import type { RecordStatus } from '@/types/expense'

/**
 * The windows the date filter offers.
 *
 * `month` is the default and means "whatever the month stepper is showing" —
 * the behaviour every list has always had. The three trailing options end today
 * rather than on a calendar boundary, because "last month" asked on the 3rd
 * means the last month, not the 2 days of it that have a calendar month in
 * common with today.
 *
 * `all` is the escape hatch from the month, not the default. A list that opens
 * on everything answers "is there anything at all", which is the question on the
 * first day of a month and almost never after — so it is one click away rather
 * than in the way.
 */
export type DatePreset =
  | 'month'
  | 'today'
  | 'last_month'
  | 'last_2_months'
  | 'all'
  | 'custom'

const DATE_PRESETS: readonly DatePreset[] = [
  'month',
  'today',
  'last_month',
  'last_2_months',
  'all',
  'custom',
]

/** What each option is called, so the label and the behaviour cannot drift. */
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  month: 'This month',
  today: 'Today',
  last_month: 'Last month',
  last_2_months: 'Last 2 months',
  all: 'All time',
  custom: 'Custom range',
}

/**
 * The span `all` sends, wide enough that nothing dated falls outside it.
 *
 * Spelled as a range rather than as an absent one because the window is not
 * optional on the wire: every list and tile endpoint requires `month_from` /
 * `month_to`, and `build_criteria` always applies them. Teaching the server a
 * third "no window" mode to serve one dropdown option would be changing the
 * contract for a preference.
 */
const ALL_TIME = { month_from: '1970-01-01', month_to: '2999-12-31' }

export interface ExpenseListState {
  month: MonthKey
  view: 'list' | 'calendar'
  page: number
  pageSize: number
  search: string
  project: string
  client: string
  category: string
  expenseType: string
  reimbursable: boolean | undefined
  /** Advance lists only — the `Utilized: Yes/No` filter (§9.9 correction 3). */
  utilized: boolean | undefined
  status: RecordStatus[]
  /**
   * Which window the list is on.
   *
   * The month stepper answers "what happened in July". This answers "what
   * happened recently", which a stepper cannot express at all once the span
   * crosses a month boundary — and which is what someone reconciling a quarter
   * actually wants. Every option resolves to the same `month_from` / `month_to`
   * pair on the wire: the server has always taken an arbitrary window, and only
   * the client insisted it be a whole month, so nothing there changes.
   */
  datePreset: DatePreset
  /**
   * The two ends of a `custom` window, inclusive, `YYYY-MM-DD`.
   *
   * Ignored under every other preset. Honoured only when **both** are set and
   * ordered: a half-filled range is one still being picked, and narrowing on the
   * first click would pull rows away mid-input.
   */
  fromDate: string
  toDate: string
}

type RawSearch = Record<string, unknown>

/** State key → search-param key. Anything absent here is not URL-backed. */
const PARAM_KEYS: Record<keyof ExpenseListState, string> = {
  month: 'month',
  view: 'view',
  page: 'page',
  pageSize: 'size',
  search: 'q',
  project: 'project',
  client: 'client',
  category: 'category',
  expenseType: 'type',
  reimbursable: 'reimbursable',
  utilized: 'utilized',
  status: 'status',
  datePreset: 'dr',
  fromDate: 'from',
  toDate: 'to',
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asStatusList(v: unknown): RecordStatus[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string') as RecordStatus[]
  if (typeof v === 'string' && v) return [v as RecordStatus]
  return []
}

/**
 * A `YYYY-MM-DD` search param, or `''`.
 *
 * Shape-checked rather than passed through, because these two reach the server
 * as the list window: a hand-edited URL should fall back to the month, not send
 * junk to `month_from` and have the request 422 with nothing on screen to fix.
 */
function asDate(v: unknown): string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''
}

function asPreset(v: unknown): DatePreset {
  return DATE_PRESETS.includes(v as DatePreset) ? (v as DatePreset) : 'month'
}

/** `YYYY-MM-DD` in local time — `toISOString` would shift the day east of UTC. */
function ymd(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** A window of `months` back from today, both ends inclusive. */
function trailingMonths(months: number): { month_from: string; month_to: string } {
  const today = new Date()
  const from = new Date(today)
  from.setMonth(from.getMonth() - months)
  return { month_from: ymd(from), month_to: ymd(today) }
}

function asBool(v: unknown): boolean | undefined {
  if (v === 'true' || v === true) return true
  if (v === 'false' || v === false) return false
  return undefined
}

export function useExpenseListState(defaults?: {
  status?: RecordStatus[]
  pageSize?: number
}) {
  const navigate = useNavigate()
  const raw = useSearch({ strict: false }) as RawSearch

  const state: ExpenseListState = useMemo(() => {
    const monthRaw = raw.month
    const statuses = asStatusList(raw.status)
    return {
      month: isValidMonthKey(monthRaw) ? monthRaw : currentMonthKey(),
      view: raw.view === 'calendar' ? 'calendar' : 'list',
      page: Number(raw.page) > 0 ? Number(raw.page) : 1,
      pageSize: Number(raw.size) > 0 ? Number(raw.size) : (defaults?.pageSize ?? 25),
      search: asString(raw.q),
      project: asString(raw.project),
      client: asString(raw.client),
      category: asString(raw.category),
      expenseType: asString(raw.type),
      reimbursable: asBool(raw.reimbursable),
      utilized: asBool(raw.utilized),
      // A URL with no status falls back to the surface's default, where the
      // surface has one. No surface defaults to a *stage* any more — that
      // filter does not exist — so most of them pass nothing and show the
      // whole month.
      status: statuses.length ? statuses : (defaults?.status ?? []),
      datePreset: asPreset(raw.dr),
      fromDate: asDate(raw.from),
      toDate: asDate(raw.to),
    }
    // `defaults` is a literal at every call site; depending on its identity
    // would rebuild this object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw])

  const patch = useCallback(
    (next: Partial<ExpenseListState>) => {
      navigate({
        to: '.',
        search: (prev: RawSearch) => {
          const merged: RawSearch = { ...prev }

          // Key *presence* decides intent, so passing `undefined` clears a
          // filter instead of being ignored. A `!== undefined` guard here
          // would make "All" unselectable on the reimbursable dropdown.
          for (const key of Object.keys(next) as (keyof ExpenseListState)[]) {
            const param = PARAM_KEYS[key]
            if (!param) continue
            const value = next[key]

            const isEmpty =
              value === undefined ||
              value === null ||
              value === '' ||
              (Array.isArray(value) && value.length === 0) ||
              // `list`, page 1 and the month window are the defaults; keep them
              // out of the URL.
              (key === 'view' && value === 'list') ||
              (key === 'page' && value === 1) ||
              (key === 'datePreset' && value === 'month')

            if (isEmpty) delete merged[param]
            else merged[param] = typeof value === 'boolean' ? String(value) : value
          }

          // Any change other than paging returns to page 1 — staying on page 4
          // of a filter that now has one page shows an empty table.
          const onlyPaging = Object.keys(next).every((k) => k === 'page')
          if (!onlyPaging) delete merged.page

          return merged
        },
        replace: true,
      })
    },
    [navigate],
  )

  /**
   * True when the date filter owns the window, so the month is not the scope.
   *
   * Exposed because a surface has to *say* so. Leaving the month stepper live
   * beside an active range gives the screen two controls for one window, only
   * one of which is doing anything.
   *
   * The calendar toggle no longer hangs off this: a month grid cannot draw an
   * arbitrary span, but hiding the toggle whenever the window is not a month
   * strands anyone who picked `all` or a custom range with no way back to the
   * grid. Surfaces snap the preset back to `month` when the calendar is opened
   * instead — see `MonthScopeBar`.
   *
   * A `custom` preset with a half-filled range is deliberately **not** overriding
   * anything: the list stays on the month until both ends are picked, so the
   * stepper stays live too.
   */
  const isCustomRange =
    state.datePreset === 'custom'
      ? Boolean(state.fromDate && state.toDate && state.fromDate <= state.toDate)
      : state.datePreset !== 'month'

  /** The `[month_from, month_to]` window every list and tile call sends. */
  const range = useMemo(() => {
    switch (state.datePreset) {
      case 'today':
        return trailingMonths(0)
      case 'last_month':
        return trailingMonths(1)
      case 'last_2_months':
        return trailingMonths(2)
      case 'all':
        return ALL_TIME
      case 'custom':
        return state.fromDate && state.toDate && state.fromDate <= state.toDate
          ? { month_from: state.fromDate, month_to: state.toDate }
          : monthRange(state.month)
      default:
        return monthRange(state.month)
    }
  }, [state.datePreset, state.fromDate, state.toDate, state.month])

  /**
   * The month window, whatever the range says.
   *
   * The calendar is a month grid — it cannot draw a span of arbitrary length —
   * so it keeps asking for a month while the list follows the range.
   */
  const monthWindow = useMemo(() => monthRange(state.month), [state.month])

  /** True when anything beyond the surface's own default is applied. */
  const hasActiveFilters = useMemo(
    () =>
      Boolean(
        state.search ||
          state.project ||
          state.client ||
          state.category ||
          state.expenseType ||
          state.reimbursable !== undefined ||
          state.utilized !== undefined ||
          state.datePreset !== 'month',
      ),
    [state],
  )

  const clearFilters = useCallback(() => {
    patch({
      search: '',
      project: '',
      client: '',
      category: '',
      expenseType: '',
      reimbursable: undefined,
      utilized: undefined,
      status: defaults?.status ?? [],
      datePreset: 'month',
      fromDate: '',
      toDate: '',
      page: 1,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch])

  return {
    state,
    patch,
    range,
    monthWindow,
    isCustomRange,
    hasActiveFilters,
    clearFilters,
  }
}
