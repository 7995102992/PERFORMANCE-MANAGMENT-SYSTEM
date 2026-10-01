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
  LineChart,
  Line,
} from 'recharts'
import {
  TrendingDown,
  Flame,
  ShieldCheck,
  Clock,
  ShieldAlert,
  AlertTriangle,
  CheckCircle,
  Calendar,
  BarChart3,
  Scale,
  Lightbulb,
  FileWarning,
  UserX,
  Building2,
  TrendingUp,
  Megaphone,
  Loader2,
} from 'lucide-react'
import { useGetHRDashboardQuery } from '@/store/api/lmsApi'
import type { HRDashboardResponse } from '@/store/api/lmsApi'

// ─── Chart colors ────────────────────────────────────────────────────────────

const COLORS = {
  primary: '#6f5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  info: '#007cf0',
  muted: '#6c6f89',
  border: '#f0eff6',
  orange: '#f97316',
  violet: '#8b5cf6',
}

// ─── Prescriptive / Predictive static data (no backend yet) ─────────────────

const violationData = [
  { month: 'Jan', backdated: 4, clubbing: 2, maxRequests: 1 },
  { month: 'Feb', backdated: 6, clubbing: 3, maxRequests: 2 },
  { month: 'Mar', backdated: 5, clubbing: 4, maxRequests: 1 },
  { month: 'Apr', backdated: 8, clubbing: 3, maxRequests: 2 },
  { month: 'May', backdated: 7, clubbing: 5, maxRequests: 3 },
  { month: 'Jun', backdated: 9, clubbing: 6, maxRequests: 4 },
]

const riskForecastData = [
  { period: 'Now', operations: 7.8, finance: 6.9, engineering: 3.2, sales: 2.8 },
  { period: 'Month 1', operations: 8.5, finance: 7.6, engineering: 3.0, sales: 2.6 },
  { period: 'Month 2', operations: 9.2, finance: 8.3, engineering: 2.9, sales: 2.5 },
  { period: 'Month 3', operations: 9.8, finance: 9.0, engineering: 2.8, sales: 2.4 },
]

// ─── Shared Components ───────────────────────────────────────────────────────

function KpiCard({
  label, value, subtitle, accent, icon: Icon,
}: {
  label: string; value: string; subtitle: string; accent: string; icon: typeof TrendingDown
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
    </div>
  )
}

function PerformanceBadge({ label, variant }: { label: string; variant: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    success: { bg: 'bg-success/10', text: 'text-success' },
    warning: { bg: 'bg-warning/10', text: 'text-warning' },
    destructive: { bg: 'bg-destructive/10', text: 'text-destructive' },
    info: { bg: 'bg-primary/10', text: 'text-primary' },
  }
  const c = config[variant] ?? config.info
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>{label}</span>
}

