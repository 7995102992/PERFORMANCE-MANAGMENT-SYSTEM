/**
 * One labelled field: required marker, the control, and — once validation has
 * failed on it — an inline message plus a red outline on the control itself.
 *
 * The outline is applied by descendant selector rather than by threading an
 * `invalid` prop through every control, because a field wrapper holds `Input`,
 * `Textarea`, `<Select>` triggers, `DatePicker` triggers and `SearchableSelect`
 * triggers interchangeably and they all render one bordered element.
 *
 * Every expense form shares this so "Submit an empty form" reads the same way
 * on each of them.
 */
import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Red border (and focus ring) on any bordered control inside an invalid field.
 * Exported for the few places that lay out their own field wrapper.
 */
export const invalidControlClass =
  '[&_input]:border-destructive [&_textarea]:border-destructive [&_button]:border-destructive ' +
  '[&_input]:focus-visible:ring-destructive/30 [&_textarea]:focus-visible:ring-destructive/30'

interface FieldProps {
  label: string
  required?: boolean
  /** Set once the field has failed validation — drives both the message and the outline. */
  error?: string
  /** Shown in the error's place while the field is valid. */
  hint?: string
  className?: string
  children: ReactNode
}

export function Field({
  label,
  required,
  error,
  hint,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <Label>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      <div className={cn('space-y-2', error && invalidControlClass)}>
        {children}
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
