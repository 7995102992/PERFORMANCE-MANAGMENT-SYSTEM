import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Flag,
  Tag,
  User,
  Users,
  Wallet,
  BarChart3,
  FolderKanban,
  CalendarDays,
  Timer,
  Ticket,
  DoorOpen,
  Circle,
  AlertTriangle,
  Route,
  RefreshCw,
  GitCommitVertical,
  Waypoints,
} from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineTitle,
} from '@/components/ui/timeline'
import { cn } from '@/lib/utils'
import type { JourneyEvent, TimelineDesign } from '@/types/employee-journey'

// ─── Event type → icon mapping ────────────────────────────────────────────────
const EVENT_ICONS: Record<string, LucideIcon> = {
  onboarded: Flag,
  designation_assigned: Tag,
  l1_assigned: User,
  l2_assigned: Users,
  paygrade_allocated: Wallet,
  band_allocated: BarChart3,
  project_assigned: FolderKanban,
  leave_allocated: CalendarDays,
  leave_shift_assigned: CalendarDays,
  year_end_hours: Timer,
  service_request: Ticket,
  service_request_raised: Ticket,
  exit: DoorOpen,
}

function iconFor(eventType: string): LucideIcon {
  return EVENT_ICONS[eventType] ?? Circle
}

// "2024-01-15T..." → "15 Jan 2024". Returns null on missing/invalid dates.
function formatDate(iso: string | null): string | null {
  if (!iso) return null
  // Trim microseconds to milliseconds — the parser only handles 3 fractional digits.
  const date = new Date(iso.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(date.getTime())) return null
  return date
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    })
    .replace(/ /g, '-')
}

// Sort latest-first by occurred_at (stable for equal timestamps), undated last.
function orderEvents(events: JourneyEvent[]): JourneyEvent[] {
  const dated = events.filter((e) => e.occurred_at)
  const undated = events.filter((e) => !e.occurred_at)
  dated.sort((a, b) => b.occurred_at!.localeCompare(a.occurred_at!))
  return [...dated, ...undated]
}

// Alternating left/right layout — flips the absolutely-positioned indicator and
// separator to the opposite side on even items (ReUI "Alternating Layout").
const ALTERNATING_ITEM = cn(
  // flex-none: keep natural height so the container can space the nodes apart.
  // ps-/pe- push the text away from the centre spine on the side facing it.
  'flex-none w-[calc(50%-1.5rem)] odd:ms-auto odd:ps-8 even:me-auto even:pe-8 even:text-right even:group-data-[orientation=vertical]/timeline:ms-0 even:group-data-[orientation=vertical]/timeline:me-8',
  'even:group-data-[orientation=vertical]/timeline:**:data-[slot=timeline-indicator]:-right-6 even:group-data-[orientation=vertical]/timeline:**:data-[slot=timeline-indicator]:left-auto',
  'even:group-data-[orientation=vertical]/timeline:**:data-[slot=timeline-indicator]:translate-x-1/2 even:group-data-[orientation=vertical]/timeline:**:data-[slot=timeline-separator]:-right-6',
  'even:group-data-[orientation=vertical]/timeline:**:data-[slot=timeline-separator]:left-auto even:group-data-[orientation=vertical]/timeline:**:data-[slot=timeline-separator]:translate-x-1/2',
)

// How many events are revealed per "page". Change this single value and the
// whole paging behaviour (window size, page count, dashes) adapts.
const EVENTS_PER_PAGE = 5

// Auto-advance interval (ms) for moving to the next page, carousel-style.
const AUTO_ADVANCE_MS = 5000

// Entrance animation timing for each page's reveal.
const ANIM_STEP_MS = 320 // stagger between consecutive nodes
const ANIM_NODE_MS = 700 // each node's icon/content reveal duration

// Total time for a page's entrance (last node finishes). The auto-advance
// countdown only starts after this completes.
const entranceMs = (count: number) =>
  (Math.max(1, count) - 1) * ANIM_STEP_MS + ANIM_NODE_MS

