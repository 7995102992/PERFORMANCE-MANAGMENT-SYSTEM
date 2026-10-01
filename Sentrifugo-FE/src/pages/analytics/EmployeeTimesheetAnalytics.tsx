
import { useState } from 'react'
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
  ReferenceLine,
  Legend,
} from 'recharts'
import {
  Clock,
  CheckCircle,
  AlertTriangle,
  Inbox,
  FileText,
  RefreshCw,
  Target,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import { useGetEmployeeAnalyticsQuery } from '@/store/api/timesheetApi'

const COLORS = {
  primary: '#6f5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  info: '#007cf0',
  muted: '#6c6f89',
  border: '#f0eff6',
  cyan: '#06b6d4',
  indigo: '#6366f1',
  pink: '#ec4899',
}

const PROJECT_COLORS = [
  COLORS.success, COLORS.cyan, COLORS.indigo,
  COLORS.warning, COLORS.pink, COLORS.muted,
  COLORS.primary, COLORS.info, COLORS.destructive,
]

function TimesheetStatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, '-')
  const config: Record<string, { bg: string; text: string; label: string; icon?: typeof CheckCircle }> = {
    draft: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Draft', icon: FileText },
    submitted: { bg: 'bg-primary/10', text: 'text-primary', label: 'Submitted', icon: Clock },
    l1_approved: { bg: 'bg-badge-active-bg', text: 'text-success', label: 'L1 Approved', icon: CheckCircle },
    approved: { bg: 'bg-badge-active-bg', text: 'text-success', label: 'Approved', icon: CheckCircle },
    rejected: { bg: 'bg-badge-reject-bg', text: 'text-destructive', label: 'Rejected', icon: AlertTriangle },
    l1_rejected: { bg: 'bg-badge-reject-bg', text: 'text-destructive', label: 'L1 Rejected', icon: AlertTriangle },
    client_rejected: { bg: 'bg-badge-reject-bg', text: 'text-destructive', label: 'Client Rejected', icon: AlertTriangle },
    resubmitted: { bg: 'bg-badge-pending-bg', text: 'text-warning', label: 'Resubmitted', icon: RefreshCw },
    'client-approved': { bg: 'bg-success/10', text: 'text-success', label: 'Client Approved', icon: CheckCircle },
    client_approved: { bg: 'bg-success/10', text: 'text-success', label: 'Client Approved', icon: CheckCircle },
  }
  const c = config[normalized] ?? config.draft
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>
      {Icon && <Icon className="size-3" />}
      {c.label}
    </span>
  )
}

