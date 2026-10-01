/**
 * The record's business timeline (§11.2) — the right-hand rail on every detail
 * surface, for all three subjects.
 *
 * **The server composes the chain, not the client.** `GET /history/…` returns
 * stored milestones followed by the hollow *pending* dots derived from the gate
 * chain ahead of the current position. Two things follow:
 *
 * - **A record whose chain collapsed shows no third dot at all** — not a greyed
 *   one (§5.3, §11.2). The server omits it; do not helpfully add it back.
 * - **Labels are already the display wording** — *Approval (Level 1)* for L1,
 *   *Approval (Level 2)* for Finance, *Management Approval* for L2. The stored
 *   event codes stay role-named so renaming a gate never rewrites history; the
 *   mapping happens server-side. Do not re-derive labels from `event_code`.
 *
 * This is not the audit log and not the comment thread. History is milestones
 * the system wrote; comments are prose people wrote (§11.4).
 */
import { cn } from '@/lib/utils'
import { formatDateTime, formatMoney } from '@/lib/expense-utils'
import { useGetTimelineQuery } from '@/store/api/expenseApi'
import type { SubjectType, TimelineEntry } from '@/types/expense'

/**
 * The chain's own progress: submitted, each rung's outcome, where it sits now.
 *
 * Everything outside this set is what happens to the *money* once the chain has
 * finished with it — settlement, disbursement, return, allocation — plus the
 * amount adjustment an approver made on the way. An approver at a rung is being
 * asked one question, and none of that answers it.
 *
 * `AMOUNT_ADJUSTED` is the borderline one and is treated as detail rather than
 * milestone: the figure the next approver is signing for is on the record in
 * front of them, so the history of how it got there is context, not the ask.
 */
const CHAIN_MILESTONES = new Set([
  'CREATED',
  'SUBMITTED',
  'LEVEL_APPROVED',
  'LEVEL_VOTE_RECORDED',
  'ESCALATED',
  'REJECTED',
  'SENT_BACK',
  'RECALLED',
])

interface Props {
  subjectType: SubjectType
  subjectId: string
  title?: string
  /**
   * Drop everything that is not chain progress — see `CHAIN_MILESTONES`.
   *
   * **Presentation, not confidentiality.** The full timeline is still fetched
   * and still in the page's memory; this decides what is worth an approver's
   * attention, not what they are permitted to know. Anything that genuinely must
   * not reach a caller has to be withheld by the server, and this is not that.
   */
  milestonesOnly?: boolean
  /**
   * Merged onto the card, for the surface to place it.
   *
   * The rail is a card here and a `border-l` column inside a sheet on the
   * service-request side; where it sits and how it scrolls is the page's
   * business, not this component's.
   */
  className?: string
}

