import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
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
  Clock,
  ShieldAlert,
  AlertTriangle,
  UserX,
  Wallet,
  Loader2,
} from 'lucide-react'
import { useGetMDDashboardQuery } from '@/store/api/lmsApi'
import type { MDDashboardResponse } from '@/store/api/lmsApi'

// ─── Chart colors ────────────────────────────────────────────────────────────

const COLORS = {
  primary: '#6f5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  info: '#007cf0',
  muted: '#6c6f89',
  border: '#f0eff6',
  violet: '#8b5cf6',
}

const PIE_COLORS = [COLORS.success, COLORS.violet, COLORS.warning, COLORS.destructive]

// ─── Shared Components ───────────────────────────────────────────────────────

function ScoreCard({
  label, value, rating, ratingColor, subtitle, accent,
}: {
  label: string; value: string; rating: string; ratingColor: string; subtitle: string; accent: string
}) {
  const borders: Record<string, string> = { primary: 'border-t-primary', success: 'border-t-success', destructive: 'border-t-destructive' }
  const texts: Record<string, string> = { primary: 'text-primary', success: 'text-success', destructive: 'text-destructive' }

  return (
    <div className={`rounded-xl border border-t-[3px] ${borders[accent]} bg-card p-7 text-center transition-shadow hover:shadow-md`}>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-4">{label}</p>
      <p className={`text-5xl font-extrabold tracking-tight ${texts[accent]}`}>{value}</p>
      <p className={`text-sm font-semibold mt-2 ${ratingColor}`}>{rating}</p>
      <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
    </div>
  )
}

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

