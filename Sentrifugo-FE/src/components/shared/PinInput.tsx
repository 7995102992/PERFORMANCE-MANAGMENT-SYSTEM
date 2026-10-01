import { useEffect, useRef } from 'react'

/**
 * Masked N-digit PIN entry (default 6). Fires `onComplete` when the last digit is
 * filled. Nothing is persisted. Each box exposes aria-label "PIN digit N".
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  disabled,
  length = 6,
  autoFocus = true,
}: {
  value: string
  onChange: (v: string) => void
  onComplete?: (v: string) => void
  disabled?: boolean
  length?: number
  autoFocus?: boolean
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  const chars = Array.from({ length }, (_, i) => value[i] ?? '')

  const setAt = (i: number, ch: string) =>
    (value.slice(0, i) + ch + value.slice(i + 1)).slice(0, length)

  const handleChange = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (!digits) {
      onChange(setAt(i, ''))
      return
    }
    const next = setAt(i, digits[digits.length - 1])
    onChange(next)
    if (i < length - 1) refs.current[i + 1]?.focus()
    if (next.length === length) onComplete?.(next)
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (value[i]) onChange(setAt(i, ''))
      else if (i > 0) {
        refs.current[i - 1]?.focus()
        onChange(setAt(i - 1, ''))
      }
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus()
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)
    if (!text) return
    e.preventDefault()
    onChange(text)
    refs.current[Math.min(text.length, length - 1)]?.focus()
    if (text.length === length) onComplete?.(text)
  }

  return (
    <div className="flex items-center justify-center gap-2" onPaste={handlePaste}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          value={c}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          disabled={disabled}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          aria-label={`PIN digit ${i + 1}`}
          className="size-11 rounded-lg border border-input bg-background text-center text-lg font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
        />
      ))}
    </div>
  )
}