// ── Serpentine ("snake") timeline design ──────────────────────────────────────
// Its own per-page count (analogous to EVENTS_PER_PAGE) plus the layout geometry.
const SNAKE_COLS = 3 // nodes per serpentine row
const SNAKE_EVENTS_PER_PAGE = SNAKE_COLS * 3 // fills three serpentine rows
const SNAKE_LINE_Y = 28 // px from a row band's top to its horizontal track line
const SNAKE_TURN_R = 44 // px nodes-lane side padding
const SNAKE_TURN_LEAD = 40 // px the line runs past the edge node before it turns
const SNAKE_TOP_OFFSET = 20 // px gap so the snake starts below the design tabs

// ─── Reusable timeline view (vertical + serpentine, paged, animated) ──────────
// Renders inside any flex-column, height-bounded container (a card or a sheet).
export function JourneyView({
  events: rawEvents,
  isLoading,
  isError,
  isFetching,
  onRetry,
  emptyDescription = 'Milestones will appear here as they happen — onboarding, role changes, projects and more.',
}: {
  events: JourneyEvent[]
  isLoading: boolean
  isError: boolean
  isFetching?: boolean
  onRetry: () => void
  emptyDescription?: string
}) {
  const events = useMemo(() => orderEvents(rawEvents), [rawEvents])
  const [design, setDesign] = useState<TimelineDesign>('snake')

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {isLoading ? (
        <div className="min-h-0 flex-1 overflow-hidden p-6">
          <TimelineSkeleton />
        </div>
      ) : isError ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <ErrorState onRetry={onRetry} retrying={!!isFetching} />
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState icon={Route} title="No journey events yet" description={emptyDescription} />
        </div>
      ) : (
        <>
          <DesignToggle design={design} onChange={setDesign} />
          <PaginatedTimeline events={events} design={design} />
        </>
      )}
    </div>
  )
}

