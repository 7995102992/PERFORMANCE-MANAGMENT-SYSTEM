/**
 * Expense module helpers — money, months and status vocabulary.
 *
 * Money crosses the wire as a decimal string (Pydantic `Decimal`). Everything
 * here keeps it a string: `parseFloat` on "12000.50" then re-serialising gives
 * back "12000.5", which is a different amount as far as the ledger is concerned.
 */
import type { RecordStatus } from '@/types/expense'
import { formatOrgDate, formatOrgDateTime } from '@/lib/utils'

// ─── Money ───────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
}

export function currencySymbol(currency?: string | null): string {
  if (!currency) return ''
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `
}

/**
 * Format a decimal string for display.
 *
 * Grouping is applied to the integer part by string manipulation, so no
 * float ever touches the value. A null or blank amount renders as an em dash
 * rather than "₹0.00" — "not set" and "zero" are different facts, and a zero
 * net payable is a legitimate outcome we must not confuse with a missing one.
 */
export function formatMoney(
  amount?: string | number | null,
  currency = 'INR',
  options: { showZero?: boolean; decimals?: boolean } = {},
): string {
  const { showZero = true, decimals = true } = options
  if (amount === null || amount === undefined || amount === '') return '—'

  const raw = String(amount).trim()
  if (!raw) return '—'

  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [intPartRaw = '0', fracPartRaw = ''] = unsigned.split('.')

  if (!showZero && Number(unsigned) === 0) return '—'

  // Indian grouping for INR (last 3, then pairs); Western grouping otherwise.
  const grouped =
    currency === 'INR' ? groupIndian(intPartRaw) : groupWestern(intPartRaw)

  const frac = decimals ? `.${(fracPartRaw + '00').slice(0, 2)}` : ''

  return `${negative ? '-' : ''}${currencySymbol(currency)}${grouped}${frac}`
}

function groupIndian(int: string): string {
  const clean = int.replace(/^0+(?=\d)/, '')
  if (clean.length <= 3) return clean
  const last3 = clean.slice(-3)
  const rest = clean.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

function groupWestern(int: string): string {
  return int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Compare two decimal strings without going through a float. */
export function compareDecimal(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return 0
  return na < nb ? -1 : na > nb ? 1 : 0
}

export function isZeroAmount(amount?: string | null): boolean {
  if (amount === null || amount === undefined || amount === '') return false
  return Number(amount) === 0
}

// ─── Months (§12.1) ──────────────────────────────────────────────────────────

/** `2026-07` — the URL representation of the month scope. */
export type MonthKey = string

export function currentMonthKey(): MonthKey {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function isValidMonthKey(value: unknown): value is MonthKey {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/**
 * Expand a month key into the inclusive `[month_from, month_to]` the API takes.
 * The server never infers "current month" — every call sends the window (§12.1).
 */
export function monthRange(month: MonthKey): {
  month_from: string
  month_to: string
} {
  const [year, mon] = month.split('-').map(Number)
  const lastDay = new Date(year, mon, 0).getDate()
  return {
    month_from: `${month}-01`,
    month_to: `${month}-${String(lastDay).padStart(2, '0')}`,
  }
}

export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(year, mon - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function formatMonthLabel(month: MonthKey): string {
  const [year, mon] = month.split('-').map(Number)
  return new Date(year, mon - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/** "25-Aug-2026" in IST. */
export function formatDate(value?: string | null): string {
  return formatOrgDate(value, '—')
}

/** "25-Aug-2026, 4:00 PM" in IST. */
export function formatDateTime(value?: string | null): string {
  return formatOrgDateTime(value, '—')
}

/** `YYYY-MM-DD` for a date input / API date field. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

// ─── Status vocabulary (§6.2) ────────────────────────────────────────────────

/**
 * The UI says "Saved"; the model says DRAFT (§3 glossary). Approved and Settled
 * are deliberately distinct — "approved but unpaid" versus "paid" is the
 * distinction Finance runs the function on (§18.1 D).
 *
 * There is one pending entry *for the chain*. The three stage-named ones were
 * only writable
 * while the second rung was guaranteed to be Finance; a configurable ladder can
 * put Finance anywhere or nowhere, so the client no longer has the vocabulary
 * to name a stage. `PENDING_APPROVAL` therefore reads as a bare "Pending" here,
 * and anything that wants the rung names takes them from the record — either
 * its server-composed `status_label` or its `current_level_names`.
 */
export const STATUS_LABELS: Record<RecordStatus, string> = {
  DRAFT: 'Saved',
  PENDING_APPROVAL: 'Pending',
  // Not "Pending": the two are different waits and the employee can act on
  // exactly one of them. A record here is waiting to be *marked* off its trip,
  // and its claimant can still take it back — neither is true of the other.
  PENDING_VERIFICATION: 'Awaiting verification',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SETTLED: 'Settled',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
}

/**
 * Status values offered in the list filter, in lifecycle order.
 *
 * One pending option, not one per stage: the filter selects a *lifecycle*
 * position now, and "is this waiting on me?" is `actor_levels.length > 0` on
 * the row rather than a status anyone can filter on.
 */
export const EXPENSE_STATUS_FILTER: RecordStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SETTLED',
]

/** Finance and manager scopes never see another person's drafts. */
export const APPROVER_STATUS_FILTER: RecordStatus[] = EXPENSE_STATUS_FILTER.filter(
  (s) => s !== 'DRAFT',
)

export const TRIP_STATUS_FILTER: RecordStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CLOSED',
]

export const ADVANCE_STATUS_FILTER: RecordStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'REJECTED',
  'CLOSED',
]

/**
 * Display text for a status, optionally qualified by the record's open rungs.
 *
 * `levelNames` is `current_level_names` off the record — the org's own words,
 * snapshotted at submit. We join them and never author them, so an org that
 * calls its second rung "Leadership" reads "Pending — Leadership" and one that
 * calls it "Cost Centre Owner" reads that instead. Prefer the record's
 * server-composed `status_label` where the payload carries one; this is the
 * fallback for shapes that do not.
 */
export function statusLabel(
  status: RecordStatus,
  levelNames?: string[] | null,
): string {
  const base = STATUS_LABELS[status] ?? status
  if (status !== 'PENDING_APPROVAL') return base
  const names = (levelNames ?? []).map((n) => n?.trim()).filter(Boolean)
  return names.length ? `${base} — ${names.join(' / ')}` : base
}

/**
 * Is this record waiting on the caller right now?
 *
 * `actor_levels` is the intersection of the record's open rungs with the ones
 * the caller sits on, computed server-side per row. It is empty on a row the
 * caller merely owns, and it is the only honest answer to this question — no
 * status distinguishes "pending on me" from "pending on somebody else" any
 * more, and a role flag never could (a person can hold two rungs).
 */
export function isAwaitingActor(actorLevels?: number[] | null): boolean {
  return Boolean(actorLevels && actorLevels.length > 0)
}

/** Wording for the Team / Employee Expenses scope column (§5.2a). */
export function scopeLabel(scope: string, actorLevels?: number[] | null): string {
  if (isAwaitingActor(actorLevels)) return 'Awaiting my approval'
  if (scope === 'own') return 'Mine'
  // In the caller's approval reach, but the open rung is not one of theirs —
  // naming that rung here would put the org's vocabulary in the client.
  if (scope === 'approval') return 'Awaiting another approver'
  return '—'
}