function KpiCard({
  label, value, unit, accent, icon: Icon,
  breakdownRows,
}: {
  label: string; value: string; unit?: string; accent: string; icon: typeof Clock
  breakdownRows?: Array<{ label: string; value: string; color: string }>
}) {
  const accentBorder: Record<string, string> = { primary: 'border-t-primary', success: 'border-t-success', warning: 'border-t-warning', destructive: 'border-t-destructive', info: 'border-t-info' }
  const accentText: Record<string, string> = { primary: 'text-primary', success: 'text-success', warning: 'text-warning', destructive: 'text-destructive', info: 'text-info' }
  return (
    <div className={`rounded-xl border border-t-[3px] ${accentBorder[accent] ?? 'border-t-primary'} bg-card p-5 transition-shadow hover:shadow-md`}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        <Icon className={`size-5 ${accentText[accent] ?? 'text-primary'}`} />
      </div>
      <p className={`text-3xl font-bold ${accentText[accent] ?? 'text-primary'}`}>
        {value}
        {unit && <span className="text-sm font-medium text-muted-foreground ml-1">{unit}</span>}
      </p>
      {breakdownRows && breakdownRows.length > 0 && (
        <div className="mt-3 pt-3 border-t space-y-1.5">
          {breakdownRows.map((row) => (
            <div key={row.label} className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-bold" style={{ color: row.color }}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number | null; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p) => (
        p.value != null && (
          <p key={p.name} className="text-xs text-muted-foreground">
            <span className="inline-block size-2 rounded-full mr-1.5" style={{ backgroundColor: p.color }} />
            {p.name}: {p.value}
          </p>
        )
      ))}
    </div>
  )
}

function ViewToggle({ timeView, onViewChange }: { timeView: 'month' | 'week'; onViewChange: (v: 'month' | 'week') => void }) {
  return (
    <div className="flex items-center rounded-lg border overflow-x-auto">
      <button className={`px-3 py-1.5 text-xs font-semibold transition-colors ${timeView === 'month' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`} onClick={() => onViewChange('month')}>Month</button>
      <button className={`px-3 py-1.5 text-xs font-semibold transition-colors ${timeView === 'week' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`} onClick={() => onViewChange('week')}>Week</button>
    </div>
  )
}

function getWeekDates(refDate: Date): Date[] {
  const d = new Date(refDate)
  const dow = d.getDay()
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset)
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
}

function WeeklyCalendar({ calendarHours, weekRef, onChangeWeek, timeView, onViewChange }: {
  calendarHours: Record<string, number>; weekRef: Date
  onChangeWeek: (dir: number) => void; timeView: 'month' | 'week'; onViewChange: (v: 'month' | 'week') => void
}) {
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n)
  const days = getWeekDates(weekRef)
  const today = new Date()
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  const weekStart = days[0]
  const weekEnd = days[6]
  const headerLabel = weekStart.getMonth() === weekEnd.getMonth()
    ? `${monthNames[weekStart.getMonth()]} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${weekStart.getFullYear()}`
    : `${monthNames[weekStart.getMonth()]} ${weekStart.getDate()} – ${monthNames[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`

  const totalWeekHours = days.reduce((sum, d) => {
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    return sum + (calendarHours[key] || 0)
  }, 0)

  const getHoursColor = (hours: number, isWeekend: boolean) => {
    if (isWeekend) return 'text-muted-foreground/30'
    if (hours > 9) return 'text-destructive'
    if (hours >= 8) return 'text-success'
    if (hours > 0) return 'text-warning'
    return 'text-muted-foreground/30'
  }

  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <div className="flex items-center justify-between px-5 py-4 border-b">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{headerLabel}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Total: {totalWeekHours}h logged</p>
        </div>
        <div className="flex items-center gap-3">
          <ViewToggle timeView={timeView} onViewChange={onViewChange} />
          <button className="size-8 rounded-lg border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors" onClick={() => onChangeWeek(-1)}>
            <ChevronLeft className="size-4" />
          </button>
          <button className="size-8 rounded-lg border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors" onClick={() => onChangeWeek(1)}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          const hours = calendarHours[key] || 0
          const isWeekend = d.getDay() === 0 || d.getDay() === 6
          const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()

          return (
            <div key={i} className={`flex flex-col items-center py-5 border-r last:border-r-0 transition-colors ${isToday ? 'bg-primary/5' : ''} ${isWeekend ? 'bg-muted/20' : ''}`}>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{dayNames[i]}</span>
              <span className={`text-sm mt-1 ${isToday ? 'font-bold text-primary bg-primary/10 size-7 rounded-full flex items-center justify-center' : 'text-foreground'}`}>
                {d.getDate()}
              </span>
              <div className={`text-2xl font-extrabold mt-3 ${getHoursColor(hours, isWeekend)}`}>
                {isWeekend ? <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted/30 text-muted-foreground">Off</span> : hours > 0 ? `${hours}h` : '—'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MonthlyCalendar({ calendarHours, calYear, calMonth, onChangeMonth, timeView, onViewChange }: {
  calendarHours: Record<string, number>; calYear: number; calMonth: number
  onChangeMonth: (dir: number) => void; timeView: 'month' | 'week'; onViewChange: (v: 'month' | 'week') => void
}) {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const dayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n)

  const firstDay = new Date(calYear, calMonth, 1)
  const lastDay = new Date(calYear, calMonth + 1, 0)
  let startDow = firstDay.getDay()
  startDow = startDow === 0 ? 6 : startDow - 1

  const today = new Date()
  const totalCells = Math.ceil((startDow + lastDay.getDate()) / 7) * 7

  const cells: Array<{ dayNum: number; inMonth: boolean; isWeekend: boolean; isToday: boolean; hours: number }> = []
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startDow + 1
    const inMonth = dayNum >= 1 && dayNum <= lastDay.getDate()
    const d = new Date(calYear, calMonth, dayNum)
    const dow = d.getDay()
    const isWeekend = dow === 0 || dow === 6
    const isToday = inMonth && d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
    const key = calYear + '-' + pad(calMonth + 1) + '-' + pad(dayNum)
    cells.push({ dayNum, inMonth, isWeekend, isToday, hours: calendarHours[key] || 0 })
  }

  const getHoursClass = (cell: typeof cells[0]) => {
    if (!cell.inMonth || cell.isWeekend) return 'text-muted-foreground/30'
    if (cell.hours > 9) return 'text-destructive'
    if (cell.hours >= 8) return 'text-success'
    if (cell.hours > 0) return 'text-warning'
    return 'text-muted-foreground/30'
  }

  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <div className="flex items-center justify-between px-5 py-4 border-b">
        <h3 className="text-sm font-semibold text-foreground">{monthNames[calMonth]} {calYear}</h3>
        <div className="flex items-center gap-3">
          <ViewToggle timeView={timeView} onViewChange={onViewChange} />
          <button className="size-8 rounded-lg border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors" onClick={() => onChangeMonth(-1)}>
            <ChevronLeft className="size-4" />
          </button>
          <button className="size-8 rounded-lg border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors" onClick={() => onChangeMonth(1)}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 border-b">
        {dayHeaders.map((d) => (
          <div key={d} className="text-xs text-muted-foreground font-medium text-center py-2">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell, i) => (
          <div key={i} className={`min-h-[72px] p-2 border-b border-r last:border-r-0 relative transition-colors ${!cell.inMonth ? 'opacity-30' : ''} ${cell.isToday ? 'bg-primary/5' : ''} ${cell.isWeekend && cell.inMonth ? 'bg-muted/20' : ''}`}>
            {cell.inMonth && (
              <>
                <span className={`text-xs ${cell.isToday ? 'font-bold text-primary' : 'text-muted-foreground'}`}>{cell.dayNum}</span>
                {!cell.isWeekend && (
                  <div className={`text-base font-extrabold mt-1 ${getHoursClass(cell)}`}>
                    {cell.hours > 0 ? `${cell.hours}h` : '—'}
                  </div>
                )}
                {cell.isWeekend && (
                  <span className="text-[10px] font-semibold mt-1 px-1.5 py-0.5 rounded inline-block bg-muted/30 text-muted-foreground">Off</span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function DescriptiveTab() {
  const now = new Date()
  const [calYear, setCalYear] = useState(now.getFullYear())
  const [calMonth, setCalMonth] = useState(now.getMonth())
  const [timeView, setTimeView] = useState<'month' | 'week'>('month')
  const [weekRef, setWeekRef] = useState(now)

  const { data, isLoading, error } = useGetEmployeeAnalyticsQuery({ cal_month: calMonth + 1, cal_year: calYear })

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }
  if (error || !data) {
    return <EmptyState icon={AlertTriangle} title="Unable to load analytics" description="Could not fetch analytics data. Please try again later." />
  }

  const kpis = (data.kpis ?? {}) as Record<string, number>
  const calendarHours = (data.calendar_hours ?? {}) as Record<string, number>
  const monthlyProjectHours = (data.monthly_project_hours ?? []) as Array<Record<string, unknown>>
  const projectNames = (data.project_names ?? []) as string[]
  const recentTimesheets = (data.recent_timesheets ?? []) as Array<Record<string, unknown>>

  const changeMonth = (dir: number) => {
    let newMonth = calMonth + dir
    let newYear = calYear
    if (newMonth > 11) { newMonth = 0; newYear++ }
    if (newMonth < 0) { newMonth = 11; newYear-- }
    setCalMonth(newMonth)
    setCalYear(newYear)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Total Hours (YTD)"
          value={kpis.total_hours_ytd?.toLocaleString() ?? '0'}
          unit="hrs"
          accent="primary"
          icon={Clock}
          breakdownRows={[
            { label: 'Billable', value: `${kpis.billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.success },
            { label: 'Non-Billable', value: `${kpis.non_billable_hours?.toLocaleString() ?? 0} hrs`, color: COLORS.muted },
          ]}
        />
        <KpiCard
          label="Total Requests"
          value={String(kpis.total_requests ?? 0)}
          accent="success"
          icon={FileText}
          breakdownRows={[
            { label: 'Approved', value: String(kpis.approved_count ?? 0), color: COLORS.success },
            { label: 'Pending', value: String(kpis.pending_count ?? 0), color: COLORS.warning },
            { label: 'Rejected', value: String(kpis.rejected_count ?? 0), color: COLORS.destructive },
          ]}
        />
        <KpiCard
          label="Shortage & Penalty"
          value={String(kpis.shortage_hours ?? 0)}
          unit="hrs"
          accent="warning"
          icon={RefreshCw}
          breakdownRows={[
            { label: 'Shortage', value: `${kpis.shortage_hours ?? 0} hrs`, color: COLORS.warning },
            { label: 'Penalty', value: `${kpis.penalty_hours ?? 0} hrs`, color: COLORS.destructive },
          ]}
        />
        <KpiCard
          label="Target Hours"
          value={kpis.target_hours?.toLocaleString() ?? '0'}
          unit="target"
          accent="info"
          icon={Target}
          breakdownRows={[
            { label: 'Actual Logged', value: `${kpis.total_hours_ytd?.toLocaleString() ?? 0} hrs`, color: COLORS.indigo },
            { label: 'Draft', value: `${kpis.draft_count ?? 0} sheets`, color: COLORS.muted },
          ]}
        />
      </div>

      <div>
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-3">
          Time Tracking View
          <span className="flex-1 h-px bg-border" />
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4">
          <div>
            {timeView === 'month' ? (
              <MonthlyCalendar
                calendarHours={calendarHours}
                calYear={calYear}
                calMonth={calMonth}
                onChangeMonth={changeMonth}
                timeView={timeView}
                onViewChange={setTimeView}
              />
            ) : (
              <WeeklyCalendar
                calendarHours={calendarHours}
                weekRef={weekRef}
                onChangeWeek={(dir) => {
                  const d = new Date(weekRef)
                  d.setDate(d.getDate() + dir * 7)
                  setWeekRef(d)
                }}
                timeView={timeView}
                onViewChange={setTimeView}
              />
            )}
          </div>

          <div className="rounded-xl border bg-card p-5 flex flex-col min-h-[400px]">
            <p className="text-sm font-semibold text-foreground">Monthly Hours by Project</p>
            <p className="text-xs text-muted-foreground mb-5">Project breakdown per month · Current FY</p>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyProjectHours} stackOffset="none">
                  <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
                  <RechartsTooltip content={<ChartTooltipContent />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: COLORS.muted }} />
                  <ReferenceLine y={160} stroke={COLORS.warning} strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: '160h target', position: 'right', fontSize: 10, fill: COLORS.warning }} />
                  {projectNames.map((name, i) => (
                    <Bar key={name} dataKey={name} name={name} stackId="stack" fill={PROJECT_COLORS[i % PROJECT_COLORS.length]} radius={i === projectNames.length - 1 ? [4, 4, 0, 0] : undefined} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="px-5 py-4 border-b">
          <p className="text-sm font-semibold text-foreground">Recent Weekly Timesheets</p>
          <p className="text-xs text-muted-foreground">Submission status · Hours · Approval chain</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Week</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Total Hrs</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Billable</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Non-Bill</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Shortage</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Status</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Submitted</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">Approval</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentTimesheets.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="p-0">
                  <EmptyState icon={Inbox} title="No timesheets yet" description="Your weekly timesheets will appear here." />
                </TableCell>
              </TableRow>
            )}
            {recentTimesheets.map((row) => (
              <TableRow key={row.week_start_date as string}>
                <TableCell className="text-sm text-foreground">{row.week_label as string}</TableCell>
                <TableCell className="text-sm text-foreground">{row.total_hours as number}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.billable_hours as number}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.non_billable_hours as number}</TableCell>
                <TableCell className={`text-sm font-medium ${(row.shortage_hours as number) > 0 ? 'text-warning' : 'text-success'}`}>
                  {row.shortage_hours as number}
                </TableCell>
                <TableCell><TimesheetStatusBadge status={row.status as string} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{(row.submitted_at as string) ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{(row.approval_turnaround as string) ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function TimesheetAnalyticsContent() {
  return (
    <Tabs defaultValue="descriptive">
      <TabsList>
        <TabsTrigger value="descriptive">Descriptive</TabsTrigger>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span><TabsTrigger value="prescriptive" disabled className="opacity-50 cursor-not-allowed">Prescriptive</TabsTrigger></span></TooltipTrigger><TooltipContent>Coming soon</TooltipContent></Tooltip></TooltipProvider>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><span><TabsTrigger value="predictive" disabled className="opacity-50 cursor-not-allowed">Predictive</TabsTrigger></span></TooltipTrigger><TooltipContent>Coming soon</TooltipContent></Tooltip></TooltipProvider>
      </TabsList>
      <TabsContent value="descriptive" className="mt-6">
        <DescriptiveTab />
      </TabsContent>
    </Tabs>
  )
}

export { TimesheetAnalyticsContent as EmployeeTimesheetContent }

export default function EmployeeTimesheetAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="My Timesheet Analytics" subtitle="Personal time tracking insights" />
      <TimesheetAnalyticsContent />
    </div>
  )
}
