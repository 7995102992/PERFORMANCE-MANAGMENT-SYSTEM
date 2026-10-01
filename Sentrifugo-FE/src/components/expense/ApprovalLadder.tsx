/**
 * The approval ladder — one rung per level, one row per verdict.
 *
 * **One component, three subjects.** Expenses, trips and advances all carry the
 * same `ApprovalBlockResponse`, and until this file existed they each carried
 * their own byte-identical copy of this renderer alongside their own
 * `DECISION_LABEL` map under a different name. Three copies of the thing that
 * shows who signed off on company money is three places for them to disagree.
 *
 * What it has to get right:
 *
 * - **A rung's name comes from the record, never from the live chain.** The
 *   verdict's own `level_name` was frozen when it was given, so an admin
 *   renaming "Finance" to "Controllers" cannot rewrite what an approver was told
 *   they were signing. Only a rung nobody has signed yet falls back to the
 *   chain snapshot's name.
 * - **A rung can hold several verdicts.** Under `quorum: 'all'` every eligible
 *   approver signs; a renderer assuming one record per stage would show the
 *   first and hide the rest.
 * - **Skipped rungs are drawn, not omitted.** An `optional` rung the level below
 *   chose not to escalate to is part of the configuration; a rung that vanishes
 *   reads as a chain that never had it.
 * - **Rungs the record has not reached are not drawn at all.** This is a record
 *   of what has happened to *this* claim, not a preview of the org's policy. A
 *   rung nobody has been asked about has no state to report, and inventing one
 *   is how this screen came to announce "Leadership Approval — Skipped" on a
 *   claim its reporting manager had not yet opened. The chain's shape is on the
 *   settings page, and its intended route is in the `chain.summary` line above.
 * - **Verdicts at rungs the chain no longer lists are still shown.** The trail is
 *   append-only, so a level removed after a record was decided under it appears
 *   at the end rather than disappearing.
 */
import {
  AlertTriangle,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  CornerUpLeft,
  Undo2,
} from 'lucide-react'
import { formatDateTime } from '@/lib/expense-utils'
import { cn } from '@/lib/utils'
import type {
  ActorSnapshot,
  ApprovalBlockResponse,
  DecisionResponse,
  GateDecision,
  LevelState,
} from '@/types/expense'

const DECISION_LABEL: Record<GateDecision, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SENT_BACK: 'Sent back',
  // Stored as RECALLED; shown as what the claimant actually did.
  RECALLED: 'Withdrawn',
}

/** Tone per verdict, kept beside the wording so the two cannot drift. */
const DECISION_TONE: Record<GateDecision, string> = {
  APPROVED: 'text-success',
  REJECTED: 'text-destructive',
  SENT_BACK: 'text-warning',
  RECALLED: 'text-muted-foreground',
}

