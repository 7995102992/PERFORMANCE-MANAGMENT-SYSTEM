import { useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PayrollChartRange } from '@/types/payroll'
import {
  useGetPayrollSummaryQuery,
  useGetPayrollSummaryChartQuery,
  useGetMyPayrollSummaryQuery,
  useGetMyPayrollSummaryChartQuery,
} from '@/store/api/payrollApi'
import { money } from './format'

const COLORS = {
  net: '#6f5cff',
  deductions: '#22d3ee',
  earnings: '#a78bfa',
  empty: '#eef0f4',
  muted: '#6c6f89',
  grid: '#f0eff6',
}

const RANGE_LABELS: Record<PayrollChartRange, string> = {
  '1y': '1 Year',
  '6m': '6 Months',
  '3m': '3 Months',
}

const toLakh = (v: number) => (v ? `${(v / 100000).toFixed(0)}L` : '0')

interface ChartRow {
  name: string
  net: number
  deductions: number
  total: number
  hasData: boolean
  placeholder: number
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  const row = payload?.[0]?.payload
  if (!active || !row?.hasData) return null
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{row.name}</p>
      {[
        ['Net Amount', row.net],
        ['Deductions', row.deductions],
        ['Total Earnings', row.total],
      ].map(([label, value]) => (
        <p key={label as string} className="flex justify-between gap-6">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-foreground">{money(value as number)}</span>
        </p>
      ))}
    </div>
  )
}

/**
 * Payroll summary: gross/net + YTD stats and the monthly stacked-bar chart.
 * `scope="org"` uses the org-wide endpoints; `scope="me"` uses the caller's own.
 */
export function PayrollOverview({ scope = 'org' }: { scope?: 'org' | 'me' }) {
  const isMe = scope === 'me'
  const [range, setRange] = useState<PayrollChartRange>('1y')

  const orgSummary = useGetPayrollSummaryQuery(undefined, { skip: isMe })
  const mySummary = useGetMyPayrollSummaryQuery(undefined, { skip: !isMe })
  const { data: summary, isLoading } = isMe ? mySummary : orgSummary

  const orgChart = useGetPayrollSummaryChartQuery(range, { skip: isMe })
  const myChart = useGetMyPayrollSummaryChartQuery(range, { skip: !isMe })
  const { data: chart } = isMe ? myChart : orgChart

  const moneyVal = (n?: number | null) => (n != null ? money(n) : isLoading ? '…' : '—')
  const stringValue = (n?: number | null) => (n != null ? String(n) : isLoading ? '…' : '—')
  const periodTitle = summary?.period_label ?? (isLoading ? '…' : 'Latest payroll')

  const points = chart?.points ?? []
  const maxTotal = points.reduce((m, p) => Math.max(m, p.total_earnings), 0)
  const rows: ChartRow[] = points.map((p) => ({
    name: p.month_label.slice(0, 3),
    net: p.net_amount,
    deductions: p.deductions,
    total: p.total_earnings,
    hasData: p.has_data,
    placeholder: p.has_data ? 0 : maxTotal,
  }))

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
      {/* Overview */}
      <div className="flex flex-col justify-center gap-4 rounded-xl border bg-card p-6 lg:col-span-2">
        <h3 className="text-sm font-semibold text-foreground">{periodTitle}</h3>

        <div className="border-t border-dashed" />

        <div className="flex items-center gap-6">
          <div className="flex-1">
            <Stat label="Total Gross Pay" value={moneyVal(summary?.total_gross_pay)} />
          </div>
          <div className="h-10 w-px shrink-0 bg-border" />
          <div className="flex-1">
            <Stat label="YTD" value={moneyVal(summary?.total_gross_pay_ytd)} />
          </div>
        </div>

        <div className="border-t border-dashed" />

        <div className="flex items-center gap-6">
          <div className="flex-1">
            <Stat label="Total Net Pay" value={moneyVal(summary?.total_net_pay)} />
          </div>
          <div className="h-10 w-px shrink-0 bg-border" />
          <div className="flex-1">
            <Stat label="YTD" value={moneyVal(summary?.total_net_pay_ytd)} />
          </div>
        </div>
        <div className="border-t border-dashed" />

        <div className="flex items-center gap-6">
          <div className="flex-1">
            {isMe ? (
              <Stat label="No. of Payslips" value={stringValue(summary?.no_of_payslips)} />
            ) : (
              <Stat label="No. of Employees" value={stringValue(summary?.no_of_employees)} />
            )}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="rounded-xl border bg-card p-5 lg:col-span-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Payslip Summary</h3>
          <Select value={range} onValueChange={(v) => setRange(v as PayrollChartRange)}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RANGE_LABELS) as PayrollChartRange[]).map((r) => (
                <SelectItem key={r} value={r}>
                  {RANGE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={rows} barCategoryGap="28%">
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: COLORS.muted }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={toLakh}
              tick={{ fontSize: 11, fill: COLORS.muted }}
              axisLine={false}
              tickLine={false}
            />
            <RechartsTooltip cursor={{ fill: 'transparent' }} content={<ChartTooltip />} />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11 }}
              payload={[
                { value: 'Net Amount', type: 'circle', color: COLORS.net, id: 'net' },
                { value: 'Deductions', type: 'circle', color: COLORS.deductions, id: 'ded' },
                { value: 'Total Earnings', type: 'circle', color: COLORS.earnings, id: 'tot' },
              ]}
            />
            {/* Net + Deductions stack to Total Earnings; empty months show a grey placeholder. */}
            <Bar dataKey="net" name="Net Amount" stackId="a" fill={COLORS.net} />
            <Bar
              dataKey="deductions"
              name="Deductions"
              stackId="a"
              fill={COLORS.deductions}
              radius={[4, 4, 0, 0]}
            />
            <Bar dataKey="placeholder" stackId="a" fill={COLORS.empty} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold text-foreground">{value}</p>
    </div>
  )
}
