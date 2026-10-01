import { TripList } from '@/pages/expenses/TripList'

/**
 * The trips of the people who report to this caller — and only those.
 *
 * This was the reporting line unioned with whatever was open at a level the
 * caller could sign, so the page named a different row set depending on which
 * grant you held. The queue half is `AwaitingTripApproval`.
 */
export function TeamTrips() {
  return (
    <TripList
      scope="team"
      title="Team Trips"
      subtitle="Trips raised by the people who report to you"
    />
  )
}

export default TeamTrips
