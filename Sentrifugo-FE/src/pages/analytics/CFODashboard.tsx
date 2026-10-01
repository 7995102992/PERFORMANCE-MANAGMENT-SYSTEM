import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
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
} from 'recharts'
import {
  TrendingDown,
  TrendingUp,
  CalendarClock,
  Wallet,
  AlertTriangle,
  Inbox,
  Loader2,
} from 'lucide-react'
import { useGetCFODashboardQuery } from '@/store/api/lmsApi'
import type { CFODashboardResponse } from '@/store/api/lmsApi'

// ─── Chart colors ────────────────────────────────────────────────────────────

const COLORS = {
  primary: '#6f5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  info: '#3b82f6',
  muted: '#6c6f89',
  border: '#f0eff6',
}

const PIE_COLORS = [COLORS.warning, COLORS.destructive, COLORS.info, COLORS.primary, COLORS.success]

// ─── Shared Components ───────────────────────────────────────────────────────

function LiabilityBanner({
  label, value, valueColor, subtitle,
}: {
  label: string; value: string; valueColor: string; subtitle: string
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-3xl font-extrabold ${valueColor}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
    </div>
  )
}

function KpiCard({
  label, value, subtitle, trend, trendDir, accent, icon: Icon,
}: {
  label: string; value: string; subtitle: string; trend?: string; trendDir?: 'up' | 'down'; accent: string; icon: typeof Wallet
}) {
  const borders: Record<string, string> = { primary: 'border-t-primary', success: 'border-t-success', warning: 'border-t-warning', destructive: 'border-t-destructive', info: 'border-t-info' }
  const texts: Record<string, string> = { primary: 'text-primary', success: 'text-success', warning: 'text-warning', destructive: 'text-destructive', info: 'text-info' }

  return (
    <div className={`rounded-xl border border-t-[3px] ${borders[accent]} bg-card p-4 transition-shadow hover:shadow-md`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        <Icon className={`size-4 ${texts[accent]}`} />
      </div>
      <p className={`text-2xl font-bold ${texts[accent]}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      {trend && (
        <p className={`text-xs font-semibold mt-1 ${trendDir === 'up' ? 'text-success' : 'text-destructive'}`}>
          {trendDir === 'up' && <TrendingUp className="size-3 inline mr-1" />}
          {trendDir === 'down' && <TrendingDown className="size-3 inline mr-1" />}
          {trend}
        </p>
      )}
    </div>
  )
}

function RiskBadge({ label, variant }: { label: string; variant: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    success: { bg: 'bg-success/10', text: 'text-success' },
    warning: { bg: 'bg-warning/10', text: 'text-warning' },
    destructive: { bg: 'bg-destructive/10', text: 'text-destructive' },
    Low: { bg: 'bg-success/10', text: 'text-success' },
    Medium: { bg: 'bg-warning/10', text: 'text-warning' },
    High: { bg: 'bg-destructive/10', text: 'text-destructive' },
  }
  const c = config[variant] ?? config.Low
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>{label}</span>
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

function formatDays(n: number): string {
  return n >= 1000 ? n.toLocaleString('en-IN') : String(n)
}

function formatRupee(n: number | null | undefined): string {
  if (n == null || n === 0) return '₹0'
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

// ─── Descriptive Tab (API-driven) ────────────────────────────────────────────

function DescriptiveTab({ data }: { data: CFODashboardResponse }) {
  const { kpis, accrual_chart, liability_by_plan, year_end_history, top_liability } = data

  const pieData = liability_by_plan.map((d, i) => ({
    ...d,
    color: PIE_COLORS[i % PIE_COLORS.length],
  }))

  return (
    <div className="space-y-6">
      <SectionLabel>Real-Time Leave Liability</SectionLabel>
      <div className="rounded-xl border border-warning/20 bg-warning/[0.03] p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <LiabilityBanner label="Total Leave Liability" value={formatRupee(kpis.total_liability_amount)} valueColor="text-warning" subtitle={`${formatDays(kpis.total_balance_days)} days outstanding across ${kpis.total_employees} employees`} />
        <LiabilityBanner label="Projected Year-End Payout" value={formatRupee(kpis.projected_payout_amount)} valueColor="text-destructive" subtitle={`${formatDays(kpis.expiring_days)} days above carry limits`} />
        <LiabilityBanner label="YTD LOP Deductions" value={formatRupee(kpis.lop_amount)} valueColor="text-success" subtitle={`${kpis.lop_days} days · ${kpis.lop_count} instances`} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Total Balance (Days)" value={formatDays(kpis.total_balance_days)} subtitle="Org-wide outstanding days" accent="warning" icon={Wallet} />
        <KpiCard label="Expiring at Year-End" value={formatDays(kpis.expiring_days)} subtitle="Days above carry-forward limit" accent="destructive" icon={AlertTriangle} />
        <KpiCard label="YTD Accrued" value={formatDays(kpis.ytd_accrued_days)} subtitle="Days credited this FY" accent="success" icon={TrendingUp} />
        <KpiCard label="YTD Consumed" value={formatDays(kpis.ytd_consumed_days)} subtitle="Days actually taken (debited)" trend={`${kpis.utilization_pct}% of entitlement`} trendDir={kpis.utilization_pct >= 50 ? 'up' : 'down'} accent="info" icon={CalendarClock} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Accrual vs Consumption — Monthly (Days)</p>
          <p className="text-xs text-muted-foreground mb-5">Credits posted vs. leaves taken per month</p>
          {accrual_chart.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={accrual_chart}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltipContent />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="accrued" name="Accrued (days)" fill={COLORS.warning} radius={[4, 4, 0, 0]} />
                <Bar dataKey="consumed" name="Consumed (days)" fill={COLORS.success} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No accrual data yet</div>
          )}
        </div>

        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Liability by Leave Plan</p>
          <p className="text-xs text-muted-foreground mb-5">Outstanding balance (days) by plan</p>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="42%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value" nameKey="name">
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10, color: COLORS.muted }} />
                <RechartsTooltip content={<ChartTooltipContent />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No plan data yet</div>
          )}
        </div>
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="px-5 py-4 border-b">
          <p className="text-sm font-semibold text-foreground">Year-End Processing Summary — Previous FY (Historical)</p>
          <p className="text-xs text-muted-foreground">Actual outcomes from last year-end processing run</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Leave Plan</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Employees</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Opening Balance</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Payout Amount</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Carry Forward</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Expired</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Net Liability Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {year_end_history.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState icon={Inbox} title="No historical data" description="Year-end processing records will appear here." />
                </TableCell>
              </TableRow>
            )}
            {year_end_history.map((r) => (
              <TableRow key={r.plan_name}>
                <TableCell className="text-sm font-medium text-foreground">{r.plan_name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.employees}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDays(r.opening_balance)}d</TableCell>
                <TableCell className="text-sm text-warning">{formatDays(r.payout_amount)}d</TableCell>
                <TableCell className="text-sm text-success">{formatDays(r.carry_forward_amount)}d</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDays(r.expired_amount)}d</TableCell>
                <TableCell className="text-sm text-muted-foreground">—</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="px-5 py-4 border-b">
          <p className="text-sm font-semibold text-foreground">Top 10 Highest Leave Liability Employees</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Employee</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Department</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Balance (Days)</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Daily Rate</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Liability (₹)</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Above Carry Limit</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Risk</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {top_liability.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState icon={Inbox} title="No data" description="Employee balance data will appear here." />
                </TableCell>
              </TableRow>
            )}
            {top_liability.map((r) => (
              <TableRow key={r.employee_name}>
                <TableCell className="text-sm font-medium text-foreground">{r.employee_name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.department}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.balance_days}d</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.daily_rate != null ? formatRupee(r.daily_rate) : '—'}</TableCell>
                <TableCell className="text-sm font-medium text-warning">{r.liability_amount != null ? formatRupee(r.liability_amount) : '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.above_carry_limit}d</TableCell>
                <TableCell><RiskBadge label={r.risk} variant={r.risk} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function CFODashboard() {
  const { data, isLoading, isError } = useGetCFODashboardQuery()

  if (isLoading) return (
    <div className="p-6 space-y-6">
      <PageHeader title="Leave Financial Analytics" subtitle="Organization-wide leave liability & financial exposure" />
      <LoadingState />
    </div>
  )

  if (isError || !data) return (
    <div className="p-6 space-y-6">
      <PageHeader title="Leave Financial Analytics" subtitle="Organization-wide leave liability & financial exposure" />
      <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="There was an error fetching financial data. Please try again." />
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Leave Financial Analytics"
        subtitle={`${data.kpis.total_employees} active employees · Organization-wide · FY 2024–25`}
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
