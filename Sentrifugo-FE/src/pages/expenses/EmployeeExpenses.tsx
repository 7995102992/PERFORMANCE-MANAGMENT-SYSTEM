import { useState } from 'react'
import { ExpenseListView } from '@/components/expense/ExpenseListView'
import { ExpenseFormSheet } from '@/components/expense/ExpenseFormSheet'
import { useApproverScope } from '@/hooks/use-approver-scope'

/**
 * The two headings this page can wear, hoisted because they are now needed
 * twice: once to name the page for whoever opened it, and once more for the
 * `alt*` props, which re-state the queue heading for the card the page opens on.
 */
const QUEUE_TITLE = 'Expense Approvals'
const QUEUE_SUBTITLE = 'Claims at a level you approve, waiting on your decision'
const ORG_SUBTITLE = 'Verify, approve and settle claims across the organisation'

/**
 * Finance's org-wide pipeline — and, for an approver without the org-wide read
 * grant, the same page showing the records waiting on them. See
 * `useApproverScope`: Leadership approves these claims but holds
 * `view_expense_claims` on no policy, and giving their queue its own nav entry
 * bought a third page for a row set this one already renders.
 *
 * It opens on the **whole month** rather than on a pre-filtered slice. The old
 * default was the status that named Finance's own gate, and under a
 * configurable ladder there is no such status to default to: Finance may sit at
 * level 2, at level 4, or nowhere at all, and the one `PENDING_APPROVAL` status
 * cannot say which. Defaulting to it would just hide APPROVED and SETTLED rows
 * behind a filter that no longer narrows anything useful.
 *
 * "Waiting on me" is `actor_levels.length > 0` on the row — a per-record fact
 * the server computes for the caller — so it belongs in the list's own sorting
 * and scope column, not in a status filter. See `isAwaitingActor()` in
 * `expense-utils`.
 *
 * Drafts never appear — they are private to their owner until submitted, which
 * is why this scope gets the manager's tile set plus Settled and no "Saved"
 * tile (§12.2 correction 11).
 */
export function EmployeeExpenses() {
  const [formOpen, setFormOpen] = useState(false)
  const { isOrgWide, scopeFor, titleFor } = useApproverScope()

  return (
    <>
      <ExpenseListView
        scope={scopeFor('employees', 'approvals')}
        // Only Finance is offered the switch. Leadership is served the approvals
        // scope outright, so there is no second population to toggle to.
        altScope={isOrgWide ? 'approvals' : undefined}
        title={titleFor('Employee Expenses', QUEUE_TITLE)}
        subtitle={isOrgWide ? ORG_SUBTITLE : QUEUE_SUBTITLE}
        altTitle={QUEUE_TITLE}
        altSubtitle={QUEUE_SUBTITLE}
        onCreate={() => setFormOpen(true)}
      />
      <ExpenseFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        expenseId={null}
      />
    </>
  )
}

export default EmployeeExpenses
