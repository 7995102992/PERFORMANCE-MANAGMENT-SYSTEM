// Shared building blocks for the Service Request role analytics dashboards.
// Every persona dashboard (My Tickets / Team / My Work / My Approvals / Org)
// renders the same generic AnalyticsDashboard envelope from `/analytics/dashboard`
// using these primitives, then lays out its own widgets by id. Extracted from the
// employee (My Tickets) dashboard so all five share one source of truth and theme.
import {
  Loader2, Inbox, BarChart3, Info, AlertTriangle, CheckCircle2, AlertCircle,
} from 'lucide-react'
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend,
} from 'recharts'

import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  useGetSrAnalyticsDashboardQuery,
  type AnalyticsDashboard, type AnalyticsCard, type AnalyticsAlert,
  type AnalyticsChart, type AnalyticsTable,
} from '@/store/api/srmApi'

const SERIES_COLORS = ['#6f5cff', '#22c55e', '#f59e0b', '#007cf0', '#ef4444']
const ACCENT_BAR: Record<AnalyticsCard['intent'], string> = {
  neutral: 'bg-primary', good: 'bg-success', warning: 'bg-warning', critical: 'bg-destructive',
}
const VALUE_CLASS: Record<AnalyticsCard['intent'], string> = {
  neutral: 'text-foreground', good: 'text-success', warning: 'text-warning', critical: 'text-destructive',
}
const BADGE_CLASS: Record<string, string> = {
  good: 'bg-success/10 text-success', warning: 'bg-warning/10 text-warning',
  critical: 'bg-destructive/10 text-destructive', neutral: 'bg-muted text-muted-foreground',
}
const ALERT_STYLE: Record<AnalyticsAlert['severity'], { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: 'border-primary/20 bg-primary/5', icon: Info, iconClass: 'text-primary' },
  warning: { box: 'border-warning/20 bg-warning/5', icon: AlertTriangle, iconClass: 'text-warning' },
  success: { box: 'border-success/20 bg-success/5', icon: CheckCircle2, iconClass: 'text-success' },
  critical: { box: 'border-destructive/20 bg-destructive/5', icon: AlertCircle, iconClass: 'text-destructive' },
}

// ── Section divider label (uppercase + trailing rule), mirrors the mockup ──
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-1">
      <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">{children}</span>
      <span className="flex-1 h-px bg-border" />
    </div>
  )
}

// ── KPI card with colored top accent ──
export function KpiCard({ card }: { card: AnalyticsCard }) {
  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <div className={cn('h-1', ACCENT_BAR[card.intent])} />
      <div className="px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</p>
        <p className={cn('text-2xl font-bold mt-1.5', VALUE_CLASS[card.intent])}>{card.value}</p>
        {card.sub_label && <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">{card.sub_label}</p>}
      </div>
    </div>
  )
}

// ── Prediction card (label · big value · description), 3-up grid ──
export function PredCard({ card }: { card: AnalyticsCard }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</p>
      <p className={cn('text-2xl font-bold mt-2', VALUE_CLASS[card.intent])}>{card.value}</p>
      {card.sub_label && <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">{card.sub_label}</p>}
    </div>
  )
}

