import { useEffect } from 'react'

/**
 * Auto-selects the only available option when a select field is still empty.
 *
 * Used for BU / Department pickers: when there's exactly one choice we fill it
 * in automatically instead of making the user open a single-item dropdown.
 * Only fires while the field is empty, so editing an existing record never
 * overwrites a saved value.
 *
 * - `value`     — current field value (string for single-select, string[] for multi).
 * - `options`   — available options.
 * - `onSelect`  — called with the lone option's value when it should be applied.
 * - `enabled`   — gate (default true); pass false to skip (e.g. view mode).
 */
export function useAutoSelectSingleOption(opts: {
  value: string | string[] | undefined
  options: { value: string }[]
  onSelect: (value: string) => void
  enabled?: boolean
}) {
  const { value, options, onSelect, enabled = true } = opts
  const isEmpty = Array.isArray(value) ? value.length === 0 : !value

  useEffect(() => {
    if (!enabled) return
    if (isEmpty && options.length === 1) {
      onSelect(options[0].value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isEmpty, options])
}
