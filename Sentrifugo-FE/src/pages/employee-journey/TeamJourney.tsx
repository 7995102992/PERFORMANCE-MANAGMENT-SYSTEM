import { useMemo, useState } from 'react'
import { Users, Milestone, Clock, Ticket, AlertTriangle, RefreshCw } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useAppSelector } from '@/store'
import {
  useGetTeamJourneyQuery,
  useGetMemberJourneyQuery,
} from '@/store/api/employeeJourneyApi'
import type { TeamMember, TeamMemberJourney } from '@/types/employee-journey'
import { JourneyView } from './JourneyView'

// "2024-01-15T..." → "15-Jan-2024". Returns null on missing/invalid dates.
function formatDate(iso: string | null): string | null {
  if (!iso) return null
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

// Name & code come straight from the API; designation is derived from the timeline.
function toMember(userId: string, journey: TeamMemberJourney): TeamMember {
  const designationEvent = journey.timeline.find(
    (e) => e.event_type === 'designation_assigned',
  )
  const metric = journey.metrics[0]
  const latestEvent = journey.timeline[0]

  return {
    userId,
    name: journey.name || 'Unknown member',
    empCode: journey.emp_code ?? null,
    designation: (designationEvent?.metadata?.designation_name as string) ?? null,
    eventCount: journey.timeline.length,
    latest: latestEvent
      ? { title: latestEvent.title, date: formatDate(latestEvent.occurred_at) }
      : null,
    workedHours: metric?.worked_hours ?? null,
    serviceRequests: metric?.service_requests_count ?? null,
  }
}

/**
 * The member's current L1 / L2 manager ids, read off their own timeline.
 *
 * Nothing else on this page can supply them: `/journey/team` returns no manager
 * field, `/employees/` is core_hr-gated, and `/directory` is scoped to the
 * caller's own business unit — which silently drops cross-BU reports. The
 * timeline is not so limited, and the IAM consumer stamps the manager id into
 * the metadata of every l1/l2 assigned-or-changed event. Timelines arrive
 * newest-first, so the first match is the current holder.
 */
function managerIdsOf(journey: TeamMemberJourney): {
  l1: string | null
  l2: string | null
} {
  let l1: string | null = null
  let l2: string | null = null
  for (const event of journey.timeline) {
    if (l1 === null && (event.event_type === 'l1_assigned' || event.event_type === 'l1_changed')) {
      l1 = (event.metadata?.l1_manager_id as string) ?? null
    }
    if (l2 === null && (event.event_type === 'l2_assigned' || event.event_type === 'l2_changed')) {
      l2 = (event.metadata?.l2_manager_id as string) ?? null
    }
    if (l1 !== null && l2 !== null) break
  }
  return { l1, l2 }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase() || '?'
}

type StatusFilter = 'active' | 'inactive' | 'all'
type ReportingFilter = 'l1' | 'l2' | 'both'

export default function TeamJourney() {
  // Active by default: the page is about the current team, and past employees
  // are pulled in only when the filter asks for them.
  const [status, setStatus] = useState<StatusFilter>('active')
  const [reporting, setReporting] = useState<ReportingFilter>('both')
  const [selected, setSelected] = useState<{ userId: string; name: string } | null>(null)

  const myUserId = useAppSelector((s) => s.auth.user?.id) ?? ''

  const needsInactive = status !== 'active'

  // /journey/team carries no per-member status — `active_only` only narrows the
  // set it returns. So membership of the active result IS the active flag, and
  // splitting active from inactive means holding both sets. The unfiltered call
  // is skipped while the filter is "Active", keeping the default view at one
  // request.
  const activeQuery = useGetTeamJourneyQuery({ includeSelf: false, activeOnly: true })
  const allQuery = useGetTeamJourneyQuery(
    { includeSelf: false, activeOnly: false },
    { skip: !needsInactive },
  )

  const isLoading = activeQuery.isLoading || (needsInactive && allQuery.isLoading)
  const isError = activeQuery.isError || (needsInactive && allQuery.isError)
  const isFetching = activeQuery.isFetching || (needsInactive && allQuery.isFetching)
  const refetch = () => {
    activeQuery.refetch()
    if (needsInactive) allQuery.refetch()
  }

  const members = useMemo(() => {
    const reportsToMe = (journey: TeamMemberJourney) => {
      if (!myUserId) return true
      const { l1, l2 } = managerIdsOf(journey)
      if (reporting === 'l1') return l1 === myUserId
      if (reporting === 'l2') return l2 === myUserId
      return l1 === myUserId || l2 === myUserId
    }

    const toMembers = (data: typeof activeQuery.data) =>
      Object.entries(data ?? {})
        .filter(([, journey]) => reportsToMe(journey))
        .map(([userId, journey]) => toMember(userId, journey))
        // Object key order is arbitrary; sort so the grid is stable between
        // fetches and the two groups read as ordered lists.
        .sort((a, b) => a.name.localeCompare(b.name))

    const activeMembers = toMembers(activeQuery.data)
    if (status === 'active') return activeMembers

    const activeIds = new Set(Object.keys(activeQuery.data ?? {}))
    const inactiveMembers = toMembers(
      Object.fromEntries(
        Object.entries(allQuery.data ?? {}).filter(([userId]) => !activeIds.has(userId)),
      ),
    )
    if (status === 'inactive') return inactiveMembers

    // "All": active first, inactive after — one continuous grid.
    return [...activeMembers, ...inactiveMembers]
  }, [status, reporting, myUserId, activeQuery.data, allQuery.data])

  const reportingLabel =
    reporting === 'l1' ? 'L1' : reporting === 'l2' ? 'L2' : 'L1 or L2'
  const emptyCopy =
    status === 'inactive'
      ? {
          title: 'No past team members',
          description: `Reports who have exited and had you as their ${reportingLabel} manager will appear here.`,
        }
      : {
          title: 'No team members yet',
          description: `When people have you as their ${reportingLabel} manager, their journeys will appear here.`,
        }

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <Label htmlFor="team-reporting" className="text-sm font-normal text-muted-foreground">
          Reporting
        </Label>
        <Select
          value={reporting}
          onValueChange={(v) => setReporting(v as ReportingFilter)}
          disabled={isFetching}
        >
          <SelectTrigger id="team-reporting" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="l1">Only L1 reporting</SelectItem>
            <SelectItem value="l2">Only L2 reporting</SelectItem>
            <SelectItem value="both">L1 and L2 reporting</SelectItem>
          </SelectContent>
        </Select>

        <Label htmlFor="team-status" className="text-sm font-normal text-muted-foreground">
          Status
        </Label>
        <Select
          value={status}
          onValueChange={(v) => setStatus(v as StatusFilter)}
          // Switching swaps the whole grid, so block the picker mid-flight
          // rather than letting a second change race the first.
          disabled={isFetching}
        >
          <SelectTrigger id="team-status" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <CardGrid>
          {Array.from({ length: 8 }).map((_, i) => (
            <MemberCardSkeleton key={i} />
          ))}
        </CardGrid>
      ) : isError ? (
        <div className="rounded-xl border bg-card p-6">
          <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="size-5 text-destructive" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Couldn't load your team</p>
              <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">
                Something went wrong while fetching team journeys. Please try again.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
              Retry
            </Button>
          </div>
        </div>
      ) : members.length === 0 ? (
        <div className="rounded-xl border bg-card p-6">
          <EmptyState
            icon={Users}
            title={emptyCopy.title}
            description={emptyCopy.description}
          />
        </div>
      ) : (
        <CardGrid>
          {members.map((m) => (
            <MemberCard
              key={m.userId}
              member={m}
              onSelect={() => setSelected({ userId: m.userId, name: m.name })}
            />
          ))}
        </CardGrid>
      )}

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          side="right"
          className="flex w-screen flex-col gap-0 p-0 sm:max-w-[820px]"
        >
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle>{selected?.name ?? 'Journey'}</SheetTitle>
            <SheetDescription>Milestones, most recent first</SheetDescription>
          </SheetHeader>
          {selected && <MemberJourneyBody userId={selected.userId} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}