export function ApprovalTimeline({
  subjectType,
  subjectId,
  title = 'Expense Timeline',
  milestonesOnly = false,
  className,
}: Props) {
  const { data, isLoading } = useGetTimelineQuery({ subjectType, subjectId })

  const all = data?.entries ?? []
  // Filtered before `currentIndex` is worked out, or the "you are here" dot
  // would point at a row that is no longer rendered. An entry with no
  // `event_code` is a derived pending rung ahead of the record, which is chain
  // progress by definition.
  const entries = milestonesOnly
    ? all.filter((e) => !e.event_code || CHAIN_MILESTONES.has(e.event_code))
    : all
  // The first pending entry is where the record currently sits; everything
  // after it is further ahead in the chain.
  const currentIndex = entries.findIndex((e) => e.state === 'pending')

  return (
    <div className={cn('rounded-xl border bg-card px-5 py-4', className)}>
      <h3 className="mb-5 text-sm font-semibold text-foreground">{title}</h3>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/50" />
          ))}
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
      )}

      {/* One continuous rail behind the whole list rather than a segment per
          row, which is how the service-request ticket timeline draws it. Inset
          top and bottom so the line starts and ends at the first and last dot
          instead of running past them. */}
      {entries.length > 0 && (
        <ol className="relative ml-2 space-y-5">
          <span
            className="absolute left-[3px] bottom-2 top-2 w-px bg-border"
            aria-hidden
          />
          {entries.map((entry, i) => (
            <TimelineRow
              key={`${entry.event_code ?? entry.label}-${i}`}
              entry={entry}
              isCurrent={i === currentIndex}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function TimelineRow({ entry, isCurrent }: { entry: TimelineEntry; isCurrent: boolean }) {
  const done = entry.state === 'done'
  // A refusal reads red on the service-request rail, and the same distinction is
  // worth as much here — "this stopped" and "this is still going" should not be
  // the same colour. Derived from the entry the row already has; nothing new is
  // fetched or decided.
  const rejected = entry.event_code === 'REJECTED'
  const adjustment = adjustmentOf(entry)

  return (
    <li className="relative pl-5">
      <span
        className={cn(
          'absolute left-0 top-[3px] size-[7px] rounded-full ring-2 ring-background',
          rejected ? 'bg-destructive' : done ? 'bg-success' : isCurrent ? 'bg-primary' : 'bg-border',
        )}
        aria-hidden
      />

      <p
        className={cn(
          'text-xs font-semibold',
          rejected
            ? 'text-destructive'
            : done || isCurrent
              ? 'text-foreground'
              : 'text-muted-foreground',
        )}
      >
        {entry.label}
        {entry.optional && !done && (
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
            (optional)
          </span>
        )}
      </p>

      <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitleFor(entry)}</p>

      {/* Finance lowering the figure is stated on its own line rather than folded
          into the subtitle above. It rides on the *approval* entry server-side
          (§18: the reduction is part of that decision, not a milestone of its
          own), which is right for the record — but it left the timeline reading
          "Approved" with nothing to say the number had moved, and the amount is
          the thing the claimant is going to ask about. */}
      {adjustment && (
        <p className="mt-0.5 text-[11px] text-warning">
          Reduced {adjustment.from} → {adjustment.to}
          {adjustment.reason ? ` · ${adjustment.reason}` : ''}
        </p>
      )}

      {entry.note && (
        <p
          className={cn(
            'mt-0.5 text-[11px]',
            rejected ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {entry.note}
        </p>
      )}

      {entry.at && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {formatDateTime(entry.at)}
        </p>
      )}
    </li>
  )
}

/**
 * The amount change carried on an approval, when there was one.
 *
 * ``_apply_adjustment`` stamps ``amount_adjusted`` alongside the figures it moved
 * from and to, so this reads the entry it is already rendering rather than
 * fetching anything. ``previous_approved_amount`` is the honest "from": on a
 * second adjustment the claimed amount is no longer what changed.
 *
 * Everything is read defensively — an older history row predates these keys, and
 * a partial one must render nothing rather than "Reduced — → —".
 */
function adjustmentOf(entry: TimelineEntry): { from: string; to: string; reason: string } | null {
  const meta = entry.metadata ?? {}
  if (meta.amount_adjusted !== true) return null

  const before = meta.previous_approved_amount ?? meta.claimed_amount
  const after = meta.approved_amount
  if (typeof before !== 'string' || typeof after !== 'string') return null

  return {
    from: formatMoney(before),
    to: formatMoney(after),
    reason: typeof meta.adjustment_reason === 'string' ? meta.adjustment_reason : '',
  }
}

/**
 * The subtitle carries the decision and the actor, both from the entry's own
 * snapshot — which is why `actor_name` is stored rather than joined at read
 * time: the timeline must still read correctly after someone leaves.
 */
function subtitleFor(entry: TimelineEntry): string {
  if (entry.state === 'pending') {
    return entry.actor_name ? `Pending — ${entry.actor_name}` : 'Pending'
  }

  const parts: string[] = []

  if (entry.event_code === 'ESCALATED') {
    // An escalation targets a *rung*, not a person — the holders are resolved
    // live and there may be several, so there is no single name to render here.
    // `level_name` is the org's own word for it, frozen when the entry was
    // written, so a later rename cannot rewrite history.
    const rung = (entry.metadata?.level_name as string | undefined) ?? entry.level_name
    parts.push(`Status: Escalated${rung ? ` to ${rung}` : ''}`)
  } else if (entry.to_status) {
    parts.push(`Status: ${decisionWord(entry)}`)
  }

  if (entry.actor_name) parts.push(`By: ${entry.actor_name}`)
  return parts.join(', ') || '—'
}

function decisionWord(entry: TimelineEntry): string {
  switch (entry.event_code) {
    case 'LEVEL_APPROVED':
      return 'Approved'
    // One signature in on a rung that still needs others (`quorum: 'all'`). The
    // record has not moved, so calling this "Approved" would report the claim as
    // decided while the remaining approvers were still holding it.
    case 'LEVEL_VOTE_RECORDED': {
      const signed = entry.metadata?.signed_count
      const required = entry.metadata?.required_count
      return typeof signed === 'number' && typeof required === 'number'
        ? `Signed (${signed} of ${required})`
        : 'Signed'
    }
    case 'ESCALATED':
      return 'Escalated'
    case 'REJECTED':
      return 'Rejected'
    case 'SENT_BACK':
      return 'Sent back'
    case 'RECALLED':
      // The stored code stays RECALLED — it is on every existing history row.
      // What the claimant did is withdraw, and that is what the trail should say.
      return 'Withdrawn'
    case 'SETTLED':
      return 'Settled'
    case 'DISBURSED':
      return 'Disbursed'
    case 'RETURNED':
      return 'Returned'
    case 'CLOSED':
      return 'Closed'
    case 'SUBMITTED':
      return 'Submitted'
    case 'CREATED':
      return 'Created'
    default:
      return entry.to_status ?? '—'
  }
}