export function ApprovalLadder({
  approval,
  actorLabel,
}: {
  approval: ApprovalBlockResponse
  actorLabel: (actor?: ActorSnapshot | null) => string
}) {
  const allRungs = [...approval.levels].sort((a, b) => a.level - b.level)

  /** Verdicts grouped by the rung they were given at, in the order given. */
  const byLevel = new Map<number, DecisionResponse[]>()
  for (const d of approval.decisions) {
    const at = byLevel.get(d.level)
    if (at) at.push(d)
    else byLevel.set(d.level, [d])
  }

  /**
   * The rungs this claim has actually reached.
   *
   * Four ways in, and they are exhaustive because they are the four ways a rung
   * can have an outcome: somebody voted at it, it is open now, it cleared, or the
   * chain moved past it without using it. Anything else is a rung ahead of the
   * record, and the four flags are all false there — which is precisely the state
   * `rungState` used to render as the words "Not yet reached".
   *
   * The server settles `skipped` and `cleared`; this does not second-guess them.
   * An unused `optional` rung only earns those flags once the chain has moved past
   * it (`evaluate`'s final pass), so a Leadership level nobody has been offered
   * yet simply is not in this list.
   */
  const rungs = allRungs.filter(
    (rung) =>
      (byLevel.get(rung.level)?.length ?? 0) > 0 ||
      rung.awaiting ||
      rung.cleared ||
      rung.skipped,
  )

  /**
   * Verdicts against a rung the chain no longer lists — a recall, or a level the
   * org removed after this record had already been decided under it. The trail
   * is append-only, so they are shown at the end rather than quietly dropped.
   */
  const strays = approval.decisions.filter(
    (d) => !allRungs.some((r) => r.level === d.level),
  )

  /** The chain frozen at submit, for the name of a rung nobody has signed yet. */
  const frozenName = (level: number) =>
    approval.chain?.levels.find((l) => l.level === level)?.name

  return (
    <div className="mt-6 rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-muted-foreground">Approval</p>
        {/* Composed server-side so the record and the settings page can never
            disagree about what the saved chain means. Rendered, never derived. */}
        {approval.chain?.summary && (
          <p className="text-xs text-muted-foreground">{approval.chain.summary}</p>
        )}
      </div>

      {/* Why the chain cannot move — an empty rung, say. The server states it in
          the admin's own terms; the client never invents its own diagnosis. */}
      {approval.blocked_reason && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>{approval.blocked_reason}</span>
        </p>
      )}

      {/* `null` is not an empty chain: it means no policy was captured at submit,
          which the server treats as unapprovable rather than approved on arrival.
          Saying so beats drawing a bare ladder that reads as merely unstarted. */}
      {!approval.chain && (
        <p className="text-sm text-muted-foreground">
          No approval policy was captured when this was submitted, so there is no
          chain to run.
        </p>
      )}

      {approval.chain?.approval_required === false && (
        <p className="text-sm text-muted-foreground">
          This org requires no approval for these records — submitting one
          approves it.
        </p>
      )}

      {/* A chain exists and is approvable, but nothing has reached a rung yet —
          every rung filtered out and no stray verdicts. Say so, because an empty
          ol under a heading reads as a screen that failed to load. */}
      {approval.chain &&
        approval.chain.approval_required !== false &&
        rungs.length === 0 &&
        strays.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No approval step has been reached yet.
          </p>
        )}

      <ol className="space-y-3">
        {rungs.map((rung) => {
          const decisions = byLevel.get(rung.level) ?? []
          const state = rungState(rung, decisions)
          // The snapshot wins: what the rung was called when it was signed.
          const title =
            decisions[0]?.level_name ?? frozenName(rung.level) ?? rung.name

          return (
            <li key={rung.level} className="flex gap-3">
              <state.Icon
                className={cn('mt-0.5 size-4 shrink-0', state.tone)}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {title}
                  <span className={cn('ml-2 text-xs font-normal', state.tone)}>
                    {state.label}
                  </span>
                </p>

                {/* Everyone signs, so several verdicts at one rung is normal here
                    rather than a duplicate. */}
                {rung.quorum === 'all' && !rung.skipped && (
                  <p className="text-xs text-muted-foreground">
                    Every approver at this level must sign.
                  </p>
                )}

                {rung.skipped && (
                  <p className="text-xs text-muted-foreground">
                    Optional level — the level below closed the chain rather than
                    opening this one.
                  </p>
                )}

                {approval.escalated_to.includes(rung.level) && (
                  <p className="text-xs text-muted-foreground">
                    Opened by the level below.
                  </p>
                )}

                {/* A count, never a roster: the block deliberately does not name
                    who may still sign. `0` is not reported as a finding — the
                    server states an unclearable rung in `blocked_reason`, in the
                    admin's own terms, and a bare "0 approvers" from the client
                    would be a second, worse version of that judgement. */}
                {rung.awaiting && rung.eligible_count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {rung.eligible_count} eligible{' '}
                    {rung.eligible_count === 1 ? 'approver' : 'approvers'}
                  </p>
                )}

                {rung.blocked_reason && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span>{rung.blocked_reason}</span>
                  </p>
                )}

                {decisions.map((d, i) => (
                  <Verdict
                    key={`${d.actor.id}-${d.at ?? i}`}
                    decision={d}
                    actorLabel={actorLabel}
                  />
                ))}
              </div>
            </li>
          )
        })}

        {strays.map((d, i) => (
          <li key={`stray-${d.actor.id}-${d.at ?? i}`} className="flex gap-3">
            <Undo2
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{d.level_name}</p>
              <Verdict decision={d} actorLabel={actorLabel} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** One person's verdict at one rung, with any note they left with it. */
function Verdict({
  decision,
  actorLabel,
}: {
  decision: DecisionResponse
  actorLabel: (actor?: ActorSnapshot | null) => string
}) {
  return (
    <div className="mt-1.5">
      <p className="text-sm text-foreground">
        <span className={DECISION_TONE[decision.decision]}>
          {DECISION_LABEL[decision.decision]}
        </span>{' '}
        by {actorLabel(decision.actor)}
        {decision.at && (
          <span className="text-muted-foreground">
            {' · '}
            {formatDateTime(decision.at)}
          </span>
        )}
      </p>
      {decision.note && (
        <p className="mt-1 rounded-md bg-muted/50 px-2 py-1 text-xs text-foreground">
          {decision.note}
        </p>
      )}
    </div>
  )
}

/**
 * Where one rung stands, as an icon, a tone and a word.
 *
 * A rejection is read off the rung's own verdicts rather than off the record's
 * status, because only the rung that actually refused should read as refused —
 * the rungs behind a rejection were never reached, and `cleared` / `awaiting`
 * are both false for them, which is exactly "not yet reached".
 *
 * That final case no longer renders: a rung in it is filtered out before this is
 * called. It is kept as the fallback because it is the honest answer for any
 * flag combination that reaches here without one of the five outcomes above.
 */
function rungState(rung: LevelState, decisions: DecisionResponse[]) {
  if (decisions.some((d) => d.decision === 'REJECTED')) {
    return { label: 'Rejected', tone: 'text-destructive', Icon: CircleX }
  }
  if (rung.skipped) {
    return { label: 'Skipped', tone: 'text-muted-foreground', Icon: CircleSlash }
  }
  if (rung.cleared) {
    return { label: 'Cleared', tone: 'text-success', Icon: CircleCheck }
  }
  if (rung.awaiting) {
    return { label: 'Awaiting approval', tone: 'text-primary', Icon: Clock }
  }
  if (decisions.some((d) => d.decision === 'SENT_BACK')) {
    return { label: 'Sent back', tone: 'text-warning', Icon: CornerUpLeft }
  }
  return { label: 'Not yet reached', tone: 'text-muted-foreground', Icon: Circle }
}
