import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceLine, Legend,
  LineChart, Line,
} from 'recharts'
import { Clock, CheckCircle, AlertTriangle, ShieldAlert, Target, Inbox, Loader2 } from 'lucide-react'
import { useGetHRAnalyticsQuery } from '@/store/api/timesheetApi'

const COLORS = {
  primary: '#6f5cff', success: '#22c55e', warning: '#f59e0b',
  destructive: '#ef4444', info: '#007cf0', muted: '#6c6f89', border: '#f0eff6',
}

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

function pctVariant(pct: number) { return pct >= 90 ? 'success' : pct >= 80 ? 'warning' : 'destructive' }
function shortageVariant(avg: number) { return avg <= 0.5 ? 'success' : avg <= 1.5 ? 'warning' : 'destructive' }

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p) => <p key={p.name} className="text-xs text-muted-foreground"><span className="inline-block size-2 rounded-full mr-1.5" style={{ backgroundColor: p.color }} />{p.name}: {p.value}</p>)}
    </div>
  )
}

function DescriptiveTab() {
  const [selectedBU, setSelectedBU] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'single' | 'compare'>('single')

  const { data, isLoading, error } = useGetHRAnalyticsQuery(selectedBU && selectedBU !== 'all' ? { bu: selectedBU } : undefined)
  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !data) return <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="Could not fetch analytics data. Please try again later." />

  const kpis = (data.kpis ?? {}) as Record<string, number>
  const deptCompliance = (data.department_compliance ?? []) as Array<Record<string, unknown>>
  const monthlyOrg = (data.monthly_org_hours ?? []) as Array<Record<string, unknown>>
  const deptSummary = (data.department_summary ?? []) as Array<Record<string, unknown>>
  const buComparison = (data.bu_comparison ?? []) as Array<Record<string, unknown>>
  const buMonthlyTrend = (data.bu_monthly_trend ?? []) as Array<Record<string, unknown>>
  const buNamesList = (data.bu_names ?? []) as string[]
  const businessUnits = (data.business_units ?? []) as Array<{ id: string; name: string }>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Org Total Hours (YTD)" value={kpis.org_total_hours_ytd?.toLocaleString() ?? '0'} unit="hrs" accent="primary" icon={Clock}
          breakdownRows={[
            { label: 'Billable', value: `${kpis.billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.success },
            { label: 'Non-Billable', value: `${kpis.non_billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.muted },
          ]} />
        <KpiCard label="Submission Compliance" value={`${kpis.submission_compliance_pct ?? 0}%`} accent="success" icon={CheckCircle}
          breakdownRows={[
            { label: 'On-Time', value: String(kpis.on_time ?? 0), color: COLORS.success },
            { label: 'Late', value: String(kpis.late ?? 0), color: COLORS.warning },
            { label: 'Missing', value: String(kpis.missing ?? 0), color: COLORS.destructive },
          ]} />
        <KpiCard label="Policy Violations" value={String(kpis.policy_violations ?? 0)} accent="destructive" icon={ShieldAlert}
          breakdownRows={[
            { label: 'Overtime (>45h)', value: String(kpis.overtime_violations ?? 0), color: COLORS.destructive },
            { label: 'Shortage Penalty', value: String(kpis.shortage_violations ?? 0), color: COLORS.warning },
          ]} />
        <KpiCard label="Avg Utilization" value={`${kpis.avg_utilization_pct ?? 0}%`} accent="info" icon={Target}
          breakdownRows={[
            { label: 'Billable Target', value: '80%', color: COLORS.primary },
            { label: 'Actual', value: `${kpis.avg_utilization_pct ?? 0}%`, color: COLORS.primary },
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
              <p className="text-sm font-semibold text-foreground">Key Metrics by Business Unit</p>
              <p className="text-xs text-muted-foreground mb-5">Compliance · Billable · Utilization · On-Time %</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={buComparison}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="bu_name" tick={{ fontSize: 10, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                    <Bar dataKey="compliance_pct" name="Compliance %" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="billable_pct" name="Billable %" fill={COLORS.success} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="utilization_pct" name="Utilization %" fill={COLORS.info} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="on_time_pct" name="On-Time %" fill={COLORS.warning} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">BU Compliance Trend</p>
              <p className="text-xs text-muted-foreground mb-5">On-time submission % by business unit · Last 6 months</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={buMonthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                    <ReferenceLine y={90} stroke={COLORS.warning} strokeDasharray="4 4" strokeOpacity={0.6} />
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
              <p className="text-xs text-muted-foreground">Side-by-side metrics across all business units</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Business Unit</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Headcount</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Total Hours</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Billable %</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Compliance %</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">On-Time %</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Violations</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Avg Shortage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buComparison.map((bu) => (
                  <TableRow key={bu.bu_id as string}>
                    <TableCell className="text-sm font-medium text-foreground">{bu.bu_name as string}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{bu.headcount as number}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(bu.total_hours as number).toLocaleString()}</TableCell>
                    <TableCell><PerformanceBadge label={`${bu.billable_pct}%`} variant={pctVariant(bu.billable_pct as number)} /></TableCell>
                    <TableCell><PerformanceBadge label={`${bu.compliance_pct}%`} variant={pctVariant(bu.compliance_pct as number)} /></TableCell>
                    <TableCell><PerformanceBadge label={`${bu.on_time_pct}%`} variant={pctVariant(bu.on_time_pct as number)} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{bu.violations as number}</TableCell>
                    <TableCell><PerformanceBadge label={`${bu.avg_shortage}h`} variant={shortageVariant(bu.avg_shortage as number)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">Department Compliance</p>
              <p className="text-xs text-muted-foreground mb-5">Submission % by department · 90% target</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={deptCompliance} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="dept_name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} width={90} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <ReferenceLine x={90} stroke={COLORS.warning} strokeDasharray="4 4" strokeOpacity={0.6} />
                    <Bar dataKey="compliance_pct" name="Compliance %" fill={COLORS.primary} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
              <p className="text-sm font-semibold text-foreground">Monthly Org Hours</p>
              <p className="text-xs text-muted-foreground mb-5">Billable + non-billable hours per month</p>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyOrg}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltipContent />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                    <Bar dataKey="billable" name="Billable" stackId="stack" fill={COLORS.success} />
                    <Bar dataKey="non_billable" name="Non-Billable" stackId="stack" fill={COLORS.muted} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="rounded-xl border overflow-x-auto bg-card">
            <div className="px-5 py-4 border-b">
              <p className="text-sm font-semibold text-foreground">Department Summary</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Department</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Headcount</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Total Hours</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Billable %</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">On-Time %</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Violations</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Avg Shortage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deptSummary.length === 0 && <TableRow><TableCell colSpan={7} className="p-0"><EmptyState icon={Inbox} title="No department data" description="Department summary will appear here." /></TableCell></TableRow>}
                {deptSummary.map((r) => (
                  <TableRow key={r.dept as string}>
                    <TableCell className="text-sm font-medium text-foreground">{r.dept as string}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.headcount as number}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(r.total_hours as number).toLocaleString()}</TableCell>
                    <TableCell><PerformanceBadge label={`${r.billable_pct}%`} variant={pctVariant(r.billable_pct as number)} /></TableCell>
                    <TableCell><PerformanceBadge label={`${r.on_time_pct}%`} variant={pctVariant(r.on_time_pct as number)} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.violations as number}</TableCell>
                    <TableCell><PerformanceBadge label={`${r.avg_shortage}h`} variant={shortageVariant(r.avg_shortage as number)} /></TableCell>
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

export function HRTimesheetContent() {
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

export default function HRTimesheetAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="HR Timesheet Analytics" subtitle="Organisation-wide timesheet compliance & insights" />
      <HRTimesheetContent />
    </div>
  )
}