export function AlertCard({ alert }: { alert: AnalyticsAlert }) {
  const s = ALERT_STYLE[alert.severity]
  const Icon = s.icon
  return (
    <div className={cn('flex gap-3 rounded-xl border px-4 py-3', s.box)}>
      <Icon className={cn('size-5 shrink-0 mt-0.5', s.iconClass)} />
      <div>
        <p className="text-sm font-semibold text-foreground">{alert.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{alert.message}</p>
      </div>
    </div>
  )
}

export function ChartBody({ chart }: { chart: AnalyticsChart }) {
  const hasData = chart.labels.length > 0 && chart.series.some((s) => s.data.some((v) => v))
  const rows = chart.labels.map((l, i) => {
    const row: Record<string, string | number> = { name: l }
    chart.series.forEach((s) => (row[s.name] = s.data[i] ?? 0))
    return row
  })
  if (!hasData) return <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">No data</div>
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        {chart.type === 'doughnut' ? (
          <PieChart>
            <Pie data={chart.labels.map((l, i) => ({ name: l, value: chart.series[0]?.data[i] ?? 0 }))}
              dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
              {chart.labels.map((_, i) => <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />)}
            </Pie>
            <RechartsTooltip /><Legend />
          </PieChart>
        ) : chart.type === 'line' ? (
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#00000010" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} />
            <RechartsTooltip />{chart.series.length > 1 && <Legend />}
            {chart.series.map((s, i) => <Line key={s.name} type="monotone" dataKey={s.name} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} />)}
          </LineChart>
        ) : (
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#00000010" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} />
            <RechartsTooltip />{chart.series.length > 1 && <Legend />}
            {chart.series.map((s, i) => <Bar key={s.name} dataKey={s.name} stackId={chart.stacked ? 'stack' : undefined} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[4, 4, 0, 0]} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

// Chart wrapped in a titled card.
export function ChartCard({ chart }: { chart: AnalyticsChart }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-4">{chart.title}</h3>
      <ChartBody chart={chart} />
    </div>
  )
}

export function DataTable({ table }: { table: AnalyticsTable }) {
  return (
    <div className="rounded-xl border overflow-x-auto bg-card">
      <div className="border-b px-4 py-3"><h3 className="text-sm font-semibold text-foreground">{table.title}</h3></div>
      <Table>
        <TableHeader>
          <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
            {table.columns.map((c) => (
              <TableHead key={c.key} className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">{c.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.length === 0 && (
            <TableRow><TableCell colSpan={table.columns.length} className="p-0">
              <EmptyState icon={Inbox} title="No data" description="Nothing to show yet." />
            </TableCell></TableRow>
          )}
          {table.rows.map((row, ri) => (
            <TableRow key={ri}>
              {table.columns.map((c) => {
                const raw = row[c.key]
                if (c.type === 'badge') {
                  const intent = (row[`${c.key}_intent`] as string) || 'neutral'
                  return <TableCell key={c.key}>
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded', BADGE_CLASS[intent] ?? BADGE_CLASS.neutral)}>{String(raw ?? '—')}</span>
                  </TableCell>
                }
                return <TableCell key={c.key} className="text-sm text-foreground">{String(raw ?? '—')}</TableCell>
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── widget lookups by id (bespoke layouts pull specific widgets) ──
function makeFinders(data: AnalyticsDashboard) {
  const tab = (key: string) => data.tabs.find((t) => t.key === key)
  const cards = (key: string) => tab(key)?.sections.flatMap((s) => s.cards) ?? []
  const chartById = (key: string, id: string) => tab(key)?.sections.flatMap((s) => s.charts).find((c) => c.id === id)
  const tableById = (key: string, id: string) => tab(key)?.sections.flatMap((s) => s.tables).find((t) => t.id === id)
  const alerts = (key: string) => tab(key)?.sections.flatMap((s) => s.alerts) ?? []
  const has = (key: string) => !!tab(key)
  return { cards, chartById, tableById, alerts, has }
}

export type DashboardFinders = ReturnType<typeof makeFinders>

// ── Scaffold: shared header + loading/error states for every role dashboard ──
// `render` receives the widget finders and the raw dashboard once data is ready.
// `toolbar` (optional) renders below the header in every state — used by the CXO
// dashboard for the business-unit selector. `businessUnitId` scopes the query.
export function AnalyticsScaffold({
  role, title, subtitle, render, toolbar, businessUnitId,
}: {
  role: string
  title: string
  subtitle: string
  render: (f: DashboardFinders, data: AnalyticsDashboard) => React.ReactNode
  toolbar?: React.ReactNode
  businessUnitId?: string
}) {
  const { data, isFetching, isError } = useGetSrAnalyticsDashboardQuery({ role, businessUnitId })

  if (isFetching && !data) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title={title} subtitle={subtitle} />
        {toolbar}
        <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title={title} subtitle={subtitle} />
        {toolbar}
        <div className="rounded-xl border bg-card p-12">
          <EmptyState icon={BarChart3} title="No analytics access"
            description="You don't have permission to view this dashboard. Contact your administrator." />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader title={title} subtitle={subtitle} />
      {toolbar}
      {render(makeFinders(data), data)}
    </div>
  )
}
