import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, ComposedChart, Line, LineChart,
} from 'recharts'
import { DollarSign, AlertTriangle, Inbox, CircleDollarSign, Receipt, BadgeDollarSign, Loader2 } from 'lucide-react'
import { useGetCFOAnalyticsQuery } from '@/store/api/timesheetApi'

const COLORS = {
  primary: '#6f5cff', success: '#22c55e', warning: '#f59e0b',
  destructive: '#ef4444', info: '#007cf0', muted: '#6c6f89', border: '#f0eff6',
  amber: '#d97706', gold: '#ca8a04', amberLight: '#fbbf24', honey: '#b45309', amberDark: '#92400e',
  orange: '#f97316',
}
const PIE_COLORS = [COLORS.amber, COLORS.gold, COLORS.amberLight, COLORS.honey, COLORS.amberDark, COLORS.orange, COLORS.muted]

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

function PerformanceBadge({ label, variant }: { label: string; variant: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    success: { bg: 'bg-success/10', text: 'text-success' }, warning: { bg: 'bg-warning/10', text: 'text-warning' },
    destructive: { bg: 'bg-destructive/10', text: 'text-destructive' }, info: { bg: 'bg-primary/10', text: 'text-primary' },
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

function PieLabel({ cx, cy, midAngle, outerRadius, name, value }: {
  cx: number; cy: number; midAngle: number; outerRadius: number; name: string; value: number
}) {
  const RADIAN = Math.PI / 180
  const radius = outerRadius + 24
  const x = cx + radius * Math.cos(-midAngle * RADIAN)
  const y = cy + radius * Math.sin(-midAngle * RADIAN)
  return <text x={x} y={y} fill={COLORS.muted} textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={11}>{name} {value}%</text>
}

function fmt(v: number) { return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}` }

function DescriptiveTab() {
  const [selectedBU, setSelectedBU] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'single' | 'compare'>('single')

  const { data, isLoading, error } = useGetCFOAnalyticsQuery(selectedBU && selectedBU !== 'all' ? { bu: selectedBU } : undefined)
  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !data) return <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="Could not fetch analytics data. Please try again later." />

  const kpis = (data.kpis ?? {}) as Record<string, number>
  const revenueByClient = (data.revenue_by_client ?? []) as Array<{ name: string; value: number; revenue: number }>
  const monthlyRevCost = (data.monthly_revenue_cost ?? []) as Array<Record<string, unknown>>
  const projTable = (data.project_profitability ?? []) as Array<Record<string, unknown>>
  const buComparison = (data.bu_comparison ?? []) as Array<Record<string, unknown>>
  const buRevenueTrend = (data.bu_revenue_trend ?? []) as Array<Record<string, unknown>>
  const buNamesList = (data.bu_names ?? []) as string[]
  const businessUnits = (data.business_units ?? []) as Array<{ id: string; name: string }>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Billable Revenue (YTD)" value={fmt(kpis.billable_revenue_ytd ?? 0)} accent="success" icon={DollarSign}
          breakdownRows={[
            { label: 'Billable Hours', value: `${kpis.billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.success },
            { label: 'Non-Billable Hours', value: `${kpis.non_billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.muted },
          ]} />
        <KpiCard label="Cost of Non-Billable" value={fmt(kpis.non_billable_cost ?? 0)} accent="destructive" icon={Receipt}
          breakdownRows={[
            { label: 'Non-Billable Hours', value: `${kpis.non_billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.destructive },
          ]} />
        <KpiCard label="Avg Billable Rate" value={`$${kpis.avg_billable_rate ?? 0}`} unit="/hr" accent="info" icon={CircleDollarSign}
          breakdownRows={[]} />
        <KpiCard label="Revenue Leakage" value={fmt(kpis.revenue_leakage ?? 0)} accent="warning" icon={BadgeDollarSign}
          breakdownRows={[
            { label: 'Shortage Penalty Revenue', value: fmt(kpis.revenue_leakage ?? 0), color: COLORS.warning },
          ]} />
      </div>

      <div className="rounded-xl border bg-card px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold text-foreground">Business Unit</p>
          <Select value={selectedBU} onValueChange={setSelectedBU}>
            <SelectTrigger className="w-[220px] h-9 text-xs"><SelectValue placeholder="All Business Units" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All Business Units</SelectItem>
              {businessUnits.map((bu) => <SelectItem key={bu.id} value={bu.id} className="text-xs">{bu.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center rounded-lg border overflow-x-auto">
          <button className={`px-4 py-1.5 text-xs font-semibold transition-colors ${viewMode === 'single' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`} onClick={() => setViewMode('single')}>View BU</button>
          <button className={`px-4 py-1.5 text-xs font-semibold transition-colors ${viewMode === 'compare' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`} onClick={() => setViewMode('compare')}>Compare BUs</button>
        </div>
      </div>

      {viewMode === 'compare' ? (
        <>
          <p className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-3">
            Business Unit Comparison
            <span className="flex-1 h-px bg-border" />
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">Key Financial Metrics by Business Unit</p>
              <p className="text-xs text-muted-foreground mb-5">Revenue · Billable Hours · Avg Rate · Margin %</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={buComparison}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="bu_name" tick={{ fontSize: 10, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                    <Bar dataKey="avg_rate" name="Avg Rate ($/hr)" fill={COLORS.info} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="margin_pct" name="Margin %" fill={COLORS.success} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">BU Revenue Trend</p>
              <p className="text-xs text-muted-foreground mb-5">Monthly revenue by business unit ($K)</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={buRevenueTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                    {buNamesList.map((name, i) => (
                      <Line key={name} type="monotone" dataKey={name} name={name} stroke={[COLORS.primary, COLORS.success, COLORS.warning, COLORS.info, COLORS.destructive, COLORS.muted][i % 6]} strokeWidth={2} dot={{ r: 3 }} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="rounded-xl border overflow-x-auto bg-card">
            <div className="px-5 py-4 border-b">
              <p className="text-sm font-semibold text-foreground">Business Unit Comparison Table</p>
              <p className="text-xs text-muted-foreground">Side-by-side financial metrics across all business units</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  {['Business Unit', 'Revenue', 'Billable Hours', 'Avg Rate', 'Margin %'].map((h) => (
                    <TableHead key={h} className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {buComparison.map((bu) => (
                  <TableRow key={bu.bu_name as string}>
                    <TableCell className="text-sm font-medium text-foreground">{bu.bu_name as string}</TableCell>
                    <TableCell className="text-sm text-foreground">{fmt(bu.revenue as number)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(bu.billable_hours as number).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">${bu.avg_rate as number}/hr</TableCell>
                    <TableCell><PerformanceBadge label={`${bu.margin_pct}%`} variant={(bu.margin_pct as number) >= 20 ? 'success' : (bu.margin_pct as number) >= 10 ? 'warning' : 'destructive'} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_1.5fr] gap-4">
            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">Revenue by Client</p>
              <p className="text-xs text-muted-foreground mb-5">Share of billable revenue by client · YTD</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={revenueByClient} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value">
                      {revenueByClient.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend
                      layout="vertical"
                      verticalAlign="middle"
                      align="right"
                      iconType="circle"
                      iconSize={8}
                      formatter={(val: string, entry: { payload?: { value?: number } }) => {
                        const pct = entry.payload?.value ?? 0
                        return <span style={{ fontSize: 11, color: COLORS.muted }}>{val} {pct}%</span>
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">Monthly Revenue vs Cost</p>
              <p className="text-xs text-muted-foreground mb-5">Revenue bars + cost trend overlay · $K per month</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={monthlyRevCost}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                    <Bar dataKey="revenue" name="Revenue ($K)" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
                    <Line type="monotone" dataKey="cost" name="Cost ($K)" stroke={COLORS.destructive} strokeWidth={2} dot={{ r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="rounded-xl border overflow-x-auto bg-card">
            <div className="px-5 py-4 border-b">
              <p className="text-sm font-semibold text-foreground">Project Profitability</p>
              <p className="text-xs text-muted-foreground">Budget · Actual Cost · Revenue · Margin</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  {['Project', 'Client', 'Type', 'Budget', 'Actual Cost', 'Revenue', 'Margin %', 'Status'].map((h) => (
                    <TableHead key={h} className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {projTable.length === 0 && <TableRow><TableCell colSpan={8} className="p-0"><EmptyState icon={Inbox} title="No project data" description="Project profitability data will appear here." /></TableCell></TableRow>}
                {projTable.map((r) => (
                  <TableRow key={r.project as string}>
                    <TableCell className="text-sm font-medium text-foreground">{r.project as string}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.client as string}</TableCell>
                    <TableCell><PerformanceBadge label={r.type as string} variant={(r.type as string) === 'time_and_materials' ? 'info' : 'warning'} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.budget as string}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.actual_cost as string}</TableCell>
                    <TableCell className="text-sm text-foreground font-medium">{r.revenue as string}</TableCell>
                    <TableCell><PerformanceBadge label={`${r.margin_pct}%`} variant={(r.margin_pct as number) >= 20 ? 'success' : (r.margin_pct as number) >= 10 ? 'warning' : 'destructive'} /></TableCell>
                    <TableCell><PerformanceBadge label={r.status as string} variant={(r.status as string) === 'On Track' ? 'success' : (r.status as string) === 'At Risk' ? 'warning' : 'destructive'} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}

export function CFOTimesheetContent() {
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

export default function CFOTimesheetAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Financial Timesheet Analytics" subtitle="CFO financial insights" />
      <CFOTimesheetContent />
    </div>
  )
}
