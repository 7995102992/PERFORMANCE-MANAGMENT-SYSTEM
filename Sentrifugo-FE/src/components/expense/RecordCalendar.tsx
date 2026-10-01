/**
 * The month grid shared by expenses and trips (§12.3).
 *
 * Fed by the dedicated calendar endpoints, which return **per-day aggregates
 * plus a capped card list** — never the month's rows. Building this from a list
 * response would mean fetching a month to count it, which is exactly what the
 * separate endpoint exists to avoid (§12.2, decision 23).
 *
 * Generic over the payload so both subjects share one grid: the caller maps its
 * cards into `CalendarEntry` and keeps its own field names out of here.
 *
 * Visually mirrors the attendance calendar: week starts Monday, a
 * `bg-table-header` weekday row, bordered cells, leading/trailing days from the
 * adjacent months greyed out, and the date pinned top-right in a rounded pill.
 */
import type { MonthKey } from '@/lib/expense-utils'
import type { RecordStatus } from '@/types/expense'

export interface CalendarEntry {
  id: string
  primary: string
  secondary?: string
  tertiary?: string
  status?: RecordStatus
}

export interface CalendarDayData {
  /** `YYYY-MM-DD`. */
  day: string
  count: number
  cards: CalendarEntry[]
}

interface Props {
  month: MonthKey
  days: CalendarDayData[]
  onCardClick: (id: string) => void
}

const DAY_HEADERS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

interface GridDay {
  day: number
  inMonth: boolean
}

/** Whole weeks of cells, Monday-first, padded with adjacent-month days. */
function buildGrid(year: number, mon: number): GridDay[] {
  const first = new Date(year, mon - 1, 1)
  const daysInMonth = new Date(year, mon, 0).getDate()
  const daysInPrevMonth = new Date(year, mon - 1, 0).getDate()
  // Sunday(0) → 6 so the week starts on Monday.
  const leading = (first.getDay() + 6) % 7

  const cells: GridDay[] = []
  for (let i = leading - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, inMonth: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true })
  }
  let next = 1
  while (cells.length % 7 !== 0) {
    cells.push({ day: next++, inMonth: false })
  }
  return cells
}

export function RecordCalendar({ month, days, onCardClick }: Props) {
  const [year, mon] = month.split('-').map(Number)
  const cells = buildGrid(year, mon)

  const byDay = new Map(days.map((d) => [d.day, d]))

  return (
    <div>
      {/* Day headers */}
      <div className="grid grid-cols-7">
        {DAY_HEADERS.map((d) => (
          <div
            key={d}
            className="border-b border-r px-3 py-2.5 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground last:border-r-0 bg-table-header"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {cells.map((cell, i) => {
          if (!cell.inMonth) {
            return (
              <div
                key={`pad-${i}`}
                className="relative flex min-h-[112px] flex-col border-b border-r bg-muted/20 p-2 last:border-r-0"
              >
                <div className="flex items-start justify-end">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium text-muted-foreground/40">
                    {String(cell.day).padStart(2, '0')}
                  </span>
                </div>
              </div>
            )
          }

          const iso = `${month}-${String(cell.day).padStart(2, '0')}`
          const data = byDay.get(iso)

          return (
            <div
              key={iso}
              className="relative flex min-h-[112px] flex-col border-b border-r bg-card p-2 last:border-r-0"
            >
              {/* Top row — date badge pinned top-right, with the day's entries
                  stacked left-aligned underneath it. */}
              <div className="mb-1 flex items-start justify-end">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-table-header text-xs font-medium text-muted-foreground">
                  {String(cell.day).padStart(2, '0')}
                </span>
              </div>

              <div className="space-y-1">
                {data?.cards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => onCardClick(card.id)}
                    className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
                  >
                    <p className="truncate text-[11px] font-medium text-foreground">
                      {card.primary}
                    </p>
                    {card.secondary && (
                      <p className="truncate text-[10px] text-muted-foreground">
                        {card.secondary}
                      </p>
                    )}
                    {card.tertiary && (
                      <p className="truncate text-[10px] text-muted-foreground">
                        {card.tertiary}
                      </p>
                    )}
                  </button>
                ))}

                {/* The endpoint caps cards per day; say so rather than
                    silently showing a subset (§12.3). */}
                {data && data.count > data.cards.length && (
                  <p className="px-1.5 text-[10px] text-muted-foreground">
                    +{data.count - data.cards.length} more
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
