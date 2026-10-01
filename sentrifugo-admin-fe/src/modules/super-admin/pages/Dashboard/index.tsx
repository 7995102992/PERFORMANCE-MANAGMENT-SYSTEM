import { Link } from "@tanstack/react-router"
import { Building2, CheckCircle2, Clock, LayoutDashboard, Users } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "@/components/shared/StatusBadge"
import { Skeleton } from "@/components/ui/skeleton"
import { useSuperAdminDashboard, useSuperAdminOrgs } from "@/hooks/queries/use-super-admin-orgs"
import { format } from "date-fns"
import type { RecentActivity } from "@/api/super-admin/types"

// ─── Donut chart ──────────────────────────────────────────────────────────────

function DonutChart({ active, pending, draft, total }: { active: number; pending: number; draft: number; total: number }) {
  const r = 42
  const C = 2 * Math.PI * r

  const safeTotal = total || 1
  const s1 = (active / safeTotal) * C
  const s2 = (pending / safeTotal) * C
  const s3 = (draft / safeTotal) * C

  const segments = [
    { len: s1, offset: 0, color: '#22C55E' },
    { len: s2, offset: -s1, color: '#f59e0b' },
    { len: s3, offset: -(s1 + s2), color: '#CBD5E1' },
  ].filter((s) => s.len > 0)

  return (
    <div className="relative flex items-center justify-center">
      <svg viewBox="0 0 100 100" className="w-36 h-36 -rotate-90">
        {/* Track */}
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="10" className="stroke-muted" />
        {total === 0 ? (
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="10" stroke="#E2E8F0" strokeDasharray={`${C} ${C}`} />
        ) : (
          segments.map((seg, i) => (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              strokeWidth="10"
              stroke={seg.color}
              strokeDasharray={`${seg.len} ${C}`}
              strokeDashoffset={seg.offset}
            />
          ))
        )}
      </svg>
      {/* Center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums leading-none">{total}</span>
        <span className="text-[10px] text-muted-foreground mt-0.5">Total</span>
      </div>
    </div>
  )
}

// ─── Activity badge ───────────────────────────────────────────────────────────

function ActivityBadge({ status }: { status: RecentActivity['status'] }) {
  if (status === 'Pending') return <StatusBadge status="pending" />
  return <StatusBadge status="active" activeLabel="Completed" />
}

function buildActivitiesFromOrgs(
  orgs: { id: string; legal_name: string; setup_status?: string | null; created_on?: string | null }[]
): RecentActivity[] {
  return orgs.slice(0, 6).map((org) => ({
    id: org.id,
    activity: org.setup_status === 'active' ? 'Organisation activated' : 'Setup in progress',
    organisation: org.legal_name,
    date: org.created_on ? format(new Date(org.created_on), 'MMM d, yyyy') : '—',
    status: org.setup_status === 'active' ? 'Completed' : 'Pending',
  }))
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function HeroSkeleton() {
  return (
    <div className="rounded-2xl px-8 py-6" style={{ background: 'linear-gradient(135deg, #191C36 0%, #1E2240 45%, #252849 100%)' }}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-36 bg-white/20" />
          <Skeleton className="h-6 w-52 bg-white/20" />
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-white/10 px-3.5 py-3 space-y-1.5">
              <Skeleton className="h-3 w-20 bg-white/20" />
              <Skeleton className="h-6 w-10 bg-white/20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function SuperAdminDashboard() {
  const { data: stats, isLoading: statsLoading } = useSuperAdminDashboard()
  const { data: orgs = [], isLoading: orgsLoading } = useSuperAdminOrgs({ limit: 10 })

  const isLoading = statsLoading || orgsLoading

  const totalOrgs   = stats?.total_organisations  ?? orgs.length
  const activeOrgs  = stats?.active_organisations ?? orgs.filter((o) => o.setup_status === 'active').length
  const pendingOrgs = stats?.pending_setup        ?? orgs.filter((o) => o.setup_status === 'pending').length
  const draftOrgs   = Math.max(0, totalOrgs - activeOrgs - pendingOrgs)
  const totalUsers  = stats?.total_users ?? 0

  const activities: RecentActivity[] = stats?.recent_activities?.length
    ? stats.recent_activities
    : buildActivitiesFromOrgs(orgs)

  const statChips = [
    { label: 'Total Users',           value: totalUsers,  icon: Users        },
    { label: 'Total Organisations',   value: totalOrgs,   icon: Building2    },
    { label: 'Active Organisations',  value: activeOrgs,  icon: CheckCircle2 },
    { label: 'Pending Setup',         value: pendingOrgs, icon: Clock        },
  ]

  const today = format(new Date(), 'EEEE, MMMM d, yyyy')

  const legendItems = [
    { label: 'Active',  value: activeOrgs,  dot: 'bg-[#22C55E]', text: 'text-badge-active-text'  },
    { label: 'Pending', value: pendingOrgs, dot: 'bg-[#f59e0b]', text: 'text-badge-pending-text' },
    { label: 'Draft',   value: draftOrgs,   dot: 'bg-slate-300', text: 'text-muted-foreground'   },
  ]

  return (
    <div className="space-y-6 p-6">

      {/* ── Hero banner ──────────────────────────────────────────────────── */}
      {isLoading ? <HeroSkeleton /> : (
        <div className="rounded-2xl px-8 py-6" style={{ background: 'linear-gradient(135deg, #191C36 0%, #2E3267 100%)' }}>

          {/* Content — single row: title left, chips right */}
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">

            {/* Title block */}
            <div className="shrink-0">
              <div className="flex items-center gap-2">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-green-400" />
                </span>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-white/55">
                  All Systems Operational
                </p>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/10">
                  <LayoutDashboard className="size-5 text-white" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-white leading-tight">Platform Overview</h1>
                  <p className="text-xs text-white/50 mt-0.5">{today}</p>
                </div>
              </div>
            </div>

            {/* Stat chips — 4 across */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:gap-3">
              {statChips.map(({ label, value, icon: Icon }) => (
                <div
                  key={label}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/10 px-3.5 py-3.5 backdrop-blur-sm transition-colors hover:bg-white/[0.16]"
                >
                  {/* Icon column */}
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
                    <Icon className="size-5 text-white" />
                  </div>
                  {/* Text column */}
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-white/60 leading-tight truncate">{label}</p>
                    <p className="text-2xl font-bold tabular-nums text-white leading-tight mt-0.5">
                      {value.toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Lower section ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* Recent Activity — 2/3 */}
        <Card className="lg:col-span-2 gap-0 py-0">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
            <span className="text-sm font-semibold">Recent Activity</span>
            <Link
              to="/super-admin/organisations"
              className="text-xs font-medium text-primary hover:underline underline-offset-4"
            >
              View all →
            </Link>
          </div>
          <CardContent className="p-4">
            <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Activity</TableHead>
                  <TableHead>Organisation</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                    </TableRow>
                  ))
                ) : activities.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                      No recent activity yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  activities.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.activity}</TableCell>
                      <TableCell>{row.organisation}</TableCell>
                      <TableCell className="text-muted-foreground">{row.date}</TableCell>
                      <TableCell><ActivityBadge status={row.status} /></TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>

        {/* Org breakdown — 1/3 */}
        <Card className="gap-0 py-0">
          <div className="px-5 py-3.5 border-b border-border">
            <span className="text-sm font-semibold">Organisation Breakdown</span>
          </div>
          <CardContent className="space-y-4 p-4">

            {isLoading ? (
              <div className="space-y-4">
                <Skeleton className="mx-auto size-36 rounded-full" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-8" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {/* SVG donut */}
                <DonutChart
                  active={activeOrgs}
                  pending={pendingOrgs}
                  draft={draftOrgs}
                  total={totalOrgs}
                />

                {/* Legend */}
                <div className="space-y-2.5">
                  {legendItems.map((item) => (
                    <div key={item.label} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`size-2.5 rounded-full ${item.dot}`} />
                        <span className="text-muted-foreground">{item.label}</span>
                      </div>
                      <span className={`font-semibold tabular-nums ${item.text}`}>
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Quick link */}
                <Link
                  to="/super-admin/organisations"
                  className="block w-full rounded-lg border border-primary/20 bg-primary/5 py-2 text-center text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                >
                  Manage Organisations →
                </Link>
              </>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
