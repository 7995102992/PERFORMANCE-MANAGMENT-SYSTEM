import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { DatePicker } from '@/components/ui/date-picker'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
  Area,
  AreaChart,
} from 'recharts'
import {
  Users,
  Clock,
  TrendingDown,
  Timer,
  AlertTriangle,
  ShieldAlert,
  CalendarCheck,
  CheckCircle,
  Flame,
  Calendar,
  BarChart3,
  Wallet,
  UserCheck,
  Loader2,
  Inbox,
} from 'lucide-react'
import { useGetManagerDashboardQuery } from '@/store/api/lmsApi'
import type { ManagerDashboardResponse } from '@/store/api/lmsApi'

// ─── Chart colors ────────────────────────────────────────────────────────────

const COLORS = {
  primary: '#6f5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  info: '#007cf0',
  muted: '#6c6f89',
  border: '#f0eff6',
}

const PIE_COLORS = [COLORS.primary, COLORS.warning, COLORS.info, '#8b5cf6', COLORS.success]

// ─── Prescriptive / Predictive static data (no backend yet) ─────────────────

const availabilityData = [
  { week: 'Jun W3', available: 78 },
  { week: 'Jun W4', available: 78 },
  { week: 'Jul W1', available: 89 },
  { week: 'Jul W2', available: 89 },
  { week: 'Jul W3', available: 67 },
  { week: 'Jul W4', available: 89 },
  { week: 'Aug W1', available: 89 },
  { week: 'Aug W2', available: 78 },
]

const burnoutTrendData = [
  { month: 'Jan', ravi: 3.2, kiran: 2.8, arjun: 2.0, sneha: 2.1 },
  { month: 'Feb', ravi: 4.1, kiran: 3.5, arjun: 2.5, sneha: 1.9 },
  { month: 'Mar', ravi: 5.0, kiran: 4.8, arjun: 2.8, sneha: 2.0 },
  { month: 'Apr', ravi: 6.2, kiran: 6.0, arjun: 3.2, sneha: 1.8 },
  { month: 'May', ravi: 7.1, kiran: 7.5, arjun: 4.0, sneha: 1.6 },
  { month: 'Jun', ravi: 8.3, kiran: 8.0, arjun: 4.2, sneha: 1.5 },
]

// ─── Shared Components ───────────────────────────────────────────────────────

function KpiCard({
  label, value, unit, subtitle, accent, icon: Icon,
}: {
  label: string; value: string; unit?: string; subtitle: string; accent: string; icon: typeof Users
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
        {value}
        {unit && <span className="text-sm font-medium text-muted-foreground ml-1">{unit}</span>}
      </p>
      <p className="text-xs text-muted-foreground mt-1.5">{subtitle}</p>
    </div>
  )
}

function RiskBadge({ risk }: { risk: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    High: { bg: 'bg-destructive/10', text: 'text-destructive' },
    Medium: { bg: 'bg-warning/10', text: 'text-warning' },
    Low: { bg: 'bg-success/10', text: 'text-success' },
  }
  const c = config[risk] ?? config.Low
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>{risk}</span>
}

function UtilizationText({ pct }: { pct: number }) {
  const color = pct >= 60 ? 'text-success' : pct >= 40 ? 'text-warning' : 'text-destructive'
  return <span className={`font-semibold ${color}`}>{pct}%</span>
}

function AlertCard({
  variant, icon: Icon, title, description, action,
}: {
  variant: 'danger' | 'warning' | 'info' | 'success'; icon: typeof AlertTriangle; title: string; description: string; action?: string
}) {
  const styles: Record<string, { border: string; bg: string; iconColor: string }> = {
    danger: { border: 'border-destructive/20', bg: 'bg-destructive/5', iconColor: 'text-destructive' },
    warning: { border: 'border-warning/20', bg: 'bg-warning/5', iconColor: 'text-warning' },
    info: { border: 'border-primary/20', bg: 'bg-primary/5', iconColor: 'text-primary' },
    success: { border: 'border-success/20', bg: 'bg-success/5', iconColor: 'text-success' },
  }
  const s = styles[variant]

  return (
    <div className={`rounded-xl border ${s.border} ${s.bg} p-5 flex gap-4`}>
      <Icon className={`size-5 shrink-0 mt-0.5 ${s.iconColor}`} />
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
        {action && <p className="text-xs font-semibold text-primary mt-2.5 cursor-pointer hover:underline">{action}</p>}
      </div>
    </div>
  )
}