// Switch between the vertical and serpentine ("snake") timeline designs.
function DesignToggle({
  design,
  onChange,
}: {
  design: TimelineDesign
  onChange: (d: TimelineDesign) => void
}) {
  const options: { key: TimelineDesign; icon: LucideIcon; label: string }[] = [
    { key: 'snake', icon: Waypoints, label: 'Serpentine timeline' },
    { key: 'vertical', icon: GitCommitVertical, label: 'Vertical timeline' },
  ]
  return (
    <div className="absolute left-3 top-3 z-20 flex items-center gap-0.5 rounded-xl border bg-card p-0.5 shadow-sm">
      {options.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-label={label}
          aria-pressed={design === key}
          className={cn(
            'flex size-7 items-center justify-center rounded-md transition-colors',
            design === key
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  )
}

// ─── Gesture-driven, paginated timeline ───────────────────────────────────────
// Shows EVENTS_PER_PAGE at a time inside a fixed-height card. Scrolling down or
// pressing ↓ advances the window (timeline slides up to the next page); scroll
// up / ↑ goes back. No internal scrollbar — paging replaces it.
function PaginatedTimeline({
  events,
  design,
}: {
  events: JourneyEvent[]
  design: TimelineDesign
}) {
  const pageSize = design === 'snake' ? SNAKE_EVENTS_PER_PAGE : EVENTS_PER_PAGE
  const totalPages = Math.max(1, Math.ceil(events.length / pageSize))
  const [pageRaw, setPage] = useState(0)
  const [paused, setPaused] = useState(false)
  const lock = useRef(false)

  // Clamp during render so the page stays valid if the data set shrinks.
  const page = Math.min(pageRaw, totalPages - 1)

  const goNext = useCallback(() => {
    setPage((p) => Math.min(p + 1, totalPages - 1))
  }, [totalPages])

  const goPrev = useCallback(() => {
    setPage((p) => Math.max(p - 1, 0))
  }, [])

  // Auto-advance is driven by the active dash's progress animation finishing
  // (onAnimationEnd below). Tying both to the same animation keeps the fill bar
  // and the page change in sync, and pausing the animation pauses the countdown.
  const handleAutoAdvance = useCallback(() => {
    setPage((p) => (p + 1) % totalPages)
  }, [totalPages])

  // One wheel "flick" = one page; lock briefly so a single gesture can't skip pages.
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 8 || lock.current) return
    lock.current = true
    if (e.deltaY > 0) goNext()
    else goPrev()
    window.setTimeout(() => {
      lock.current = false
    }, 420)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault()
      goNext()
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault()
      goPrev()
    }
  }

  const start = page * pageSize
  const visible = events.slice(start, start + pageSize)
  // Rows before this page — lets the snake keep a continuous flow across pages.
  const rowOffset = Math.floor(start / SNAKE_COLS)

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col outline-none"
      tabIndex={0}
      role="region"
      aria-label="Journey timeline"
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Carousel-style progress dashes — vertical, centred on the right edge.
          The active dash fills top→bottom over AUTO_ADVANCE_MS. */}
      <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5">
        {Array.from({ length: totalPages }).map((_, i) => {
          const active = i === page
          return (
            <button
              key={i}
              type="button"
              onClick={() => setPage(i)}
              aria-label={`Go to page ${i + 1}`}
              aria-current={active}
              className={cn(
                'relative w-1.5 overflow-hidden rounded-full bg-primary/20 transition-all duration-300',
                active ? 'h-7' : 'h-4 hover:bg-primary/40',
              )}
            >
              {active && (
                <span
                  className="absolute inset-x-0 top-0 h-full origin-top rounded-full bg-primary"
                  style={{
                    transform: totalPages > 1 ? 'scaleY(0)' : 'scaleY(1)',
                    animation:
                      totalPages > 1
                        ? `dash-progress ${AUTO_ADVANCE_MS}ms linear forwards`
                        : undefined,
                    // hold empty until the page's entrance animation has finished
                    animationDelay: `${entranceMs(visible.length)}ms`,
                    animationPlayState: paused ? 'paused' : 'running',
                  }}
                  onAnimationEnd={handleAutoAdvance}
                />
              )}
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
        {/* key remounts on page/design change → the entrance animations replay.
            Vertical design stays a centred column; the snake uses the full width. */}
        <div
          key={`${design}-${page}`}
          className={cn(
            'flex min-h-0 w-full flex-1 flex-col',
            design === 'snake' ? '' : 'mx-auto max-w-4xl',
          )}
        >
          {design === 'snake' ? (
            <SnakeTimeline
              events={visible}
              showPresent={page === 0}
              showEnd={page === totalPages - 1}
              onPrev={goPrev}
              onNext={goNext}
              rowOffset={rowOffset}
            />
          ) : (
            <JourneyTimeline
              events={visible}
              showPresent={page === 0}
              showEnd={page === totalPages - 1}
              onPrev={goPrev}
              onNext={goNext}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// Cap node sitting on the spine — "Present" at the very top, "End" at the bottom.
function SpineCap({ label, position }: { label: string; position: 'top' | 'bottom' }) {
  const isPresent = position === 'top'
  return (
    <div className={cn('relative flex justify-center', isPresent ? 'mb-6' : 'mt-2')}>
      <span className="z-10 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span
          className={cn(
            'size-2 rounded-full',
            isPresent ? 'bg-success animate-pulse' : 'border border-success/60',
          )}
        />
        {label}
      </span>
    </div>
  )
}

// ─── Timeline (ReUI alternating layout) ───────────────────────────────────────
function JourneyTimeline({
  events,
  showPresent,
  showEnd,
  onPrev,
  onNext,
}: {
  events: JourneyEvent[]
  showPresent?: boolean
  showEnd?: boolean
  onPrev?: () => void
  onNext?: () => void
}) {
  // The spine "draws" downward from the top to the last node; nodes reveal in a
  // matching stagger so each node lights up roughly as the line reaches it.
  const lineMs = entranceMs(events.length)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* centre spine — animated to draw from the top downward */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 origin-top -translate-x-1/2 border-l-2 border-success/40"
        style={{ animation: `spine-draw ${lineMs}ms ease-out both` }}
      />
      {showPresent && <SpineCap label="Present" position="top" />}
      {/* flex-1 + justify-between spreads the nodes to fill the card height */}
      <Timeline defaultValue={events.length} className="w-full flex-1 justify-between">
        {events.map((event, i) => {
          const Icon = iconFor(event.event_type)
          const date = formatDate(event.occurred_at)
          const isRight = i % 2 === 0 // odd step → content sits right of the spine
          const delay = `${i * ANIM_STEP_MS}ms`

          // First / last node icons double as the previous / next controls
          // (navigation is merged into the timeline icons — no separate arrows).
          const nav =
            i === 0 && !showPresent
              ? { fn: onPrev, label: 'Previous events' }
              : i === events.length - 1 && !showEnd
                ? { fn: onNext, label: 'Next events' }
                : null

          return (
            <TimelineItem key={`${event.event_type}-${i}`} step={i + 1} className={ALTERNATING_ITEM}>
              {/* dotted connector: spine → side content */}
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-3 h-0 w-14 animate-in fade-in-0 border-t-2 border-dotted border-success/40',
                  isRight ? '-left-6' : '-right-6',
                )}
                style={{ animationDelay: delay, animationDuration: `${ANIM_NODE_MS}ms`, animationFillMode: 'both' }}
              />
              <TimelineHeader>
                {/* content slides in from the spine side; staggered per node */}
                <div
                  className={cn(
                    'animate-in fade-in-0',
                    isRight ? 'slide-in-from-left-4' : 'slide-in-from-right-4',
                  )}
                  style={{ animationDelay: delay, animationDuration: `${ANIM_NODE_MS}ms`, animationFillMode: 'both' }}
                >
                  {date && <TimelineDate>{date}</TimelineDate>}
                  <TimelineTitle className="text-foreground">{event.title}</TimelineTitle>
                  {event.description && (
                    <TimelineContent className="mt-1">{event.description}</TimelineContent>
                  )}
                </div>
                {/* icon "focuses" in; first/last icons also act as prev/next */}
                <TimelineIndicator
                  onClick={nav?.fn}
                  onKeyDown={
                    nav
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            nav.fn?.()
                          }
                        }
                      : undefined
                  }
                  role={nav ? 'button' : undefined}
                  tabIndex={nav ? 0 : undefined}
                  aria-label={nav?.label}
                  aria-hidden={nav ? false : undefined}
                  className={cn(
                    // border-success!/text-success! override ReUI's completed-primary styling
                    'flex size-6 animate-in items-center justify-center border-success! bg-card text-success! zoom-in-50 fade-in-0',
                    nav &&
                      'cursor-pointer transition-transform hover:scale-110 hover:ring-4 hover:ring-success/15',
                  )}
                  style={{ animationDelay: delay, animationDuration: `${ANIM_NODE_MS}ms`, animationFillMode: 'both' }}
                >
                  <Icon className="size-3" />
                </TimelineIndicator>
              </TimelineHeader>
            </TimelineItem>
          )
        })}
      </Timeline>
      {showEnd && <SpineCap label="End" position="bottom" />}
    </div>
  )
}

// Terminal pill on the snake track — "Present" at the start, "End" at the end.
function SnakeCap({
  label,
  side,
  pad,
  y,
}: {
  label: string
  side: 'left' | 'right'
  /** Distance from the edge to the track end (the nodes-lane side padding). */
  pad: number
  y: number | string
}) {
  const isPresent = label === 'Present'
  return (
    <span
      className="absolute z-20 inline-flex -translate-y-1/2 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      style={{ top: y, ...(side === 'left' ? { left: pad } : { right: pad }) }}
    >
      <span
        className={cn(
          'size-2 rounded-full',
          isPresent ? 'bg-primary animate-pulse' : 'border border-primary/60',
        )}
      />
      {label}
    </span>
  )
}

// ─── Timeline (serpentine / "snake" layout) ───────────────────────────────────
function SnakeTimeline({
  events,
  showPresent,
  showEnd,
  onPrev,
  onNext,
  rowOffset = 0,
}: {
  events: JourneyEvent[]
  showPresent?: boolean
  showEnd?: boolean
  onPrev?: () => void
  onNext?: () => void
  /** Rows on previous pages — keeps the snake direction continuous across pages. */
  rowOffset?: number
}) {
  // Chunk into serpentine rows; direction is decided by the *global* row index
  // (rowOffset + r) so the flow continues seamlessly onto the next page.
  const rows: JourneyEvent[][] = []
  for (let i = 0; i < events.length; i += SNAKE_COLS) {
    rows.push(events.slice(i, i + SNAKE_COLS))
  }
  const lastIndex = events.length - 1
  const lastRow = rows.length - 1
  const hasPrev = !showPresent
  const hasNext = !showEnd

  // Side the snake enters (first node) and exits (last node) on.
  const entrySide: 'left' | 'right' = rowOffset % 2 === 1 ? 'right' : 'left'
  const exitSide: 'left' | 'right' = (rowOffset + lastRow) % 2 === 1 ? 'left' : 'right'

  const n = rows.length

  // Measure the available area so U-turns can be true semicircles whose radius =
  // half the (stretched) row gap, keeping the snake filling the space.
  const fillRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = fillRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w: fillW, h: fillH } = size
  const rowH = n > 0 ? fillH / n : 0 // each row band's height in px
  const side = SNAKE_TURN_R // nodes-lane side padding
  const cellW = n > 0 ? (fillW - 2 * side) / SNAKE_COLS : 0 // column width
  const radius = n > 1 ? rowH / 2 : 0 // circular U-turn radius
  // Turns happen AT the edge nodes (not the lane edge), so there's no long
  // straight line before a turn.
  const nodeXL = side + cellW / 2 // leftmost node centre
  const nodeXR = fillW - side - cellW / 2 // rightmost node centre
  const laneXL = side // lane edges — used only for the Present/End caps
  const laneXR = fillW - side
  // Turn a little past the edge node (clamped to the lane edge).
  const turnXL = Math.max(laneXL, nodeXL - SNAKE_TURN_LEAD)
  const turnXR = Math.min(laneXR, nodeXR + SNAKE_TURN_LEAD)

  // Build ONE continuous serpentine path (rows joined by circular U-turns); one
  // stroke so the line never breaks at a junction.
  const lineY = (r: number) => r * rowH + SNAKE_LINE_Y
  const rev = (r: number) => (rowOffset + r) % 2 === 1
  let pathD = ''
  if (fillW > 0) {
    // start of row 0: continue from the edge, else reach the lane edge for the cap
    let startX = rev(0) ? nodeXR : nodeXL
    if (hasPrev) startX = entrySide === 'left' ? 0 : fillW
    else if (showPresent) startX = entrySide === 'left' ? laneXL : laneXR
    pathD = `M ${startX} ${lineY(0)}`
    for (let r = 0; r < n; r++) {
      const turnX = rev(r) ? turnXL : turnXR // turn a little past the edge node
      let endX = turnX
      if (r === lastRow) {
        if (hasNext) endX = exitSide === 'left' ? 0 : fillW
        else if (showEnd) endX = exitSide === 'left' ? laneXL : laneXR
      }
      pathD += ` L ${endX} ${lineY(r)}`
      if (r < lastRow) {
        pathD += ` A ${radius} ${radius} 0 0 ${rev(r) ? 0 : 1} ${turnX} ${lineY(r + 1)}`
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* gap so the snake starts below the design toggle tabs */}
      <div className="shrink-0" style={{ height: SNAKE_TOP_OFFSET }} />
      <div ref={fillRef} className="relative min-h-0 w-full flex-1 overflow-hidden">
        {fillW > 0 && fillH > 0 && (
          <>
            {/* the whole serpentine line as one continuous SVG stroke — no breaks */}
            <svg
              aria-hidden
              width={fillW}
              height={fillH}
              className="pointer-events-none absolute inset-0 animate-in fade-in-0"
              style={{ animationDuration: `${ANIM_NODE_MS}ms`, animationFillMode: 'both' }}
            >
              <path
                d={pathD}
                fill="none"
                strokeWidth={2}
                style={{ stroke: 'var(--primary)', strokeOpacity: 0.45 }}
              />
            </svg>

        {rows.map((row, r) => {
          const reversed = rev(r)
          return (
            <div
              key={`row-${r}`}
              className="absolute inset-x-0"
              style={{ top: r * rowH, height: rowH }}
            >
              {/* nodes + content */}
              <div
                className={cn('flex h-full', reversed && 'flex-row-reverse')}
                style={{ paddingLeft: side, paddingRight: side }}
              >
                {row.map((event, c) => {
                  const idx = r * SNAKE_COLS + c
                  const Icon = iconFor(event.event_type)
                  const date = formatDate(event.occurred_at)
                  const delay = `${idx * ANIM_STEP_MS}ms`
                  const nav =
                    idx === 0 && hasPrev
                      ? { fn: onPrev, label: 'Previous events' }
                      : idx === lastIndex && hasNext
                        ? { fn: onNext, label: 'Next events' }
                        : null

                  return (
                    <div
                      key={`${event.event_type}-${idx}`}
                      className="relative shrink-0"
                      style={{ width: cellW }}
                    >
                      {/* node icon, centred on the track line */}
                      <div
                        onClick={nav?.fn}
                        onKeyDown={
                          nav
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  nav.fn?.()
                                }
                              }
                            : undefined
                        }
                        role={nav ? 'button' : undefined}
                        tabIndex={nav ? 0 : undefined}
                        aria-label={nav?.label}
                        className={cn(
                          'absolute left-1/2 z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 animate-in items-center justify-center rounded-full border-2 border-primary bg-card text-primary zoom-in-50 fade-in-0',
                          nav &&
                            'cursor-pointer transition-transform hover:scale-110 hover:ring-4 hover:ring-primary/15',
                        )}
                        style={{
                          top: SNAKE_LINE_Y,
                          animationDelay: delay,
                          animationDuration: `${ANIM_NODE_MS}ms`,
                          animationFillMode: 'both',
                        }}
                      >
                        <Icon className="size-3.5" />
                      </div>
                      {/* content below the node */}
                      <div
                        className="absolute left-1/2 w-full max-w-[200px] -translate-x-1/2 animate-in space-y-0.5 px-2 text-center fade-in-0 slide-in-from-bottom-2"
                        style={{
                          top: SNAKE_LINE_Y + 18,
                          animationDelay: delay,
                          animationDuration: `${ANIM_NODE_MS}ms`,
                          animationFillMode: 'both',
                        }}
                      >
                        {date && (
                          <p className="text-xs font-medium text-muted-foreground">{date}</p>
                        )}
                        <p className="break-words text-sm font-semibold text-foreground">
                          {event.title}
                        </p>
                        {event.description && (
                          <p className="break-words text-xs text-muted-foreground">
                            {event.description}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Present / End caps at the true start / end of the journey */}
        {showPresent && (
          <SnakeCap label="Present" side={entrySide} pad={side} y={SNAKE_LINE_Y} />
        )}
        {showEnd && (
          <SnakeCap
            label="End"
            side={exitSide}
            pad={side}
            y={lastRow * rowH + SNAKE_LINE_Y}
          />
        )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Loading skeleton (mirrors the alternating layout) ────────────────────────
function TimelineSkeleton() {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 border-l-2 border-success/20"
      />
      <Timeline defaultValue={0} className="w-full">
        {Array.from({ length: 5 }).map((_, i) => {
          const isRight = i % 2 === 0
          return (
            <TimelineItem key={i} step={i + 1} className={ALTERNATING_ITEM}>
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-3 h-0 w-14 border-t-2 border-dotted border-success/20',
                  isRight ? '-left-6' : '-right-6',
                )}
              />
              <TimelineHeader>
                <Skeleton className={cn('mb-1 h-3 w-20', !isRight && 'ms-auto')} />
                <Skeleton className={cn('h-4 w-32', !isRight && 'ms-auto')} />
                <TimelineIndicator className="size-6 border-success/30! bg-card" />
              </TimelineHeader>
              <Skeleton className={cn('mt-2 h-3 w-40', !isRight && 'ms-auto')} />
            </TimelineItem>
          )
        })}
      </Timeline>
    </div>
  )
}

// ─── Error state ──────────────────────────────────────────────────────────────
function ErrorState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-5 text-destructive" />
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground">Couldn't load this journey</p>
        <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">
          Something went wrong while fetching the timeline. Please try again.
        </p>
      </div>
      <Button variant="outline" size="sm" className="gap-2" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={cn('size-4', retrying && 'animate-spin')} />
        Retry
      </Button>
    </div>
  )
}
