/**
 * Which row set an *Employee* page serves, decided by who is looking at it.
 *
 * **One page structure, two populations.** The three Employee pages — expenses,
 * trips, advances — are the org-wide lists Finance works from. Leadership
 * approves on the same records but holds `view_expense_claims` on no policy, so
 * before this they could not open those pages at all, and the queue was given
 * three nav entries of its own. That is three more pages to learn for a row set
 * the Employee page could already render.
 *
 * So the page stays one page and the *scope* follows the caller:
 *
 * | holds                  | sees                                    |
 * | ---------------------- | --------------------------------------- |
 * | `view_expense_claims`  | every submitted record in the org       |
 * | an approval grant only | the records waiting on them, and no more |
 *
 * **Nothing widens.** Both scopes are separate server routes with their own
 * gates, and this only chooses which to ask for. A caller without
 * `view_expense_claims` cannot reach the org-wide scope by editing the URL — the
 * server refuses it — and the queue scope is self-limiting: it matches only
 * levels the caller can actually sign. This hook is a convenience so nobody
 * meets a 403 they could not have predicted, not a security boundary.
 *
 * **Why the title moves with it.** Leadership reading "Employee Expenses" over
 * five rows would reasonably conclude the org had five claims. The heading has
 * to describe the rows that are actually there.
 */
import { useAuth } from '@/hooks/use-auth'
import { hasPermissionLevel } from '@/lib/permissions'

const MODULE = 'expense_management'

export interface ApproverScope {
  /** True when the caller holds the org-wide read grant. */
  isOrgWide: boolean
  /**
   * The scope to request.
   *
   * The two vocabularies differ — expenses call the org-wide set `employees`,
   * trips and advances call it `org` — so the caller passes the name its own
   * list component expects.
   */
  scopeFor: <T extends string>(orgWide: T, awaiting: T) => T
  /** Heading that matches the rows, not the nav entry. */
  titleFor: (orgWide: string, awaiting: string) => string
}

export function useApproverScope(): ApproverScope {
  const user = useAuth()
  // `viewer` rather than `editor`: this decides what may be *read*. Acting on a
  // record is gated per record by the engine, which is a stricter check and the
  // only one that can be correct once a level can name any grant.
  const isOrgWide = hasPermissionLevel(user, MODULE, 'view_expense_claims', 'viewer')

  return {
    isOrgWide,
    scopeFor: (orgWide, awaiting) => (isOrgWide ? orgWide : awaiting),
    titleFor: (orgWide, awaiting) => (isOrgWide ? orgWide : awaiting),
  }
}