function PredictionCard({
  icon: Icon, title, value, valueColor, description, confidenceLabel, confidenceValue, confidencePct, barColor,
}: {
  icon: typeof Flame; title: string; value: string; valueColor?: string; description: string
  confidenceLabel: string; confidenceValue: string; confidencePct: number; barColor?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="size-4 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </div>
      <p className={`text-2xl font-bold ${valueColor ?? 'text-primary'}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{description}</p>
      <div className="mt-4">
        <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
          <span>{confidenceLabel}</span>
          <span className="font-medium">{confidenceValue}</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-x-auto">
          <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${confidencePct}%`, backgroundColor: barColor ?? COLORS.primary }} />
        </div>
      </div>
    </div>
  )
}

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-xs text-muted-foreground">
          <span className="inline-block size-2 rounded-full mr-1.5" style={{ backgroundColor: p.color }} />
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-3">
      {children}
      <span className="flex-1 h-px bg-border" />
    </p>
  )
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  )
}

function formatWaiting(hours: number | null): { text: string; color: string } {
  if (hours == null) return { text: '—', color: 'text-muted-foreground' }
  if (hours >= 48) return { text: `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`, color: 'text-destructive' }
  if (hours >= 12) return { text: `${Math.round(hours)}h`, color: 'text-warning' }
  return { text: `${Math.round(hours)}h`, color: 'text-success' }
}

// ─── Descriptive Tab (API-driven) ────────────────────────────────────────────

