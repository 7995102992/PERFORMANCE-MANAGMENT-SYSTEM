import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * Place at the bottom of a paged list. Calls `onLoadMore` whenever it scrolls
 * into view (with a 200px head start) while more pages remain.
 */
export function InfiniteScrollSentinel({
  onLoadMore,
  hasMore,
  isFetching,
}: {
  onLoadMore: () => void
  hasMore: boolean
  isFetching: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
    // isFetching is a dep on purpose: observe() reports the current state on
    // (re)subscribe, so when a page finishes loading and the sentinel is STILL
    // visible (short/filtered lists), the recreated observer fires again and
    // keeps paging — a plain observer only fires on visibility *changes*.
  }, [onLoadMore, hasMore, isFetching])

  if (!hasMore) return null
  return (
    <div ref={ref} className="flex items-center justify-center py-2 text-muted-foreground">
      {isFetching && <Loader2 className="h-4 w-4 animate-spin" />}
    </div>
  )
}
