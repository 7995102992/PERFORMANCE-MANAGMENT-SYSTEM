/**
 * Where a request will go, before there is a record to ask.
 *
 * `ApprovalLadder` draws the chain **snapshotted onto a record** and is right to:
 * once something is submitted, who approves it is a fact about that record and
 * must not move when an admin edits the settings page. But it needs a snapshot,
 * and a draft has none — `approval.chain` is null until submit — so every sheet
 * gates it on `status !== 'DRAFT'` and shows nothing at all beforehand.
 *
 * That was survivable while the request form carried approver pickers: the
 * requester chose the destination, so they knew it. The ladder comes from
 * settings now, and removing the pickers removed the only place it was ever
 * stated — leaving people to commit an advance without being told where it went.
 *
 * This is the other half: the org's *live* chain, resolved for **this caller**,
 * from `GET /advances/approver-candidates`. A preview, never a promise — the
 * holders are resolved when it is read, so the answer can differ by the time the
 * thing is submitted. That is the same live resolution every approver surface in
 * the module does, and the reason none of them stores one.
 */
import { AlertTriangle, ArrowRight } from 'lucide-react'
import type { ApprovalPreviewLevel } from '@/types/expense'

interface Props {
  levels?: ApprovalPreviewLevel[]
  /** The org's chain asks for no approval at all — a different thing from empty. */
  approvalRequired?: boolean
  /** The candidates query is still in flight. */
  loading?: boolean
  /** Wording for the sentence above the rungs; the detail sheet phrases it in the past. */
  heading?: string
}

export function ApprovalRoutePreview({
  levels,
  approvalRequired = true,
  loading = false,
  heading = 'This request will go to',
}: Props) {
  if (loading) {
    return (
      <div className="mt-6 rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground">Working out who approves this…</p>
      </div>
    )
  }

  // Reassurance, not a warning. An org that requires no approval is configured,
  // not broken, and an empty list would otherwise read as the failure below.
  if (!approvalRequired) {
    return (
      <div className="mt-6 rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground">Approval</p>
        <p className="mt-2 text-sm text-foreground">
          Your organisation does not require approval for advance requests. This
          goes straight through.
        </p>
      </div>
    )
  }

  // Approval *is* required and we could not say by whom — the directory was
  // silent. Says so rather than drawing an empty route, which would read as
  // "nobody has to approve this" and is the opposite of the truth.
  if (!levels?.length) {
    return (
      <div className="mt-6 rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground">Approval</p>
        <p className="mt-2 flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            We could not work out who approves this right now. You can still send
            it — the approvers are resolved again when it is submitted.
          </span>
        </p>
      </div>
    )
  }

  return (
    <div className="mt-6 rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{heading}</p>
      <ol className="mt-3 space-y-2.5">
        {levels.map((rung) => (
          <li key={rung.level} className="flex items-start gap-2.5">
            <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm text-foreground">
                {rung.name}
                {/* A rung the chain may never reach must not read as certain: the
                    level below can end the chain instead of passing it up. */}
                {rung.optional && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    (only if escalated)
                  </span>
                )}
              </p>
              {rung.approvers.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {rung.approvers.map((a) => a.name || a.id).join(', ')}
                </p>
              ) : (
                /* The most useful thing this component can say. A configured but
                   unheld rung jams the request the moment it arrives, and the
                   person who can fix it is not the one about to submit — so they
                   need to know now, not in three days. */
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  Nobody currently holds this level — it will hold the request up.
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
