import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLazyGetDirectoryQuery } from '@/store/api/iamApi'
import type { DirectoryEmployee, DirectoryListParams } from '@/types/iam'

/** `/directory` caps a page at 200. */
const PAGE_SIZE = 200

type PoolFilters = Pick<DirectoryListParams, 'search' | 'departmentIds'>

async function drain(
  fetchPage: (skip: number) => Promise<{ items: DirectoryEmployee[]; total: number }>,
): Promise<DirectoryEmployee[]> {
  const collected: DirectoryEmployee[] = []
  // Bounded so a mis-reported `total` can't spin forever.
  for (let page = 0; page < 50; page++) {
    const res = await fetchPage(page * PAGE_SIZE)
    collected.push(...(res.items ?? []))
    if (!res.items?.length || collected.length >= (res.total ?? 0)) break
  }
  return collected
}

/**
 * The whole filtered directory, split into active and inactive.
 *
 * `/directory` sorts alphabetically server-side and its `includeInactive` is
 * binary — there is no "inactive only" mode and no way to ask for active-first
 * ordering. So a status filter that segregates the two has to hold the filtered
 * set client-side and page it here.
 *
 * Activeness comes from the server's own definition rather than being inferred
 * from the status label: whoever appears in the active-only pass is active. The
 * search/department filters are still applied server-side, so only the filtered
 * set is ever drained, and the hook is skipped entirely for the default
 * (active-only) view, which keeps its exact server paging.
 */
export function useDirectoryPool(filters: PoolFilters, options?: { skip?: boolean }) {
  const disabled = options?.skip ?? false
  const [trigger] = useLazyGetDirectoryQuery()

  const [active, setActive] = useState<DirectoryEmployee[]>([])
  const [inactive, setInactive] = useState<DirectoryEmployee[]>([])
  const [isLoading, setIsLoading] = useState(!disabled)
  const [isError, setIsError] = useState(false)

  // Bumped per run so a slow page from a superseded run can't land on the
  // current one.
  const runSeq = useRef(0)
  const filterKey = JSON.stringify(filters)

  const load = useCallback(
    async (seq: number) => {
      setIsLoading(true)
      setIsError(false)
      const base = JSON.parse(filterKey) as PoolFilters
      try {
        const [activeRows, allRows] = await Promise.all([
          drain((skip) =>
            trigger({ ...base, skip, limit: PAGE_SIZE }, true).unwrap(),
          ),
          drain((skip) =>
            trigger({ ...base, includeInactive: true, skip, limit: PAGE_SIZE }, true).unwrap(),
          ),
        ])
        if (seq !== runSeq.current) return
        const activeKeys = new Set(activeRows.map((r) => r.id ?? r.userId))
        setActive(activeRows)
        setInactive(allRows.filter((r) => !activeKeys.has(r.id ?? r.userId)))
      } catch {
        if (seq !== runSeq.current) return
        setIsError(true)
        setActive([])
        setInactive([])
      } finally {
        if (seq === runSeq.current) setIsLoading(false)
      }
    },
    [filterKey, trigger],
  )

  useEffect(() => {
    const seq = ++runSeq.current
    if (disabled) {
      setActive([])
      setInactive([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    load(seq)
  }, [disabled, load])

  return useMemo(
    () => ({ active, inactive, isLoading, isError }),
    [active, inactive, isLoading, isError],
  )
}