// Fetches one member's journey and renders it in the shared timeline view.
function MemberJourneyBody({ userId }: { userId: string }) {
  const { data, isLoading, isError, isFetching, refetch } = useGetMemberJourneyQuery(userId)
  return (
    <JourneyView
      events={data?.timeline ?? []}
      isLoading={isLoading}
      isError={isError}
      isFetching={isFetching}
      onRetry={refetch}
      emptyDescription="This member's milestones will appear here as they happen."
    />
  )
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  )
}

function MemberCard({ member, onSelect }: { member: TeamMember; onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className="flex cursor-pointer flex-col rounded-xl border bg-card p-5 outline-none transition-all hover:border-primary/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* identity */}
      <div className="flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {initialsOf(member.name)}
        </div>
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-foreground">{member.name}</p>
          <p className="break-words text-xs text-muted-foreground">
            {[member.empCode, member.designation].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
      </div>

      {/* stats */}
      <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border bg-muted/30 p-2 text-center">
        <Stat icon={Milestone} value={member.eventCount} label="Events" />
        <Stat
          icon={Clock}
          value={member.workedHours != null ? Math.round(member.workedHours) : '—'}
          label="Hours"
        />
        <Stat icon={Ticket} value={member.serviceRequests ?? '—'} label="Requests" />
      </div>

      {/* latest activity */}
      <div className="mt-4 border-t pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Latest
        </p>
        {member.latest ? (
          <div className="mt-1">
            <p className="break-words text-sm font-medium text-foreground">{member.latest.title}</p>
            {member.latest.date && (
              <p className="text-xs text-muted-foreground">{member.latest.date}</p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">No activity yet</p>
        )}
      </div>
    </div>
  )
}

function Stat({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Clock
  value: number | string
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-sm font-semibold text-foreground">{value}</span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  )
}

function MemberCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="mt-4 h-14 w-full rounded-xl" />
      <div className="mt-4 space-y-2 border-t pt-3">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-4 w-36" />
      </div>
    </div>
  )
}
