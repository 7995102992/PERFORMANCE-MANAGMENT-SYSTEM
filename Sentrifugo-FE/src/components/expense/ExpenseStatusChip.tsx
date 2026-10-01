/**
 * The one status → chip mapping for the expense module (§6.2).
 *
 * Seven model statuses across three subjects, in one place. Three things this
 * must get right and a per-page mapping would eventually get wrong:
 *
 * - **DRAFT reads as "Saved".** The UI says Saved, the model says DRAFT.
 * - **Approved and Settled look different.** "Approved but unpaid" versus
 *   "paid" is the distinction Finance runs the function on (§18.1 D); rendering
 *   them alike is the bug the missing Settled tile already caused once.
 * - **The pending text comes from the server, not from here.** There is one
 *   `PENDING_APPROVAL` status now; *which* rung is open is data on the record.
 *   Rows and details carry `status_label`, already composed server-side out of
 *   the org's own rung names, so pass it in and we render it. The rung names
 *   belong to the org — the client has no vocabulary to compose them from and
 *   must never invent stage wording of its own.
 */
import {
  Check,
  CircleCheck,
  CircleDollarSign,
  ClipboardCheck,
  CircleX,
  Clock,
  History,
  Lock,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { statusLabel } from '@/lib/expense-utils'
import type { RecordStatus } from '@/types/expense'

type ChipSpec = {
  icon: ComponentType<{ className?: string }>
  /** Token class, never a raw Tailwind colour utility (CLAUDE.md §1). */
  tone: string
}

const SPEC: Record<RecordStatus, ChipSpec> = {
  DRAFT: { icon: Check, tone: 'text-badge-draft-text' },
  PENDING_APPROVAL: { icon: Clock, tone: 'text-badge-pending-text' },
  // Waiting on people, like PENDING_APPROVAL, so it wears the same tone — the
  // employee is waiting either way and does not care which mechanism has it.
  // The icon differs because the *action* differs: this one is being ticked off
  // a trip's table, not signed at a rung.
  PENDING_VERIFICATION: { icon: ClipboardCheck, tone: 'text-badge-pending-text' },
  APPROVED: { icon: CircleCheck, tone: 'text-success' },
  REJECTED: { icon: CircleX, tone: 'text-destructive' },
  SETTLED: { icon: CircleDollarSign, tone: 'text-info' },
  ACTIVE: { icon: History, tone: 'text-success' },
  CLOSED: { icon: Lock, tone: 'text-muted-foreground' },
}

interface Props {
  status: RecordStatus
  /**
   * The record's `status_label` — server-composed, e.g. "Pending — Leadership".
   * Preferred over anything derived here, so the list and the detail cannot
   * disagree about what a record is waiting on.
   */
  label?: string | null
  /**
   * The record's `current_level_names`, used only when no `status_label` came
   * with it (an older payload, or a shape that carries the rungs but not the
   * composed text). Still the org's words — we join them, never author them.
   */
  levelNames?: string[]
  /** `inline` for table cells, `badge` for detail headers. */
  variant?: 'inline' | 'badge'
  className?: string
}

export function ExpenseStatusChip({
  status,
  label,
  levelNames,
  variant = 'inline',
  className,
}: Props) {
  const spec = SPEC[status]
  if (!spec) {
    // A status the client has not been taught about degrades to plain text
    // rather than crashing or guessing a colour.
    return <span className="text-sm text-muted-foreground">{label || status}</span>
  }

  const Icon = spec.icon
  const text = label?.trim() || statusLabel(status, levelNames)

  if (variant === 'badge') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
          spec.tone,
          className,
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        {text}
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sm', className)}
    >
      <Icon className={cn('size-3.5 shrink-0', spec.tone)} />
      {text}
    </span>
  )
}