function DescriptiveTab({ data }: { data: ManagerDashboardResponse }) {
  const { kpis, pending_approvals, team_utilization, monthly_chart, type_distribution } = data

  // Exited reportees are excluded by default — they still hold a balance, so
  // the manager can opt them back in rather than losing sight of them.
  const [showInactive, setShowInactive] = useState(false)
  const inactiveCount = team_utilization.filter((r) => !r.is_active).length
  const visibleTeam = showInactive ? team_utilization : team_utilization.filter((r) => r.is_active)

  const pieData = type_distribution.map((t, i) => ({
    name: t.name,
    value: t.days,
    color: PIE_COLORS[i % PIE_COLORS.length],
  }))

  const oldestLabel = kpis.oldest_pending_age_hours != null
    ? kpis.oldest_pending_age_hours >= 24
      ? `Oldest: ${Math.floor(kpis.oldest_pending_age_hours / 24)}d ${Math.round(kpis.oldest_pending_age_hours % 24)}h ago`
      : `Oldest: ${Math.round(kpis.oldest_pending_age_hours)}h ago`
    : 'No pending requests'

  const approvalSubtitle = kpis.avg_approval_time_hours != null && kpis.org_avg_approval_time_hours != null
    ? `Org benchmark: ${kpis.org_avg_approval_time_hours}h ${kpis.avg_approval_time_hours <= kpis.org_avg_approval_time_hours ? '✓' : ''}`
    : kpis.org_avg_approval_time_hours != null
      ? `Org benchmark: ${kpis.org_avg_approval_time_hours}h`
      : 'No data yet'

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Team Headcount" value={String(kpis.headcount)} subtitle={`${kpis.on_leave_today} on leave today`} accent="success" icon={Users} />
        <KpiCard label="Pending Approvals" value={String(kpis.pending_count)} subtitle={oldestLabel} accent="warning" icon={Clock} />
        <KpiCard label="Avg Team Utilization" value={`${kpis.avg_team_utilization_pct}%`} subtitle={kpis.avg_team_utilization_pct < 60 ? 'Below 60% healthy threshold' : 'Healthy'} accent={kpis.avg_team_utilization_pct < 60 ? 'destructive' : 'success'} icon={TrendingDown} />
        <KpiCard label="My Avg Approval Time" value={kpis.avg_approval_time_hours != null ? String(kpis.avg_approval_time_hours) : '—'} unit="hrs" subtitle={approvalSubtitle} accent="info" icon={Timer} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Team Leave Trend (Monthly)</p>
          <p className="text-xs text-muted-foreground mb-5">
            Total leave days consumed by team per month
            {data.window && ` · ${data.window.from_date} to ${data.window.to_date}`}
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthly_chart}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="days" name="Days Taken" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Leave Type Breakdown</p>
          <p className="text-xs text-muted-foreground mb-5">Team leave by type, in the selected range</p>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="45%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value" nameKey="name">
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                <RechartsTooltip content={<ChartTooltipContent />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[220px] text-xs text-muted-foreground">No leave taken yet</div>
          )}
        </div>
      </div>

      {/* Pending Approvals Queue — hidden for now
      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <p className="text-sm font-semibold text-foreground">Pending Approvals Queue</p>
            <p className="text-xs text-muted-foreground">Requires your action · Sorted by oldest first</p>
          </div>
          {pending_approvals.length > 0 && (
            <span className="text-xs font-semibold text-warning">{pending_approvals.length} requests awaiting action</span>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Employee</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Leave Type</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Dates</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Days</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Reason</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Waiting</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending_approvals.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState icon={Inbox} title="No pending approvals" description="All caught up!" />
                </TableCell>
              </TableRow>
            )}
            {pending_approvals.map((r) => {
              const dates = r.start_date === r.end_date
                ? r.start_date ?? '—'
                : `${r.start_date ?? '—'} – ${r.end_date ?? '—'}`
              const w = formatWaiting(r.waiting_hours)
              return (
                <TableRow key={r.id}>
                  <TableCell className="text-sm font-medium text-foreground">{r.employee_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.leave_type_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{dates}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.duration_days}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reason || '—'}</TableCell>
                  <TableCell className={`text-sm font-semibold ${w.color}`}>{w.text}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      */}

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b">
          <div>
            <p className="text-sm font-semibold text-foreground">Team Utilization Summary</p>
            <p className="text-xs text-muted-foreground">
              {visibleTeam.length} {visibleTeam.length === 1 ? 'employee' : 'employees'}
              {!showInactive && inactiveCount > 0 && ` · ${inactiveCount} inactive hidden`}
              {data.window && ` · Used in range ${data.window.from_date} to ${data.window.to_date}`}
            </p>
          </div>
          {inactiveCount > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-inactive"
                checked={showInactive}
                onCheckedChange={(checked) => setShowInactive(checked === true)}
              />
              <Label htmlFor="show-inactive" className="text-sm font-normal text-muted-foreground cursor-pointer">
                Show inactive employees
              </Label>
            </div>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Employee</TableHead>
              {showInactive && (
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Status</TableHead>
              )}
              {/* Entitled / Balance / Utilization are lifetime balance-tracker
                  totals and are NOT scoped by the date range — only Used is. */}
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Entitled (to date)</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Used in range</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Balance (current)</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Utilization</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Burnout Risk</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Last Leave</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleTeam.length === 0 && (
              <TableRow>
                <TableCell colSpan={showInactive ? 8 : 7} className="p-0">
                  <EmptyState icon={Inbox} title="No team data" description="No active reportees found." />
                </TableCell>
              </TableRow>
            )}
            {visibleTeam.map((r) => (
              <TableRow key={r.user_id}>
                <TableCell className="text-sm font-medium text-foreground">{r.employee_name}</TableCell>
                {showInactive && (
                  <TableCell><StatusBadge status={r.is_active} /></TableCell>
                )}
                <TableCell className="text-sm text-muted-foreground">{r.entitled_days}d</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.used_days}d</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.balance_days}d</TableCell>
                <TableCell className="text-sm"><UtilizationText pct={r.utilization_pct} /></TableCell>
                <TableCell><RiskBadge risk={r.burnout_risk} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.last_leave ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ─── Prescriptive Tab (uses live KPIs + static alerts) ───────────────────────

function PrescriptiveTab({ data }: { data: ManagerDashboardResponse }) {
  const { kpis, team_utilization } = data
  const highRisk = team_utilization.filter((t) => t.burnout_risk === 'High')
  const highBalance = team_utilization.filter((t) => t.balance_days > 15)

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Immediate Actions Required</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {kpis.oldest_pending_age_hours != null && kpis.oldest_pending_age_hours >= 48 && (
            <AlertCard
              variant="danger"
              icon={ShieldAlert}
              title={`SLA Breach: ${kpis.pending_count} Request${kpis.pending_count > 1 ? 's' : ''} Overdue`}
              description={`Oldest pending request has been waiting ${Math.floor(kpis.oldest_pending_age_hours / 24)}d ${Math.round(kpis.oldest_pending_age_hours % 24)}h. Company SLA is 48 hours.`}
              action="→ Go to Approval Queue"
            />
          )}
          {kpis.pending_count > 0 && (kpis.oldest_pending_age_hours == null || kpis.oldest_pending_age_hours < 48) && (
            <AlertCard
              variant="warning"
              icon={Clock}
              title={`${kpis.pending_count} Pending Approval${kpis.pending_count > 1 ? 's' : ''}`}
              description="Review and act on pending leave requests."
              action="→ Go to Approval Queue"
            />
          )}
          {highRisk.length > 0 && (
            <AlertCard
              variant="danger"
              icon={Flame}
              title={`Burnout Risk: ${highRisk.map((r) => r.employee_name.split(' ')[0]).join(' & ')}`}
              description={highRisk.map((r) => `${r.employee_name} (${r.utilization_pct}% utilization, last leave ${r.last_leave ?? 'unknown'})`).join('. ')}
              action="→ Schedule wellness check-in"
            />
          )}
          {highBalance.length > 0 && (
            <AlertCard
              variant="warning"
              icon={Calendar}
              title={`Balance Lapse Warning: ${highBalance.length} Employee${highBalance.length > 1 ? 's' : ''}`}
              description={highBalance.map((r) => `${r.employee_name} (${r.balance_days}d)`).join(', ') + ' have high balances that risk lapsing at year-end.'}
              action="→ Nudge team to plan leaves"
            />
          )}
          {kpis.avg_team_utilization_pct < 50 && (
            <AlertCard
              variant="warning"
              icon={AlertTriangle}
              title={`Low Team Utilization (${kpis.avg_team_utilization_pct}%)`}
              description="Team utilization is below 50%. Encourage employees to take leave to reduce burnout and year-end lapse risk."
              action="→ View best weeks to plan leave"
            />
          )}
          {kpis.avg_approval_time_hours != null && kpis.org_avg_approval_time_hours != null && kpis.avg_approval_time_hours <= kpis.org_avg_approval_time_hours && (
            <AlertCard
              variant="success"
              icon={CheckCircle}
              title="Your Approval SLA Is Excellent"
              description={`Your average approval latency of ${kpis.avg_approval_time_hours}h is better than the org average of ${kpis.org_avg_approval_time_hours}h.`}
            />
          )}
          <AlertCard
            variant="info"
            icon={CalendarCheck}
            title="Review Team Calendar"
            description="Check upcoming weeks for overlapping leave requests before approving."
            action="→ View team calendar"
          />
        </div>
      </div>

      <div>
        <SectionLabel>Team Availability Forecast</SectionLabel>
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Team Availability (Next 8 Weeks)</p>
          <p className="text-xs text-muted-foreground mb-5">% of team available each week</p>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={availabilityData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis domain={[50, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <defs>
                <linearGradient id="availGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS.success} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={COLORS.success} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="available" name="% Available" stroke={COLORS.success} strokeWidth={2} fill="url(#availGradient)" dot={{ r: 4, fill: COLORS.success }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

// ─── Predictive Tab (static — no backend yet) ───────────────────────────────

function PredictiveTab() {
  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Team Risk Predictions</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <PredictionCard icon={Flame} title="Attrition Risk: Ravi Kumar" value="High" valueColor="text-destructive" description="149 days without leave, 27% utilization, 3 sick leaves in last 60 days. Pre-exit signature pattern detected." confidenceLabel="Attrition Probability" confidenceValue="62%" confidencePct={62} barColor={COLORS.destructive} />
          <PredictionCard icon={Flame} title="Burnout Forecast: Kiran Patel" value="72 Days" valueColor="text-warning" description="At current trajectory, Kiran will reach critical burnout threshold in approximately 72 days if no leave is taken." confidenceLabel="Burnout Risk" confidenceValue="78%" confidencePct={78} barColor={COLORS.warning} />
          <PredictionCard icon={Calendar} title="Jul 21–25: High Absence Risk" value="33%" valueColor="text-warning" description="Based on historical patterns, 3 of 9 team members are likely to be absent that week." confidenceLabel="Confidence" confidenceValue="71%" confidencePct={71} />
          <PredictionCard icon={BarChart3} title="Team Utilization (Q3 Forecast)" value="52%" description="Without intervention, team utilization is projected to reach 52% by Sep 30 — still below the healthy 60% benchmark." confidenceLabel="Confidence" confidenceValue="80%" confidencePct={80} />
          <PredictionCard icon={Wallet} title="Year-End Lapse Risk" value="41 days" valueColor="text-destructive" description="Projected total days that will lapse across your team if leave patterns continue." confidenceLabel="Confidence" confidenceValue="75%" confidencePct={75} barColor={COLORS.destructive} />
          <PredictionCard icon={UserCheck} title="Sneha Rao: No Risk" value="Healthy" valueColor="text-success" description="60% utilization, 18 days taken YTD, last leave May 15. No burnout or flight risk signals." confidenceLabel="Health Score" confidenceValue="8.4/10" confidencePct={84} barColor={COLORS.success} />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-semibold text-foreground">Team Burnout Risk Score Trend (6 Months)</p>
        <p className="text-xs text-muted-foreground mb-5">Composite score per employee · Lower is healthier</p>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={burnoutTrendData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <RechartsTooltip content={<ChartTooltipContent />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="ravi" name="Ravi Kumar" stroke={COLORS.destructive} strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="kiran" name="Kiran Patel" stroke={COLORS.warning} strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="arjun" name="Arjun Sharma" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="sneha" name="Sneha Rao" stroke={COLORS.success} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

// Default window matches the backend's: current financial year (1 Apr) to today.
function currentFyStart(today: Date) {
  const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  return `${year}-04-01`
}

export default function ManagerDashboard() {
  const today = useMemo(() => new Date(), [])
  const [fromDate, setFromDate] = useState(() => currentFyStart(today))
  const [toDate, setToDate] = useState(() => format(today, 'yyyy-MM-dd'))

  const { data, isLoading, isError, isFetching } = useGetManagerDashboardQuery({
    from_date: fromDate,
    to_date: toDate,
  })

  const dateRange = (
    <div className="flex items-center gap-2">
      <DatePicker
        value={fromDate}
        onChange={(v) => {
          if (!v) return
          setFromDate(v)
          // Keep the range valid: push "To" out if it now precedes "From".
          if (toDate < v) setToDate(v)
        }}
        placeholder="From date"
        className="w-[150px]"
      />
      <span className="text-muted-foreground">–</span>
      <DatePicker
        value={toDate}
        onChange={(v) => { if (v) setToDate(v) }}
        min={fromDate}
        placeholder="To date"
        className="w-[150px]"
      />
    </div>
  )

  if (isLoading) return (
    <div className="p-6 space-y-6">
      <PageHeader title="Team Leave Analytics" subtitle="Team leave insights and approval analytics" action={dateRange} />
      <LoadingState />
    </div>
  )

  if (isError || !data) return (
    <div className="p-6 space-y-6">
      <PageHeader title="Team Leave Analytics" subtitle="Team leave insights and approval analytics" action={dateRange} />
      <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="There was an error fetching team data. Please try again." />
    </div>
  )

  return (
    <div className={`p-6 space-y-6 ${isFetching ? 'opacity-60 transition-opacity' : ''}`}>
      <PageHeader
        title="Team Leave Analytics"
        subtitle={`${data.kpis.headcount} direct reports`}
        action={dateRange}
      />

      <Tabs defaultValue="descriptive">
        <TabsList>
          <TabsTrigger value="descriptive">Descriptive</TabsTrigger>
          <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span><TabsTrigger value="prescriptive" disabled className="opacity-50 cursor-not-allowed">Prescriptive</TabsTrigger></span></TooltipTrigger><TooltipContent>Coming soon</TooltipContent></Tooltip></TooltipProvider>
          <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span><TabsTrigger value="predictive" disabled className="opacity-50 cursor-not-allowed">Predictive</TabsTrigger></span></TooltipTrigger><TooltipContent>Coming soon</TooltipContent></Tooltip></TooltipProvider>
        </TabsList>

        <TabsContent value="descriptive" className="mt-6">
          <DescriptiveTab data={data} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
