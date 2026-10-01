import { TripList } from '@/pages/expenses/TripList'
import { useApproverScope } from '@/hooks/use-approver-scope'

/**
 * The two headings this page can wear, hoisted because they are now needed
 * twice: once to name the page for whoever opened it, and once more for the
 * `alt*` props, which re-state the queue heading for the card the page opens on.
 */
const QUEUE_TITLE = 'Trip Approvals'
const QUEUE_SUBTITLE = 'Trips at a level you approve, waiting on your decision'
const ORG_SUBTITLE = 'Review and approve business trips across the organisation'

/**
 * Finance's org-wide trip pipeline — and Leadership's trip approvals.
 *
 * One nav entry, one page structure, two row sets. Which one you get follows the
 * grant you hold rather than the URL you typed; see `useApproverScope`. Trips
 * had no org-wide page at all before this: `TripScope.ORG` existed on the server
 * and was reachable by nobody, so Finance could see a claim across the
 * organisation but not the trip it was booked against.
 */
export function EmployeeTrips() {
  const { isOrgWide, scopeFor, titleFor } = useApproverScope()

  return (
    <TripList
      scope={scopeFor('org', 'approvals')}
      // Finance only — Leadership is served the approvals scope outright.
      altScope={isOrgWide ? 'approvals' : undefined}
      title={titleFor('Employee Trips', QUEUE_TITLE)}
      subtitle={isOrgWide ? ORG_SUBTITLE : QUEUE_SUBTITLE}
      altTitle={QUEUE_TITLE}
      altSubtitle={QUEUE_SUBTITLE}
    />
  )
}

export default EmployeeTrips
