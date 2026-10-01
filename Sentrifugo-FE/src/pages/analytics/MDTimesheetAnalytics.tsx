import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import { DollarSign, Users, ShieldAlert, Target, Inbox, Loader2, AlertTriangle } from 'lucide-react'
import { useGetMDAnalyticsQuery } from '@/store/api/timesheetApi'

const COLORS = {
  primary: '#6f5cff', success: '#22c55e', warning: '#f59e0b',
  destructive: '#ef4444', info: '#007cf0', muted: '#6c6f89', border: '#f0eff6',
  violet: '#8b5cf6', violetLight: '#a78bfa', violetLighter: '#c4b5fd', violetLightest: '#ddd6fe',
}
const PIE_COLORS = [COLORS.violet, COLORS.violetLight, COLORS.violetLighter, COLORS.violetLightest, COLORS.muted, COLORS.warning]

function KpiCard({ label, value, unit, accent, icon: Icon, breakdownRows }: {
  label: string; value: string; unit?: string; accent: string; icon: typeof DollarSign
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
      <p className={`text-3xl font-bold ${texts[accent]}`}>{value}{unit && <span className="text-sm font-medium text-muted-foreground ml-1">{unit}</span>}</p>
      {breakdownRows && breakdownRows.length > 0 && (
        <div className="mt-3 pt-3 border-t space-y-1.5">
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

function HealthBadge({ label, variant }: { label: string; variant: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    success: { bg: 'bg-success/10', text: 'text-success' }, info: { bg: 'bg-primary/10', text: 'text-primary' },
    warning: { bg: 'bg-warning/10', text: 'text-warning' }, destructive: { bg: 'bg-destructive/10', text: 'text-destructive' },
  }
  const c = config[variant] ?? config.info
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>{label}</span>
}

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number | null; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p) => p.value != null && <p key={p.name} className="text-xs text-muted-foreground"><span className="inline-block size-2 rounded-full mr-1.5" style={{ backgroundColor: p.color }} />{p.name}: {p.value}</p>)}
    </div>
  )
}

function fmt(v: number) { return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}` }

function DescriptiveTab() {
  const { data, isLoading, error } = useGetMDAnalyticsQuery()
  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !data) return <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="Could not fetch analytics data. Please try again later." />

  const kpis = (data.kpis ?? {}) as Record<string, number>
  const revenueByBU = (data.revenue_by_bu ?? []) as Array<{ name: string; value: number; revenue: number }>
  const quarterly = (data.quarterly_performance ?? []) as Array<Record<string, unknown>>
  const buScorecard = (data.bu_scorecard ?? []) as Array<Record<string, unknown>>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Org Revenue (YTD)" value={fmt(kpis.org_revenue_ytd ?? 0)} accent="primary" icon={DollarSign}
          breakdownRows={[{ label: 'On Track', value: fmt(kpis.org_revenue_ytd ?? 0), color: COLORS.primary }]} />
        <KpiCard label="Workforce Utilization" value={`${kpis.workforce_utilization ?? 0}%`} accent="success" icon={Target}
          breakdownRows={[{ label: 'Target', value: '80%', color: COLORS.success }]} />
        <KpiCard label="Org Headcount Active" value={String(kpis.org_headcount ?? 0)} accent="info" icon={Users}
          breakdownRows={[
            { label: 'Billable Resources', value: String(kpis.billable_headcount ?? 0), color: COLORS.info },
            { label: 'Non-Billable', value: String((kpis.org_headcount ?? 0) - (kpis.billable_headcount ?? 0)), color: COLORS.muted },
          ]} />
        <KpiCard label="Compliance Score" value={`${kpis.compliance_score ?? 0}%`} accent="warning" icon={ShieldAlert}
          breakdownRows={[{ label: 'Timesheet On-Time', value: `${kpis.compliance_score ?? 0}%`, color: COLORS.warning }]} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-4">
        <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
          <p className="text-sm font-semibold text-foreground">Revenue by Business Unit</p>
          <p className="text-xs text-muted-foreground mb-5">YTD distribution across business units</p>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={revenueByBU} cx="50%" cy="45%" innerRadius={55} outerRadius={85} paddingAngle={3} dataKey="value" nameKey="name">
                  {revenueByBU.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                <RechartsTooltip content={<ChartTooltipContent />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
          <p className="text-sm font-semibold text-foreground">Quarterly Performance</p>
          <p className="text-xs text-muted-foreground mb-5">Revenue, Cost & Margin by quarter · Values in $M</p>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={quarterly}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="quarter" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltipContent />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                <Bar dataKey="revenue" name="Revenue ($M)" fill={COLORS.violet} radius={[4, 4, 0, 0]} />
                <Bar dataKey="cost" name="Cost ($M)" fill={COLORS.violetLight} radius={[4, 4, 0, 0]} />
                <Bar dataKey="margin" name="Margin ($M)" fill={COLORS.success} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="px-5 py-4 border-b">
          <p className="text-sm font-semibold text-foreground">Business Unit Scorecard</p>
          <p className="text-xs text-muted-foreground">Performance metrics by business unit · YTD</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              {['Business Unit', 'Revenue', 'Headcount', 'Utilization %', 'Billable Ratio', 'Compliance %', 'Health'].map((h) => (
                <TableHead key={h} className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {buScorecard.length === 0 && <TableRow><TableCell colSpan={7} className="p-0"><EmptyState icon={Inbox} title="No data" description="Business unit scorecard will appear here." /></TableCell></TableRow>}
            {buScorecard.map((r) => (
              <TableRow key={r.bu as string}>
                <TableCell className="text-sm font-medium text-foreground">{r.bu as string}</TableCell>
                <TableCell className="text-sm text-foreground">{r.revenue as string}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.headcount as number}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.utilization as number}%</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.billable_ratio as number}%</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.compliance as number}%</TableCell>
                <TableCell><HealthBadge label={r.health as string} variant={r.health_variant as string} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function MDTimesheetContent() {
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

export default function MDTimesheetAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Executive Timesheet Analytics" subtitle="Organisation-wide insights" />
      <MDTimesheetContent />
    </div>
  )
}