function BUHealthCell({ name, pct, detail }: { name: string; pct: number; detail: string }) {
  const variant = pct >= 60 ? 'success' : pct >= 40 ? 'warning' : 'destructive'
  const bgMap: Record<string, string> = { success: 'bg-success/5 border-success/20', warning: 'bg-warning/5 border-warning/20', destructive: 'bg-destructive/5 border-destructive/20' }
  const textMap: Record<string, string> = { success: 'text-success', warning: 'text-warning', destructive: 'text-destructive' }

  return (
    <div className={`rounded-xl border ${bgMap[variant]} p-4 text-center`}>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{name}</p>
      <p className={`text-xl font-bold ${textMap[variant]}`}>{pct}%</p>
      <p className="text-[10px] text-muted-foreground mt-1">{detail}</p>
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

function buBarColor(pct: number): string {
  if (pct >= 60) return COLORS.success
  if (pct >= 40) return COLORS.warning
  return COLORS.destructive
}

function cultureRating(score: number): { rating: string; color: string } {
  if (score >= 7.5) return { rating: 'Strong', color: 'text-success' }
  if (score >= 5.0) return { rating: 'Below Target', color: 'text-warning' }
  return { rating: 'Poor', color: 'text-destructive' }
}

function briRating(score: number): { rating: string; color: string } {
  if (score >= 5.0) return { rating: 'Elevated', color: 'text-destructive' }
  if (score >= 3.0) return { rating: 'Moderate', color: 'text-warning' }
  return { rating: 'Low', color: 'text-success' }
}

function complianceRating(pct: number): { rating: string; color: string } {
  if (pct >= 98) return { rating: 'Strong', color: 'text-success' }
  if (pct >= 90) return { rating: 'Needs Attention', color: 'text-warning' }
  return { rating: 'Critical', color: 'text-destructive' }
}

// ─── Descriptive Tab (API-driven) ────────────────────────────────────────────

function DescriptiveTab({ data }: { data: MDDashboardResponse }) {
  const { kpis, bu_health, bu_utilization_chart, sick_rate_chart, approval_dist, culture_trend } = data

  const culture = cultureRating(kpis.culture_score)
  const bri = briRating(kpis.org_bri)
  const compliance = complianceRating(kpis.compliance_pct)

  const pieData = approval_dist.map((d, i) => ({
    ...d,
    color: PIE_COLORS[i % PIE_COLORS.length],
  }))

  const utilizationGap = 70 - kpis.org_utilization_pct
  const utilizationSub = utilizationGap > 0
    ? `Target: 70% · ${Math.round(utilizationGap)}pt gap`
    : 'Target: 70% · On track'

  return (
    <div className="space-y-6">
      <SectionLabel>Organizational Health Scorecard</SectionLabel>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ScoreCard
          label="Leave Culture Score"
          value={String(kpis.culture_score)}
          rating={culture.rating}
          ratingColor={culture.color}
          subtitle="Target: 7.5"
          accent="primary"
        />
        <ScoreCard
          label="Burnout Risk Index"
          value={String(kpis.org_bri)}
          rating={bri.rating}
          ratingColor={bri.color}
          subtitle={`${kpis.high_bri_count} employees at high risk`}
          accent="destructive"
        />
        <ScoreCard
          label="Compliance Score"
          value={String(kpis.compliance_pct)}
          rating={compliance.rating}
          ratingColor={compliance.color}
          subtitle={kpis.non_compliant_count > 0 ? `${kpis.non_compliant_count} statutory gaps to remediate` : 'All compliant'}
          accent="success"
        />
      </div>

      {bu_health.length > 0 && (
        <>
          <SectionLabel>Business Unit Leave Health</SectionLabel>
          <div className={`grid gap-3 ${bu_health.length <= 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4'}`}>
            {bu_health.map((bu) => (
              <BUHealthCell key={bu.bu_id} name={bu.bu_name} pct={bu.utilization_pct} detail={bu.detail} />
            ))}
          </div>
        </>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Org Utilization Rate" value={`${kpis.org_utilization_pct}%`} subtitle={utilizationSub} accent="primary" icon={TrendingDown} />
        <KpiCard label="Approval SLA Met" value={`${kpis.approval_sla_pct}%`} subtitle="of requests within 48 hrs" accent="success" icon={Clock} />
        <KpiCard label="Sick Leave Rate" value={`${kpis.sick_leave_rate_pct}%`} subtitle="of total leave taken (YTD)" accent="warning" icon={Wallet} />
        <KpiCard label="Flight Risk (90d)" value={String(kpis.flight_risk_count)} subtitle="Pre-exit patterns detected" accent="destructive" icon={UserX} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Leave Culture Score — Quarterly Trend</p>
          <p className="text-xs text-muted-foreground mb-5">Composite wellness & utilization index (out of 10) · Target: 7.5</p>
          {culture_trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={culture_trend.map((d) => ({ quarter: d.quarter_label, score: d.culture_score }))}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="quarter" tick={{ fontSize: 10, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 10]} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltipContent />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="score" name="Culture Score" stroke={COLORS.violet} strokeWidth={2} dot={{ r: 3, fill: COLORS.violet }} />
                <Line type="monotone" dataKey={() => 7.5} name="Target (7.5)" stroke="rgba(34,197,94,0.4)" strokeDasharray="5 5" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No quarterly data yet</div>
          )}
        </div>

        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Utilization by Business Unit</p>
          <p className="text-xs text-muted-foreground mb-5">YTD leave utilization %</p>
          {bu_utilization_chart.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={bu_utilization_chart} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis type="number" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} width={90} />
                <RechartsTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="pct" name="Utilization %" radius={[0, 4, 4, 0]}>
                  {bu_utilization_chart.map((entry) => (
                    <Cell key={entry.name} fill={buBarColor(entry.pct)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No BU data yet</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Sick Leave Rate Trend (Monthly)</p>
          <p className="text-xs text-muted-foreground mb-5">% of total leave that is sick leave · Rising trend signals stress</p>
          {sick_rate_chart.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={sick_rate_chart}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltipContent />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="rate" name="Sick Leave Rate %" stroke={COLORS.destructive} strokeWidth={2} dot={{ r: 3, fill: COLORS.destructive }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No sick leave data yet</div>
          )}
        </div>

        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Manager Approval Efficiency (Org-Wide)</p>
          <p className="text-xs text-muted-foreground mb-5">Distribution of approval latency across all managers</p>
          {pieData.some((d) => d.value > 0) ? (
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
            <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">No approval data yet</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MDDashboard() {
  const { data, isLoading, isError } = useGetMDDashboardQuery()

  if (isLoading) return (
    <div className="p-6 space-y-6">
      <PageHeader title="Executive Leave Intelligence" subtitle="Organization-wide strategic view" />
      <LoadingState />
    </div>
  )

  if (isError || !data) return (
    <div className="p-6 space-y-6">
      <PageHeader title="Executive Leave Intelligence" subtitle="Organization-wide strategic view" />
      <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="There was an error fetching executive data. Please try again." />
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Executive Leave Intelligence"
        subtitle={`${data.kpis.total_employees} active employees · Organization-wide`}
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
