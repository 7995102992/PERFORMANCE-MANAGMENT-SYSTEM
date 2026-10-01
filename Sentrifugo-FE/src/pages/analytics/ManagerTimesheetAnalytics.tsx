import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import {
  Clock, AlertTriangle, CheckCircle, Timer, Inbox, Loader2,
} from 'lucide-react'
import { useGetManagerAnalyticsQuery } from '@/store/api/timesheetApi'

const COLORS = {
  primary: '#6f5cff', success: '#22c55e', warning: '#f59e0b',
  destructive: '#ef4444', info: '#007cf0', muted: '#6c6f89', border: '#f0eff6',
  orange: '#f97316', cyan: '#06b6d4',
}
const PROJECT_COLORS = [COLORS.info, '#6366f1', '#818cf8', COLORS.warning, '#ec4899', COLORS.muted, COLORS.primary, COLORS.success]

function KpiCard({ label, value, unit, accent, icon: Icon, breakdownRows }: {
  label: string; value: string; unit?: string; accent: string; icon: typeof Clock
  breakdownRows?: Array<{ label: string; value: string; color: string }>
}) {
  const borders: Record<string, string> = { primary: 'border-t-primary', success: 'border-t-success', warning: 'border-t-warning', destructive: 'border-t-destructive', info: 'border-t-info' }
  const texts: Record<string, string> = { primary: 'text-primary', success: 'text-success', warning: 'text-warning', destructive: 'text-destructive', info: 'text-info' }
  return (
    <div className={`rounded-xl border border-t-[3px] ${borders[accent]} bg-card p-5 transition-shadow hover:shadow-md`}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        <Icon className={`size-5 ${texts[accent]}`} />
      </div>
      <p className={`text-3xl font-bold ${texts[accent]}`}>
        {value}{unit && <span className="text-sm font-medium text-muted-foreground ml-1">{unit}</span>}
      </p>
      {breakdownRows && breakdownRows.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border space-y-1.5">
          {breakdownRows.map((r) => (
            <div key={r.label} className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-bold" style={{ color: r.color }}>{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusBadgeInline({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    submitted: { bg: 'bg-primary/10', text: 'text-primary', label: 'Submitted' },
    approved: { bg: 'bg-success/10', text: 'text-success', label: 'Approved' },
    l1_approved: { bg: 'bg-success/10', text: 'text-success', label: 'Approved' },
    client_approved: { bg: 'bg-success/10', text: 'text-success', label: 'Client Approved' },
    draft: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Draft' },
    no_timesheet: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'No Timesheet' },
    rejected: { bg: 'bg-destructive/10', text: 'text-destructive', label: 'Rejected' },
    l1_rejected: { bg: 'bg-destructive/10', text: 'text-destructive', label: 'Rejected' },
    resubmitted: { bg: 'bg-warning/10', text: 'text-warning', label: 'Resubmitted' },
  }
  const c = config[status] ?? config.draft
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>{c.label}</span>
}

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p) => <p key={p.name} className="text-xs text-muted-foreground"><span className="inline-block size-2 rounded-full mr-1.5" style={{ backgroundColor: p.color }} />{p.name}: {p.value}</p>)}
    </div>
  )
}

function getHeatmapCellStyle(hours: number): { textColor: string; badgeBg: string; badgeText: string } {
  if (hours > 170) return { textColor: '#fbbf24', badgeBg: 'rgba(245,158,11,0.15)', badgeText: '#fbbf24' }
  if (hours >= 150) return { textColor: '#7dd3fc', badgeBg: 'rgba(56,189,248,0.15)', badgeText: '#7dd3fc' }
  return { textColor: '#f87171', badgeBg: 'rgba(239,68,68,0.15)', badgeText: '#f87171' }
}

