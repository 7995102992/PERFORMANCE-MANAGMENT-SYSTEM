import { AdvanceListView } from '@/components/expense/AdvanceListView'

/**
 * The caller's reporting line, plus the two advance-only reasons to be looking
 * at one record: money they disbursed, and requests that nominated them.
 *
 * Those two stay because this is also the allocator's screen — dropping
 * `disbursed_by` would take disbursement off the page that performs it — and
 * because both are the caller's own involvement with a specific advance rather
 * than somebody else's team. A nomination stays here rather than moving to the
 * queue: it is a proposal on the request form and confers no authority, so a
 * list meaning *waiting on you* would be lying. The queue half is
 * `AwaitingAdvanceApproval`.
 *
 * The extra column here is **Allotted To**: on this scope the rows belong to
 * other people.
 */
export function TeamAdvances() {
  return (
    <AdvanceListView
      scope="team"
      title="Team Advances"
      subtitle="Advances for your reporting line, plus the ones you allocated or were named on"
    />
  )
}

export default TeamAdvances
