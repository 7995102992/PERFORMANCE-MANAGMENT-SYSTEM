import { ExpenseListView } from '@/components/expense/ExpenseListView'

/**
 * The claims of the people who report to this caller — and only those.
 *
 * This list used to be a union: the reporting line *plus* anything open at a
 * level the caller could sign. That made "my team" mean something different
 * depending on which grant you held, and put a stranger's claim in front of
 * Finance the moment the claimant's own manager had signed it. The queue half
 * moved to `AwaitingApproval`; the org-wide view was always `EmployeeExpenses`.
 *
 * The line is read from each record's *snapshot* — whoever was the claimant's
 * manager when they submitted — so a re-org never moves history between two
 * managers' screens. Rows stay here at every level the claim reaches, which is
 * what lets a manager follow their people's claims past their own signature.
 */
export function TeamExpenses() {
  return (
    <ExpenseListView
      scope="team"
      title="Team Expenses"
      subtitle="Claims raised by the people who report to you"
    />
  )
}

export default TeamExpenses
