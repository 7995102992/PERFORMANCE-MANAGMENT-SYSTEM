/**
 * `‹ July 2026 ›` plus the List/Calendar toggle (§12.1, §12.3).
 *
 * Every expense surface is month-scoped, independently of row pagination, and
 * the server never infers the current month — the window is always explicit in
 * the request. This bar owns that window and lives inside the table card as a
 * `border-b` toolbar row (CLAUDE.md §17).
 */
import { CalendarDays, ChevronLeft, ChevronRight, LayoutList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatMonthLabel, shiftMonth, type MonthKey } from '@/lib/expense-utils'

interface Props {
  month: MonthKey
  onMonthChange: (month: MonthKey) => void
  /** Omit to render the bar without a view toggle (advances have no calendar). */
  view?: 'list' | 'calendar'
  onViewChange?: (view: 'list' | 'calendar') => void
  /** Extra controls rendered between the month stepper and the toggle. */
  children?: React.ReactNode
  /**
   * Something else owns the window — an explicit date range, say.
   *
   * The stepper is greyed rather than removed so the row does not reflow. The
   * calendar toggle deliberately stays live: it used to be hidden alongside the
   * stepper, on the grounds that a month grid cannot draw a span of arbitrary
   * length — but that stranded anyone who picked a range with no way back to the
   * grid except undoing the filter first. Callers hand the window back to the
   * month when the calendar is opened instead.
   */
  scopeOverridden?: boolean
}

export function MonthScopeBar({
  month,
  onMonthChange,
  view,
  onViewChange,
  children,
  scopeOverridden = false,
}: Props) {
  const showToggle = view !== undefined && onViewChange !== undefined

  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={scopeOverridden}
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          aria-label="Previous month"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span
          className={cn(
            'min-w-[130px] text-center text-sm font-semibold',
            scopeOverridden
              ? 'text-muted-foreground line-through'
              : 'text-foreground',
          )}
          title={
            scopeOverridden
              ? 'A date range is filtering this list, so the month is not in use'
              : undefined
          }
        >
          {formatMonthLabel(month)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={scopeOverridden}
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          aria-label="Next month"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {children}

      {showToggle && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-2"
          onClick={() => onViewChange(view === 'calendar' ? 'list' : 'calendar')}
        >
          {view === 'calendar' ? (
            <LayoutList className="size-4 text-info" />
          ) : (
            <CalendarDays className="size-4 text-info" />
          )}
          {view === 'calendar' ? 'List View' : 'Calendar View'}
        </Button>
      )}
    </div>
  )
}
