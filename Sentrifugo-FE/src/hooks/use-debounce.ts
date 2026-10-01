import { useEffect, useState } from 'react'

/**
 * Debounce a rapidly-changing value.
 *
 * Used for search boxes (so a keystroke is not a request) and for the Gate-2
 * approved-amount preview, where each change costs a round trip.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
