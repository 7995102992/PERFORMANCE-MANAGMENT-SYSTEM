import type { ChangeEvent } from 'react'

/**
 * onChange handler for a controlled `<input type="number">` that strips leading
 * zeros from the visible value (e.g. "05" → "5") — even when the parsed number
 * is unchanged and React would otherwise skip the re-render — and emits `null`
 * when the field is cleared. Pass `parse: 'float'` for decimal inputs.
 */
export function stripZerosOnChange(
  onChange: (v: number | null) => void,
  opts: { parse?: 'int' | 'float'; min?: number; max?: number } = {},
) {
  return (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    if (raw === '') {
      onChange(null)
      return
    }
    let num = opts.parse === 'float' ? parseFloat(raw) : parseInt(raw, 10)
    if (Number.isNaN(num)) {
      onChange(null)
      return
    }
    if (opts.max != null && num > opts.max) num = opts.max
    if (opts.min != null && num < opts.min) num = opts.min
    // Force the DOM value to the canonical number so a typed leading zero never
    // sticks, regardless of whether RHF re-renders.
    const canonical = String(num)
    if (raw !== canonical) e.target.value = canonical
    onChange(num)
  }
}
