import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLazyGetScopedEmployeesQuery } from '@/store/api/lmsApi'
import type { ScopedEmployee, ScopedEmployeeParams } from '@/types/leave'
import type { EmployeeResponse } from '@/types/iam'

export const EMPLOYEE_PAGE_SIZE = 100

// The pickers accept the calendar/plan scope plus an ignored `is_active` flag
// (the LMS pool is always active-only), so keep the param type permissive.
type InfiniteEmployeeParams = Omit<ScopedEmployeeParams, 'skip' | 'limit'> & {
  is_active?: boolean
}

/** Map an LMS pool row to the EmployeeResponse shape the pickers render —
 * everything, including the employment-type name, is resolved server-side
 * from the LMS mirror. */
function toEmployeeResponse(e: ScopedEmployee): EmployeeResponse {
  const full = (e.name ?? '').trim()
  const sp = full.indexOf(' ')
  const first = e.first_name ?? (sp === -1 ? full : full.slice(0, sp))
  const last = e.last_name ?? (sp === -1 ? '' : full.slice(sp + 1))
  return {
    id: e.user_id,
    userId: e.user_id,
    user_id: e.user_id,
    empCode: e.emp_code ?? '',
    emp_code: e.emp_code ?? '',
    firstName: first ?? '',
    first_name: first ?? '',
    lastName: last ?? '',
    last_name: last ?? '',
    workEmail: e.work_email ?? '',
    work_email: e.work_email ?? '',
    businessUnitId: e.business_unit_id ?? '',
    businessUnitName: e.business_unit_name ?? undefined,
    departmentId: e.department_id ?? '',
    departmentName: e.department_name ?? undefined,
    department_name: e.department_name ?? undefined,
    designationId: e.designation_id ?? '',
    designationName: e.designation_name ?? undefined,
    designation_name: e.designation_name ?? undefined,
    employmentStatus: e.employment_status
      ? { _id: e.employment_status_id ?? '', key: '', value: e.employment_status }
      : null,
    employmentType: e.employment_type
      ? { _id: e.employment_type_id ?? '', key: '', value: e.employment_type }
      : null,
  }
}

/** Append a page, dropping rows whose user already appeared (defensive against
 * any duplicate-user rows so list keys and counts stay correct). */
const mergePage = (prev: EmployeeResponse[], page: EmployeeResponse[]) => {
  const seen = new Set(prev.map((e) => e.user_id ?? e.id))
  const fresh = page.filter((e) => {
    const k = e.user_id ?? e.id
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return prev.length === 0 ? fresh : [...prev, ...fresh]
}

/**
 * Cursorless paging over the LMS employee pool (`GET /employees`). Screens that
 * need "everyone in scope" page with `skip`; this hook accumulates pages and
 * exposes `loadMore` for an infinite-scroll sentinel (see
 * `InfiniteScrollSentinel`). The endpoint returns a `total`, so exhaustion is
 * exact (accumulated >= total) rather than inferred from page length.
 *
 * Pages reset whenever the filter params change (compared by value).
 */
export function useInfiniteEmployees(
  params: InfiniteEmployeeParams,
  options?: { pageSize?: number; skip?: boolean; eager?: boolean },
) {
  const pageSize = options?.pageSize ?? EMPLOYEE_PAGE_SIZE
  const disabled = options?.skip ?? false
  const eager = options?.eager ?? false
  const [trigger] = useLazyGetScopedEmployeesQuery()

  const [employees, setEmployees] = useState<EmployeeResponse[]>([])
  const [hasMore, setHasMore] = useState(!disabled)
  const [isFetching, setIsFetching] = useState(false)

  // Bumped on every param change; responses from an older seq are dropped so a
  // slow page-2 of a previous filter can't append onto the new filter's list.
  const requestSeq = useRef(0)
  const loadedPages = useRef(0)
  const inFlight = useRef(false)

  // Pick only the LMS scope params (the pickers also pass an ignored is_active
  // flag — the LMS pool is always active-only).
  const scopeParams: ScopedEmployeeParams = {
    business_unit_ids: params.business_unit_ids,
    department_ids: params.department_ids,
    designation_ids: params.designation_ids,
    employment_type_id: params.employment_type_id,
    search: params.search,
  }
  const paramsKey = JSON.stringify(scopeParams)

  const fetchPage = useCallback(
    async (page: number, seq: number) => {
      if (inFlight.current) return
      inFlight.current = true
      setIsFetching(true)
      try {
        const result = await trigger(
          {
            ...(JSON.parse(paramsKey) as ScopedEmployeeParams),
            skip: page * pageSize,
            limit: pageSize,
          },
          true,
        ).unwrap()
        if (seq !== requestSeq.current) return
        const rawLen = result.items?.length ?? 0
        const mapped = (result.items ?? []).map(toEmployeeResponse)
        setEmployees((prev) => mergePage(page === 0 ? [] : prev, mapped))
        // Exhausted when the server returns a short page. Based on the RAW page
        // length (not the deduped total) so a duplicate-user row in the mirror
        // can't leave hasMore stuck true and loop.
        setHasMore(rawLen >= pageSize)
        loadedPages.current = page + 1
      } catch {
        // A failed page stops further auto-loading; a filter change resets.
        if (seq === requestSeq.current) setHasMore(false)
      } finally {
        // Only the current request may clear the flags — a superseded request
        // resolving late must not release a newer in-flight request's lock.
        if (seq === requestSeq.current) {
          inFlight.current = false
          setIsFetching(false)
        }
      }
    },
    [paramsKey, pageSize, trigger],
  )

  useEffect(() => {
    const seq = ++requestSeq.current
    inFlight.current = false
    loadedPages.current = 0
    setEmployees([])
    if (disabled) {
      setHasMore(false)
      setIsFetching(false)
      return
    }
    setHasMore(true)
    fetchPage(0, seq)
  }, [paramsKey, disabled, fetchPage])

  const loadMore = useCallback(() => {
    if (inFlight.current || !hasMore || disabled) return
    fetchPage(loadedPages.current, requestSeq.current)
  }, [hasMore, disabled, fetchPage])

  // `eager` drains every page up front (no sentinel needed) — for surfaces
  // that must have the complete scope loaded to work.
  useEffect(() => {
    if (!eager || disabled || !hasMore || inFlight.current) return
    fetchPage(loadedPages.current, requestSeq.current)
    // isFetching in deps re-arms this after each page settles.
  }, [eager, disabled, hasMore, isFetching, fetchPage])

  return useMemo(
    () => ({ employees, isFetching, hasMore, loadMore }),
    [employees, isFetching, hasMore, loadMore],
  )
}
