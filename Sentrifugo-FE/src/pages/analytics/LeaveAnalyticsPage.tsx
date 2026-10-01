import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/shared/PageHeader'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/shared/EmptyState'
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
  CalendarDays,
  CheckCircle,
  Clock,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Lightbulb,
  CalendarCheck,
  ShieldAlert,
  Timer,
  Calendar,
  Flame,
  Wallet,
  BarChart3,
  Loader2,
  Inbox,
} from 'lucide-react'
import { useGetLeaveAnalyticsEmployeeDashboardQuery } from '@/store/api/lmsApi'
import type { LeaveAnalyticsEmployeeDashboardResponse } from '@/store/api/lmsApi'

// ─── Chart colors (from design tokens) ──────────────────────────────────────

const COLORS = {
  primary: '#6f5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  info: '#007cf0',
  muted: '#6c6f89',
  border: '#f0eff6',
}

const PIE_COLORS = [COLORS.primary, COLORS.success, COLORS.warning, COLORS.info, COLORS.destructive]

const BAR_COLORS = [COLORS.primary, COLORS.success, COLORS.warning, COLORS.info, COLORS.destructive]

// ─── Prescriptive / Predictive static data (no backend yet) ─────────────────

const projectionData = [
  { month: 'Jun', current: 18.5, recommended: 18.5, limit: 15 },
  { month: 'Jul', current: 20, recommended: 18, limit: 15 },
  { month: 'Aug', current: 21.5, recommended: 16.5, limit: 15 },
  { month: 'Sep', current: 23, recommended: 18, limit: 15 },
  { month: 'Oct', current: 21, recommended: 16, limit: 15 },
  { month: 'Nov', current: 22.5, recommended: 17.5, limit: 15 },
  { month: 'Dec', current: 24, recommended: 15, limit: 15 },
]

const forecastData = [
  { month: 'Jul', balance: 20 },
  { month: 'Aug', balance: 18.5 },
  { month: 'Sep', balance: 21.5 },
  { month: 'Oct', balance: 20 },
  { month: 'Nov', balance: 22 },
  { month: 'Dec', balance: 16.5 },
]

// ─── Status badge for table ─────────────────────────────────────────────────

function RequestStatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  const config: Record<string, { bg: string; text: string; label: string }> = {
    approved: { bg: 'bg-badge-active-bg', text: 'text-success', label: 'Approved' },
    pending: { bg: 'bg-badge-pending-bg', text: 'text-warning', label: 'Pending' },
    rejected: { bg: 'bg-badge-reject-bg', text: 'text-destructive', label: 'Rejected' },
    cancelled: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Cancelled' },
  }
  const c = config[normalized] ?? config.cancelled
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>
      {normalized === 'approved' && <CheckCircle className="size-3" />}
      {normalized === 'pending' && <Clock className="size-3" />}
      {c.label}
    </span>
  )
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  unit,
  subtitle,
  trend,
  trendDir,
  accent,
  icon: Icon,
}: {
  label: string
  value: string
  unit?: string
  subtitle: string
  trend: string
  trendDir?: 'up' | 'down' | 'neutral'
  accent: string
  icon: typeof CalendarDays
}) {
  const accentBorder: Record<string, string> = {
    primary: 'border-t-primary',
    success: 'border-t-success',
    warning: 'border-t-warning',
    destructive: 'border-t-destructive',
  }
  const accentText: Record<string, string> = {
    primary: 'text-primary',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  }

  return (
    <div className={`rounded-xl border border-t-[3px] ${accentBorder[accent]} bg-card p-5 transition-shadow hover:shadow-md`}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        <Icon className={`size-5 ${accentText[accent]}`} />
      </div>
      <p className={`text-3xl font-bold ${accentText[accent]}`}>
        {value}
        {unit && <span className="text-sm font-medium text-muted-foreground ml-1">{unit}</span>}
      </p>
      <p className="text-xs text-muted-foreground mt-1.5">{subtitle}</p>
      <p className={`text-xs font-semibold mt-1 ${trendDir === 'up' ? 'text-success' : trendDir === 'down' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {trendDir === 'up' && <TrendingUp className="size-3 inline mr-1" />}
        {trendDir === 'down' && <TrendingDown className="size-3 inline mr-1" />}
        {trend}
      </p>
    </div>
  )
}

// ─── Alert Card ──────────────────────────────────────────────────────────────

function AlertCard({
  variant,
  icon: Icon,
  title,
  description,
  action,
}: {
  variant: 'danger' | 'warning' | 'info' | 'success'
  icon: typeof AlertTriangle
  title: string
  description: string
  action: string
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
        <p className="text-xs font-semibold text-primary mt-2.5 cursor-pointer hover:underline">{action}</p>
      </div>
    </div>
  )
}

// ─── Prediction Card ─────────────────────────────────────────────────────────

function PredictionCard({
  icon: Icon,
  title,
  value,
  valueColor,
  description,
  confidenceLabel,
  confidenceValue,
  confidencePct,
  barColor,
}: {
  icon: typeof CheckCircle
  title: string
  value: string
  valueColor?: string
  description: string
  confidenceLabel: string
  confidenceValue: string
  confidencePct: number
  barColor?: string
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
          <div
            className="h-full rounded-full transition-all duration-1000"
            style={{ width: `${confidencePct}%`, backgroundColor: barColor ?? COLORS.primary }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Chart tooltip ───────────────────────────────────────────────────────────

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

// ─── Loading spinner ─────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  )
}

// ─── Descriptive Tab ─────────────────────────────────────────────────────────

function DescriptiveTab({ data }: { data: LeaveAnalyticsEmployeeDashboardResponse }) {
  const { kpis, balance_bars, monthly_chart, type_distribution, recent_requests } = data

  const pieData = type_distribution.map((t, i) => ({
    name: t.name,
    value: t.days,
    color: PIE_COLORS[i % PIE_COLORS.length],
  }))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Total Balance"
          value={String(kpis.total_balance_days)}
          unit="days"
          subtitle="Across all leave types"
          trend={kpis.total_entitled_days > 0 ? `${kpis.total_entitled_days} days entitled` : ''}
          trendDir="up"
          accent="primary"
          icon={CalendarDays}
        />
        <KpiCard
          label="Days Used YTD"
          value={String(kpis.days_used_ytd)}
          subtitle={`Out of ${kpis.total_entitled_days} entitled days`}
          trend={`${kpis.utilization_pct}% utilization`}
          trendDir={kpis.utilization_pct < 50 ? 'down' : 'up'}
          accent="success"
          icon={CheckCircle}
        />
        <KpiCard
          label="Pending Requests"
          value={String(kpis.pending_count)}
          subtitle={`${kpis.pending_days} days pending approval`}
          trend={kpis.pending_count > 0 ? 'Awaiting manager action' : 'No pending requests'}
          trendDir="neutral"
          accent="warning"
          icon={Clock}
        />
        <KpiCard
          label="Days Expiring"
          value={String(kpis.days_expiring)}
          subtitle={kpis.carry_forward_limit != null ? `Carry-forward limit: ${kpis.carry_forward_limit}` : 'At year-end'}
          trend={kpis.days_expiring > 0 ? 'Above carry-forward limit' : 'Within carry-forward limit'}
          trendDir={kpis.days_expiring > 0 ? 'down' : 'up'}
          accent="destructive"
          icon={AlertTriangle}
        />
      </div>

      <div>
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-3">
          Leave Balances by Type
          <span className="flex-1 h-px bg-border" />
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">Monthly Leave Consumption</p>
            <p className="text-xs text-muted-foreground mb-5">Days taken per month · Current leave year</p>
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
            <p className="text-sm font-semibold text-foreground">Leave Type Distribution</p>
            <p className="text-xs text-muted-foreground mb-5">Breakdown of leaves taken YTD</p>
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
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-semibold text-foreground mb-1">Balance by Leave Type</p>
        <p className="text-xs text-muted-foreground mb-5">Entitlement · Used · Available</p>
        <div className="space-y-4">
          {balance_bars.map((b, i) => (
            <div key={b.leave_type_id}>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-medium text-foreground">
                  {b.leave_type_name}
                  {b.leave_type_code && ` (${b.leave_type_code})`}
                </span>
                <span className="text-muted-foreground">{b.used_days}/{b.entitled_days} used · {b.available_days} left</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-x-auto">
                <div
                  className="h-full rounded-full transition-all duration-1000"
                  style={{ width: `${Math.min(b.usage_pct, 100)}%`, backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }}
                />
              </div>
            </div>
          ))}
          {balance_bars.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No balance data available</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="px-5 py-4 border-b">
          <p className="text-sm font-semibold text-foreground">Recent Leave Requests</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Leave Type</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Dates</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Duration</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Status</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Approval Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent_requests.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState icon={Inbox} title="No requests yet" description="Your leave requests will appear here." />
                </TableCell>
              </TableRow>
            )}
            {recent_requests.map((r) => {
              const dates = r.start_date === r.end_date
                ? r.start_date ?? '—'
                : `${r.start_date ?? '—'} – ${r.end_date ?? '—'}`
              const duration = r.duration_days === 1 ? '1 day' : `${r.duration_days} days`
              const latency = r.approval_latency_hours != null
                ? `${r.approval_latency_hours} hrs`
                : '—'

              return (
                <TableRow key={r.id}>
                  <TableCell className="text-sm text-foreground">{r.leave_type_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{dates}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{duration}</TableCell>
                  <TableCell><RequestStatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{latency}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ─── Prescriptive Tab (static — no backend yet) ─────────────────────────────

function PrescriptiveTab({ kpis }: { kpis: LeaveAnalyticsEmployeeDashboardResponse['kpis'] }) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-3">
          Recommended Actions
          <span className="flex-1 h-px bg-border" />
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {kpis.days_expiring > 0 && (
            <AlertCard
              variant="danger"
              icon={ShieldAlert}
              title={`${kpis.days_expiring} Days Will Expire at Year-End`}
              description={`You have ${kpis.days_expiring} days above the carry-forward limit of ${kpis.carry_forward_limit ?? '—'} days. These will lapse if not taken.`}
              action="→ Plan leave before year-end"
            />
          )}
          {kpis.utilization_pct < 50 && (
            <AlertCard
              variant="warning"
              icon={AlertTriangle}
              title={`Low Leave Utilization (${kpis.utilization_pct}%)`}
              description={`You've used only ${kpis.days_used_ytd} of your ${kpis.total_entitled_days} entitled days.`}
              action="→ View best weeks to plan leave"
            />
          )}
          <AlertCard
            variant="info"
            icon={CalendarCheck}
            title="Best Time to Apply: July 14–18"
            description="Your team has the lowest leave density in the week of Jul 14. High chance of approval."
            action="→ Apply for this week"
          />
          {kpis.pending_count > 0 && (
            <AlertCard
              variant="success"
              icon={CheckCircle}
              title={`${kpis.pending_count} Pending Request${kpis.pending_count > 1 ? 's' : ''}`}
              description={`${kpis.pending_days} days awaiting approval.`}
              action="→ View pending requests"
            />
          )}
          <AlertCard
            variant="info"
            icon={Lightbulb}
            title="Combine with Public Holiday"
            description="Independence Day (Aug 15) is a Friday. Taking Aug 11–14 (4 EL days) gives you a 9-day break with just 4 days leave."
            action="→ Apply for Aug 11–14"
          />
          <AlertCard
            variant="warning"
            icon={Clock}
            title="Review Your Leave Types"
            description="Check which leave types have low remaining balance and plan accordingly."
            action="→ Review leave types"
          />
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-3">
          Year-End Simulation
          <span className="flex-1 h-px bg-border" />
        </p>
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Balance Projection: Now → Dec 31</p>
          <p className="text-xs text-muted-foreground mb-5">Based on current accrual schedule and no additional leave taken</p>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={projectionData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="current" name="Current trajectory" stroke={COLORS.destructive} strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} />
              <Line type="monotone" dataKey="recommended" name="With recommended leaves" stroke={COLORS.primary} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="limit" name="Carry-forward limit" stroke={COLORS.warning} strokeWidth={1} strokeDasharray="3 3" dot={false} />
            </LineChart>
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
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-3">
          AI-Powered Predictions
          <span className="flex-1 h-px bg-border" />
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <PredictionCard icon={CheckCircle} title="Approval Likelihood" value="91%" description="Your pending EL request has a high chance of approval based on manager history and team availability." confidenceLabel="Confidence" confidenceValue="High" confidencePct={91} />
          <PredictionCard icon={Timer} title="Expected Approval Time" value="~8 hrs" description="Based on manager's median approval latency." confidenceLabel="Confidence" confidenceValue="Medium" confidencePct={72} />
          <PredictionCard icon={Calendar} title="Year-End Balance" value="16.5 days" description="Projected Dec 31 balance if no more leave is taken." confidenceLabel="Confidence" confidenceValue="High" confidencePct={85} />
          <PredictionCard icon={Flame} title="Burnout Risk Score" value="Medium" valueColor="text-warning" description="Based on utilization rate and time since last consecutive break." confidenceLabel="Risk Level" confidenceValue="4.2/10" confidencePct={42} barColor={COLORS.warning} />
          <PredictionCard icon={Wallet} title="Year-End Payout" value="₹0" valueColor="text-success" description="Under current policy, excess balance above carry limit will lapse — not be paid out." confidenceLabel="Policy" confidenceValue="CARRY_FORWARD_EXPIRE" confidencePct={100} barColor={COLORS.success} />
          <PredictionCard icon={BarChart3} title="Q3 Balance Projection" value="21.5 days" description="By Sep 30, with scheduled accruals and pending leave deducted." confidenceLabel="Confidence" confidenceValue="High" confidencePct={88} />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-semibold text-foreground">Balance Forecast (Monthly)</p>
        <p className="text-xs text-muted-foreground mb-5">Projected balance trajectory for the rest of the year</p>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={forecastData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <RechartsTooltip content={<ChartTooltipContent />} />
            <defs>
              <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.15} />
                <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="balance" name="Predicted balance" stroke={COLORS.primary} strokeWidth={2} fill="url(#balanceGradient)" dot={{ r: 3, fill: COLORS.primary }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Exported Leave Content (used by AnalyticsLanding) ──────────────────────

export function LeaveAnalyticsContent() {
  const { data, isLoading, isError } = useGetLeaveAnalyticsEmployeeDashboardQuery()

  if (isLoading) return <LoadingState />

  if (isError || !data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Unable to load analytics"
        description="There was an error fetching your leave data. Please try again."
      />
    )
  }

  return (
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
  )
}

export default function LeaveAnalyticsPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="My Leave Analytics"
        subtitle="Personal leave insights · FY 2024–25"
      />
      <LeaveAnalyticsContent />
    </div>
  )
}
