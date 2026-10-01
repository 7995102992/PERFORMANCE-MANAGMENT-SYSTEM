/**
 * The tile row above every expense list (§12.2).
 *
 * Served by a dedicated aggregate endpoint, not derived from the current page —
 * "All Expenses 12" beside "Showing 8 of 25" was the wireframe bug (correction
 * 9), and both are month-scoped here.
 *
 * **Labels come from the payload.** The manager's list says "All Requests"
 * where the employee's says "All Expenses"; the server returns one noun and
 * labels it, so the client must not hardcode either (correction 14).
 *
 * Tiles double as status filters. Clicking one applies its statuses; clicking
 * the active one clears back to everything.
 */
import {
  Archive,
  CheckCircle2,
  CircleDollarSign,
  XCircle,
  History,
  FileText,
  Check,
  UserCheck,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { formatMoney } from '@/lib/expense-utils'
import { IN_FLIGHT_STATUSES, type RecordStatus, type SummaryTile } from '@/types/expense'

/** Tile key → the status set it filters to. `all` clears the filter. */
const TILE_STATUSES: Record<string, RecordStatus[]> = {
  all: [],
  saved: ['DRAFT'],
  draft: ['DRAFT'],
  submitted: IN_FLIGHT_STATUSES,
  approved: ['APPROVED'],
  rejected: ['REJECTED'],
  settled: ['SETTLED'],
  // The trip's terminal state. An expense's tail is `APPROVED -> SETTLED`; a
  // trip's is `APPROVED -> CLOSED` (`SUBJECT_TAIL_TRANSITIONS`), so a tile
  // labelled "Settled" over a trip list would filter on a status no trip can
  // ever hold and read zero forever.
  closed: ['CLOSED'],
}

const TILE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  all: FileText,
  saved: Check,
  draft: Check,
  submitted: History,
  approved: CheckCircle2,
  rejected: XCircle,
  settled: CircleDollarSign,
  closed: Archive,
}

/**
 * A card that switches which *population* is listed, not which status.
 *
 * The rest of the row selects by status, which is why the approver's working set
 * could not simply be another tile: "records waiting on me or signed by me" is a
 * different question from "records in this state". Rather than give the row a
 * second filter dimension, this card flips the scope the page requests — both
 * scopes already exist as their own routes with their own gates, so there is
 * nothing new to authorise and nothing new to filter.
 */
export interface ScopeTile {
  label: string
  count: number
  /** True while the page is showing this population. */
  active: boolean
  onToggle: () => void
}

interface Props {
  tiles: SummaryTile[]
  currency: string
  /** The status filter currently applied, to compute the active tile. */
  activeStatuses: RecordStatus[]
  onSelect: (statuses: RecordStatus[]) => void
  /** Rendered first, ahead of the status tiles. See `ScopeTile`. */
  scopeTile?: ScopeTile
  /** Show the money behind each count. Off for scopes where it adds noise. */
  showAmounts?: boolean
  isLoading?: boolean
}

export function SummaryTileRow({
  tiles,
  currency,
  activeStatuses,
  onSelect,
  scopeTile,
  showAmounts = true,
  isLoading = false,
}: Props) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[86px] animate-pulse rounded-xl border bg-card"
          />
        ))}
      </div>
    )
  }

  const displayTiles = tiles.length > 0 ? tiles : [
    { key: 'all', label: 'All Expenses', count: 0, claimed_amount: '0' },
    { key: 'saved', label: 'Saved', count: 0, claimed_amount: '0' },
    { key: 'submitted', label: 'Submitted', count: 0, claimed_amount: '0' },
    { key: 'approved', label: 'Approved', count: 0, claimed_amount: '0' },
    { key: 'rejected', label: 'Rejected', count: 0, claimed_amount: '0' },
  ]

  // Match the column count to the tile count so the row never leaves a gap.
  const cardCount = displayTiles.length + (scopeTile ? 1 : 0)
  const colClass =
    cardCount >= 6
      ? 'xl:grid-cols-6'
      : cardCount === 5
        ? 'xl:grid-cols-5'
        : cardCount === 4
          ? 'xl:grid-cols-4'
          : 'xl:grid-cols-3'

  return (
    <div className={cn('grid grid-cols-2 gap-4 md:grid-cols-3', colClass)}>
      {scopeTile && (
        <button
          type="button"
          onClick={scopeTile.onToggle}
          aria-pressed={scopeTile.active}
          className={cn(
            'flex items-center gap-3 rounded-xl border px-5 py-4 text-left transition-colors',
            scopeTile.active
              ? 'border-primary/20 bg-primary/5'
              : 'bg-card hover:bg-muted/50',
          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-table-header">
            <UserCheck className="size-5 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {scopeTile.label}
            </p>
            <p className="text-2xl font-bold text-foreground">{scopeTile.count}</p>
          </div>
        </button>
      )}

      {displayTiles.map((tile) => {
        const statuses = TILE_STATUSES[tile.key] ?? []
        const Icon = TILE_ICONS[tile.key] ?? FileText
        const isActive = isTileActive(statuses, activeStatuses)

        return (
          <button
            key={tile.key}
            type="button"
            onClick={() => onSelect(isActive ? [] : statuses)}
            aria-pressed={isActive}
            className={cn(
              'flex items-center gap-3 rounded-xl border px-5 py-4 text-left transition-colors',
              isActive
                ? 'border-primary/20 bg-primary/5'
                : 'bg-card hover:bg-muted/50',
            )}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-table-header">
              <Icon className="size-5 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {tile.label}
              </p>
              <p className="text-2xl font-bold text-foreground">{tile.count}</p>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function isTileActive(
  tileStatuses: RecordStatus[],
  active: RecordStatus[],
): boolean {
  if (tileStatuses.length === 0) return active.length === 0
  if (tileStatuses.length !== active.length) return false
  return tileStatuses.every((s) => active.includes(s))
}