function DescriptiveTab() {
  const { data, isLoading, error } = useGetManagerAnalyticsQuery()
  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !data) return <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="Could not fetch analytics data. Please try again later." />

  const kpis = (data.kpis ?? {}) as Record<string, number>
  const teamMembers = (data.team_members ?? []) as Array<Record<string, unknown>>
  const monthlyProjectHours = (data.monthly_project_hours ?? []) as Array<Record<string, unknown>>
  const projectNames = (data.project_names ?? []) as string[]
  const heatmap = (data.heatmap ?? []) as Array<Record<string, unknown>>
  const heatmapMonths = (data.heatmap_months ?? []) as string[]

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Team Hours (YTD)" value={kpis.team_hours_ytd?.toLocaleString() ?? '0'} unit="hrs" accent="info" icon={Clock}
          breakdownRows={[
            { label: 'Billable', value: `${kpis.billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.success },
            { label: 'Non-Billable', value: `${kpis.non_billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.muted },
          ]} />
        <KpiCard label="Pending Approvals" value={String(kpis.pending_approvals ?? 0)} accent="warning" icon={Timer}
          breakdownRows={[
            { label: 'L1 Pending', value: String(kpis.l1_pending ?? 0), color: '#fbbf24' },
            { label: 'Resubmitted', value: String(kpis.resubmitted ?? 0), color: COLORS.orange },
          ]} />
        <KpiCard label="Team Compliance" value={`${kpis.team_compliance_pct ?? 0}%`} accent="success" icon={CheckCircle}
          breakdownRows={[
            { label: 'On-Time', value: `${kpis.on_time_count ?? 0}/${kpis.total_submissions ?? 0}`, color: COLORS.success },
          ]} />
        <KpiCard label="Team Shortage" value={String(kpis.team_shortage_hours ?? 0)} unit="hrs" accent="destructive" icon={AlertTriangle}
          breakdownRows={[
            { label: 'Employees Affected', value: String(kpis.affected_employees ?? 0), color: '#f87171' },
            { label: 'Penalty Deducted', value: `${kpis.penalty_hours ?? 0} hrs`, color: '#f87171' },
          ]} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4">
        <div className="rounded-xl border overflow-x-auto bg-card">
          <div className="px-5 py-4 border-b">
            <p className="text-sm font-semibold text-foreground">Team Members</p>
            <p className="text-xs text-muted-foreground">Current week status · {teamMembers.length} direct reports</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Employee</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">This Week Hrs</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Billable %</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teamMembers.length === 0 && <TableRow><TableCell colSpan={4} className="p-0"><EmptyState icon={Inbox} title="No team members" description="No direct reports found." /></TableCell></TableRow>}
              {teamMembers.map((m) => {
                const bp = m.billable_pct as number
                const bColor = bp >= 80 ? 'text-success' : bp >= 75 ? 'text-warning' : 'text-destructive'
                return (
                  <TableRow key={m.user_id as string}>
                    <TableCell>
                      <div className="text-sm font-medium text-foreground">{m.name as string}</div>
                      <div className="text-xs text-muted-foreground">{m.role as string}</div>
                    </TableCell>
                    <TableCell className="text-sm text-foreground">{(m.week_hours as number).toFixed(1)}</TableCell>
                    <TableCell className={`text-sm font-semibold ${bColor}`}>{bp}%</TableCell>
                    <TableCell><StatusBadgeInline status={m.status as string} /></TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
          <p className="text-sm font-semibold text-foreground">Monthly Hours by Project</p>
          <p className="text-xs text-muted-foreground mb-5">Team-level project breakdown · Current FY</p>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyProjectHours} stackOffset="none">
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltipContent />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                {projectNames.map((name, i) => (
                  <Bar key={name} dataKey={name} name={name} stackId="stack" fill={PROJECT_COLORS[i % PROJECT_COLORS.length]} radius={i === projectNames.length - 1 ? [4, 4, 0, 0] : undefined} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {heatmap.length > 0 && (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-5">
            <p className="text-sm font-semibold text-foreground">Team Utilization Heatmap</p>
            <p className="text-xs text-muted-foreground">Hours & utilization % per team member · Monthly · Target: 160h/month</p>
          </div>
          <div className="overflow-x-auto">
            <div className="grid min-w-[700px]" style={{ gridTemplateColumns: `160px repeat(${heatmapMonths.length}, 1fr)` }}>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-3 py-2 border-b border-border text-left">Team Member</div>
              {heatmapMonths.map((m) => <div key={m} className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-3 py-2 border-b border-border text-center">{m}</div>)}
              {heatmap.map((member) => {
                const months = (member.months ?? []) as Array<{ month: string; hours: number; utilization_pct: number }>
                return (
                  <div key={member.name as string} className="contents">
                    <div className="px-3 py-2.5 border-b border-border/40 flex items-center">
                      <div>
                        <div className="text-xs font-semibold text-foreground">{member.name as string}</div>
                        <div className="text-[10px] text-muted-foreground">{member.role as string}</div>
                      </div>
                    </div>
                    {months.map((cell, i) => {
                      const style = getHeatmapCellStyle(cell.hours)
                      return (
                        <div key={i} className="px-2 py-2.5 border-b border-border/40 text-center flex flex-col items-center justify-center gap-1">
                          <span className="text-sm font-extrabold" style={{ color: style.textColor }}>{cell.hours}h</span>
                          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ backgroundColor: style.badgeBg, color: style.badgeText }}>{cell.utilization_pct}%</span>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-end gap-5 mt-3">
            <div className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ backgroundColor: '#3b82f6' }} /><span className="text-[10px] text-muted-foreground font-medium">On Target (150–170h)</span></div>
            <div className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ backgroundColor: '#fbbf24' }} /><span className="text-[10px] text-muted-foreground font-medium">Over Target (&gt;170h)</span></div>
            <div className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ backgroundColor: '#f87171' }} /><span className="text-[10px] text-muted-foreground font-medium">Below Target (&lt;150h)</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

export function ManagerTimesheetContent() {
  return (
    <Tabs defaultValue="descriptive">
      <TabsList>
        <TabsTrigger value="descriptive">Descriptive</TabsTrigger>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span><TabsTrigger value="prescriptive" disabled className="opacity-50 cursor-not-allowed">Prescriptive</TabsTrigger></span></TooltipTrigger><TooltipContent>Coming soon</TooltipContent></Tooltip></TooltipProvider>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span><TabsTrigger value="predictive" disabled className="opacity-50 cursor-not-allowed">Predictive</TabsTrigger></span></TooltipTrigger><TooltipContent>Coming soon</TooltipContent></Tooltip></TooltipProvider>
      </TabsList>
      <TabsContent value="descriptive" className="mt-6"><DescriptiveTab /></TabsContent>
    </Tabs>
  )
}

export default function ManagerTimesheetAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Team Timesheet Analytics" subtitle="Manager dashboard" />
      <ManagerTimesheetContent />
    </div>
  )
}