function DeptHealthCell({ name, pct }: { name: string; pct: number }) {
  const variant = pct >= 60 ? 'success' : pct >= 40 ? 'warning' : 'destructive'
  const bgMap: Record<string, string> = { success: 'bg-success/5 border-success/20', warning: 'bg-warning/5 border-warning/20', destructive: 'bg-destructive/5 border-destructive/20' }
  const textMap: Record<string, string> = { success: 'text-success', warning: 'text-warning', destructive: 'text-destructive' }
  const labelMap: Record<string, string> = { success: 'Healthy', warning: 'Monitor', destructive: 'Critical' }

  return (
    <div className={`rounded-xl border ${bgMap[variant]} p-4 text-center`}>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{name}</p>
      <p className={`text-xl font-bold ${textMap[variant]}`}>{pct}%</p>
      <p className={`text-[10px] font-medium mt-1 ${textMap[variant]}`}>{labelMap[variant]}</p>
    </div>
  )
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

function perfVariant(perf: string): string {
  if (perf === 'Top Tier' || perf === 'Good') return 'success'
  if (perf === 'Review') return 'warning'
  if (perf === 'Action Needed') return 'destructive'
  return 'info'
}

function deptBarColor(pct: number): string {
  if (pct >= 60) return COLORS.success
  if (pct >= 40) return COLORS.warning
  return COLORS.destructive
}

// ─── Descriptive Tab (API-driven) ────────────────────────────────────────────

function DescriptiveTab({ data }: { data: HRDashboardResponse }) {
  const { kpis, dept_heatmap, dept_utilization_chart, bradford_factor, manager_leaderboard } = data

  const bradfordPieData = [
    { name: 'Normal (<50)', value: bradford_factor.normal, color: COLORS.success },
    { name: 'Monitor (51–200)', value: bradford_factor.monitor, color: COLORS.warning },
    { name: 'Review (201–500)', value: bradford_factor.review, color: COLORS.orange },
    { name: 'Critical (>500)', value: bradford_factor.critical, color: COLORS.destructive },
  ].filter((d) => d.value > 0)

  const deptChartData = dept_utilization_chart.map((d) => ({
    ...d,
    fill: deptBarColor(d.pct),
  }))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Org Utilization" value={`${kpis.org_utilization_pct}%`} subtitle={kpis.org_utilization_pct < 70 ? 'Target: 70% · Below threshold' : 'Target: 70%'} accent={kpis.org_utilization_pct < 60 ? 'destructive' : 'success'} icon={TrendingDown} />
        <KpiCard label="High Burnout Employees" value={String(kpis.high_burnout_count)} subtitle={`BRI score > 5.0 (of ${kpis.total_employees})`} accent="warning" icon={Flame} />
        <KpiCard label="Statutory Compliance" value={`${kpis.compliance_pct}%`} subtitle={kpis.non_compliant_count > 0 ? `${kpis.non_compliant_count} employees missing credits` : 'All compliant'} accent="success" icon={ShieldCheck} />
        <KpiCard label="Avg Approval Latency" value={kpis.avg_approval_latency_hours != null ? `${kpis.avg_approval_latency_hours}h` : '—'} subtitle="SLA target: 48h" accent="info" icon={Clock} />
        <KpiCard label="Total Employees" value={String(kpis.total_employees)} subtitle="Active headcount" accent="primary" icon={ShieldAlert} />
      </div>

      {dept_heatmap.length > 0 && (
        <div>
          <SectionLabel>Department Leave Health Heatmap</SectionLabel>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {dept_heatmap.map((d) => (
              <DeptHealthCell key={d.department_id} name={d.department_name} pct={d.utilization_pct} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Leave Utilization by Department (YTD)</p>
          <p className="text-xs text-muted-foreground mb-5">% of total entitlement consumed</p>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={deptChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="pct" name="Utilization %" radius={[4, 4, 0, 0]}>
                {deptChartData.map((entry) => (
                  <Cell key={entry.name} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Bradford Factor Distribution</p>
          <p className="text-xs text-muted-foreground mb-5">Org-wide absence disruption score bands</p>
          {bradfordPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={bradfordPieData} cx="50%" cy="42%" innerRadius={45} outerRadius={70} paddingAngle={3} dataKey="value" nameKey="name">
                  {bradfordPieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10, color: COLORS.muted }} />
                <RechartsTooltip content={<ChartTooltipContent />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No absence data</div>
          )}
        </div>
      </div>

      {manager_leaderboard.length > 0 && (
        <div className="rounded-xl border overflow-x-auto bg-card">
          <div className="px-5 py-4 border-b">
            <p className="text-sm font-semibold text-foreground">Manager Approval Performance Leaderboard</p>
            <p className="text-xs text-muted-foreground">Rejection rate · Avg latency · Overdue requests · vs org benchmarks</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Manager</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Team Size</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Avg Latency</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Rejection Rate</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Overdue</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Performance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manager_leaderboard.map((m) => (
                <TableRow key={m.manager_name}>
                  <TableCell className="text-sm font-medium text-foreground">{m.manager_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.team_size}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.avg_latency_hours != null ? `${m.avg_latency_hours}h` : '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.rejection_rate_pct}%</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.overdue_count}</TableCell>
                  <TableCell><PerformanceBadge label={m.performance} variant={perfVariant(m.performance)} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

// ─── Prescriptive Tab (uses live KPIs + static alerts) ───────────────────────

function PrescriptiveTab({ data }: { data: HRDashboardResponse }) {
  const { kpis, dept_heatmap, manager_leaderboard } = data
  const criticalDepts = dept_heatmap.filter((d) => d.utilization_pct < 40)
  const badManagers = manager_leaderboard.filter((m) => m.performance === 'Action Needed')

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>High-Priority HR Actions</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {kpis.non_compliant_count > 0 && (
            <AlertCard variant="danger" icon={ShieldAlert} title={`Statutory Compliance Gap: ${kpis.non_compliant_count} Employees`} description={`${kpis.non_compliant_count} employees have not received their annual statutory leave credit. This is a legal compliance failure.`} action="→ Run manual credit for affected employees" />
          )}
          {badManagers.map((m) => (
            <AlertCard key={m.manager_name} variant="danger" icon={UserX} title={`Manager Review: ${m.manager_name}`} description={`${m.rejection_rate_pct}% rejection rate, ${m.avg_latency_hours ?? '—'}h avg latency, ${m.overdue_count} overdue approvals. Escalation required.`} action="→ Schedule manager coaching session" />
          ))}
          {criticalDepts.map((d) => (
            <AlertCard key={d.department_id} variant="warning" icon={Flame} title={`${d.department_name} Dept: Critical Burnout Risk`} description={`${d.department_name} has ${d.utilization_pct}% utilization with ${d.employee_count} employees. Mandatory wellness intervention needed.`} action="→ Issue mandatory leave directive" />
          ))}
          {kpis.org_utilization_pct < 60 && (
            <AlertCard variant="warning" icon={AlertTriangle} title={`Low Org Utilization (${kpis.org_utilization_pct}%)`} description="Organisation-wide utilization is below 60%. A targeted campaign for low-utilization departments can reduce year-end lapse and liability." action="→ Draft campaign communication" />
          )}
          <AlertCard variant="info" icon={FileWarning} title="Leave Type Consolidation Opportunity" description='Review leave types with <5% utilization across the org. Consider retiring or consolidating to simplify policy.' action="→ Review with leadership" />
          <AlertCard variant="info" icon={Megaphone} title="Launch Q3 Leave Utilization Campaign" description="Target low-utilization departments with a 'Take Your Leave' campaign to reduce year-end lapse." action="→ Draft campaign communication" />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-semibold text-foreground">Org-Wide Policy Violation Attempts (Last 6 Months)</p>
        <p className="text-xs text-muted-foreground mb-5">Tracking blocked violations by type</p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={violationData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <RechartsTooltip content={<ChartTooltipContent />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="backdated" name="Backdated Deadline" fill={COLORS.destructive} stackId="a" />
            <Bar dataKey="clubbing" name="Clubbing Violation" fill={COLORS.warning} stackId="a" />
            <Bar dataKey="maxRequests" name="Max Requests" fill={COLORS.violet} stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Predictive Tab (static — no backend yet) ───────────────────────────────

function PredictiveTab() {
  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Predictive HR Intelligence</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <PredictionCard icon={UserX} title="Flight Risk Employees (90-day)" value="23" valueColor="text-destructive" description="23 employees show pre-exit leave signatures: spike in sick leaves, high backdated submission rate, and increasing casual leave." confidenceLabel="Confidence" confidenceValue="68%" confidencePct={68} barColor={COLORS.destructive} />
          <PredictionCard icon={Building2} title="Departments at Burnout (60-day)" value="Finance · Ops" valueColor="text-warning" description="Finance and Operations are on track to reach critical burnout threshold within 60 days." confidenceLabel="Confidence" confidenceValue="82%" confidencePct={82} barColor={COLORS.warning} />
          <PredictionCard icon={BarChart3} title="Year-End Utilization Forecast" value="58%" description="Without intervention, org utilization will reach 58% by Dec 31 — below the 70% target." confidenceLabel="Confidence" confidenceValue="77%" confidencePct={77} />
          <PredictionCard icon={TrendingDown} title="Leave Culture Score Trajectory" value="Declining" valueColor="text-warning" description="The org's rolling 6-month leave culture score dropped from 6.8 to 5.9." confidenceLabel="Trend Confidence" confidenceValue="85%" confidencePct={85} barColor={COLORS.warning} />
          <PredictionCard icon={TrendingUp} title="Attrition from Burnout (FY End)" value="12–18" valueColor="text-destructive" description="Predictive model estimates 12–18 resignations attributable to leave underutilization and burnout." confidenceLabel="Confidence" confidenceValue="62%" confidencePct={62} barColor={COLORS.destructive} />
          <PredictionCard icon={Lightbulb} title="Campaign Impact Projection" value="+19%" valueColor="text-success" description="A targeted Q3 leave campaign is projected to raise org utilization by 19% and reduce year-end liability by ₹42L." confidenceLabel="Confidence" confidenceValue="71%" confidencePct={71} barColor={COLORS.success} />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-semibold text-foreground">Flight Risk & Burnout Index by Department (Forecast)</p>
        <p className="text-xs text-muted-foreground mb-5">Projected 90-day trajectory</p>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={riskForecastData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
            <RechartsTooltip content={<ChartTooltipContent />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="operations" name="Operations" stroke={COLORS.destructive} strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="finance" name="Finance" stroke={COLORS.orange} strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="engineering" name="Engineering" stroke={COLORS.success} strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="sales" name="Sales" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function HRDashboard() {
  const { data, isLoading, isError } = useGetHRDashboardQuery()

  if (isLoading) return (
    <div className="p-6 space-y-6">
      <PageHeader title="HR Leave Analytics" subtitle="Organisation-wide leave insights and compliance" />
      <LoadingState />
    </div>
  )

  if (isError || !data) return (
    <div className="p-6 space-y-6">
      <PageHeader title="HR Leave Analytics" subtitle="Organisation-wide leave insights and compliance" />
      <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="There was an error fetching HR data. Please try again." />
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="HR Leave Analytics"
        subtitle={`${data.kpis.total_employees} active employees · Organisation-wide`}
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
