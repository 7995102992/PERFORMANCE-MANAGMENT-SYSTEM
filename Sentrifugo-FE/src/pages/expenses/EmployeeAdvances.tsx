import { AdvanceListView } from '@/components/expense/AdvanceListView'
import { useApproverScope } from '@/hooks/use-approver-scope'

/**
 * The two headings this page can wear, hoisted because they are now needed
 * twice: once to name the page for whoever opened it, and once more for the
 * `alt*` props, which re-state the queue heading for the card the page opens on.
 */
const QUEUE_TITLE = 'Advance Approvals'
const QUEUE_SUBTITLE = 'Advance requests at a level you approve, waiting on your decision'
const ORG_SUBTITLE = 'Review, approve and disburse advances across the organisation'

/**
 * Finance's org-wide advance pipeline — and Leadership's advance approvals.
 *
 * The counterpart to `EmployeeTrips`, and the same gap: `AdvanceScope.ORG` was
 * implemented and unreachable, so the money Finance settles claims against had
 * no org-wide view of its own.
 *
 * Distinct from `TeamAdvances`, which stays the allocator's screen — the
 * reporting line plus advances the caller disbursed or was nominated on. Those
 * are personal involvement with one record; this is the whole pipeline, or the
 * caller's queue within it.
 */
export function EmployeeAdvances() {
  const { isOrgWide, scopeFor, titleFor } = useApproverScope()

  return (
    <AdvanceListView
      scope={scopeFor('org', 'approvals')}
      // Finance only — Leadership is served the approvals scope outright.
      altScope={isOrgWide ? 'approvals' : undefined}
      title={titleFor('Employee Advances', QUEUE_TITLE)}
      subtitle={isOrgWide ? ORG_SUBTITLE : QUEUE_SUBTITLE}
      altTitle={QUEUE_TITLE}
      altSubtitle={QUEUE_SUBTITLE}
    />
  )
}

export default EmployeeAdvances
