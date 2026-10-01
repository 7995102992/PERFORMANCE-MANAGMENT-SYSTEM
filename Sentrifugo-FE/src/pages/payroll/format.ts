import { MONTH_LABELS } from '@/types/payroll'
import { formatDateIST, formatDateTimeIST } from '@/lib/format-ist'

/** ISO-8601 UTC → "24 Jun 2026, 09:37", in IST. */
export const formatDateTime = (iso: string | null) => (iso ? formatDateTimeIST(iso) : '—')

/** ISO date → "12 May 1990" (date only, IST). Returns the raw value if unparseable. */
export const formatDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : formatDateIST(iso)
}

/** 1-12 + year → "June 2026". */
export const periodLabel = (month: number, year: number | string) =>
  `${MONTH_LABELS[month - 1]} ${year}`

/** 45000 → "₹45,000" (Indian grouping). */
export const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`

/** 12270.04 → "₹12,270.04" (Indian grouping, 2 decimals). */
export const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Show an amount, or "—" when it's zero/empty. */
export const amountOrDash = (n: number) => (n > 0 ? inr(n) : '—')

/** Read a label from a value that may be a plain string or a master-data object ({ value, key }). */
export const masterValue = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as { value?: unknown; key?: unknown }
    if (typeof o.value === 'string') return o.value
    if (typeof o.key === 'string') return o.key
  }
  return ''
}
