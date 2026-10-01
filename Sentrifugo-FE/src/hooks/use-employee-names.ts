/**
 * Resolve employee ids to display names for the expense lists.
 *
 * **Why this exists.** `AdvanceRow` carries `employee_name`, but `ExpenseRow`
 * and `TripRow` carry only `employee_id` / `owner_employee_id` — the expense
 * service resolves names for advances and not for the other two. The wireframes
 * show a "Raised By: Sarah H" column on Team Expenses and Employee Expenses, so
 * the client fills the gap from the IAM employee pool.
 *
 * This is a workaround, not the right long-term shape: the row endpoints should
 * return an `ActorSnapshot` for the claimant the same way they already do for
 * `approved_by`, `forwarded_to` and `reporting_manager`. Filed as a backend
 * follow-up. Until then this hook keeps the cost to one cached request per
 * session rather than an N+1 per list render.
 *
 * The pool is org-scoped and cached for an hour; an id we cannot resolve falls
 * back to a short form of the id rather than rendering blank, so a missing name
 * never looks like missing data.
 */
import { useCallback, useMemo } from 'react'
import { useGetEmployeesQuery } from '@/store/api/iamApi'

const POOL_LIMIT = 1000

export function useEmployeeNames() {
  const { data: employees = [], isLoading } = useGetEmployeesQuery(
    { limit: POOL_LIMIT },
    // The pool changes far more slowly than an expense list is refetched.
    { refetchOnMountOrArgChange: false },
  )

  const { byId, codeById } = useMemo(() => {
    const map = new Map<string, string>()
    const codes = new Map<string, string>()
    for (const e of employees) {
      const name = [e.firstName ?? e.first_name, e.lastName ?? e.last_name]
        .filter(Boolean)
        .join(' ')
        .trim()
      const code = e.empCode ?? e.emp_code
      if (!name && !code) continue
      // Index every id the row might reference — IAM user id and employee id
      // are different keys, and the expense service stores the user id.
      for (const key of [e.id, e.userId, e.user_id]) {
        if (!key) continue
        if (name) map.set(String(key), name)
        if (code) codes.set(String(key), String(code))
      }
    }
    return { byId: map, codeById: codes }
  }, [employees])

  const nameFor = useCallback(
    (id?: string | null, fallback?: string | null): string => {
      if (!id) return fallback ?? '—'
      const resolved = byId.get(String(id))
      if (resolved) return resolved
      if (fallback) return fallback
      // Never render a raw 24-char ObjectId in a table cell.
      return isLoading ? '…' : `#${String(id).slice(-6)}`
    },
    [byId, isLoading],
  )

  /**
   * The employee code for an id, or `null`.
   *
   * Null rather than a placeholder: callers render this beside a name, and
   * "Anita Desai (—)" reads worse than "Anita Desai". The expense service
   * cannot supply this itself — the Valkey session carries name, email and
   * roles but no employee code, so an `ActorSnapshot` frozen at decision time
   * has nothing to snapshot. Resolving here also covers records decided before
   * anyone thought to store it.
   */
  const codeFor = useCallback(
    (id?: string | null): string | null => (id ? (codeById.get(String(id)) ?? null) : null),
    [codeById],
  )

  return { nameFor, codeFor, isLoading }
}
