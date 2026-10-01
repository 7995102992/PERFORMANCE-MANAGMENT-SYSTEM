import { useState } from 'react'
import { Loader2, BarChart3 } from 'lucide-react'

import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  useGetSrBusinessUnitsQuery, useGetSrBuComparisonQuery,
  type BusinessUnitInfo,
} from '@/store/api/srmApi'

import { AnalyticsScaffold, SectionLabel, KpiCard, ChartCard, DataTable } from './_kit'

type ViewMode = 'view' | 'compare'

// SR Analytics — "Organisation" (CXO / org-wide) dashboard.
// Backend role: "cxo"  ·  route: /service-request/analytics/org
// CXO-only business-unit selector: View BU (scope the dashboard to one BU) /
// Compare BUs (side-by-side metrics across BUs).
export default function OrgServiceRequestAnalytics() {
  const [bu, setBu] = useState('all')
  const [mode, setMode] = useState<ViewMode>('view')
  const { data: buData } = useGetSrBusinessUnitsQuery()
  const businessUnits = buData?.business_units ?? []

  const toolbar = (
    <BuToolbar businessUnits={businessUnits} selected={bu} onSelect={setBu} mode={mode} onMode={setMode} />
  )

  if (mode === 'compare') {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Organisation" subtitle="Organization-wide service request performance" />
        {toolbar}
        <BuComparison />
      </div>
    )
  }

  return (
    <AnalyticsScaffold
      role="cxo"
      title="Organisation"
      subtitle="Organization-wide service request performance"
      toolbar={toolbar}
      businessUnitId={bu === 'all' ? undefined : bu}
      render={(f) => {
        const kpis = f.cards('descriptive')
        const volByCat = f.chartById('descriptive', 'volume_by_category')
        const slaByPri = f.chartById('descriptive', 'sla_by_priority')
        const escRootCause = f.chartById('descriptive', 'escalation_root_cause')
        const topExecutors = f.tableById('descriptive', 'top_executors')
        const deptHealth = f.tableById('descriptive', 'department_health')

        return (
          <div className="space-y-5">
            <SectionLabel>Executive Scorecard</SectionLabel>
            {kpis.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {kpis.map((c) => <KpiCard key={c.id} card={c} />)}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {volByCat && <ChartCard chart={volByCat} />}
              {slaByPri && <ChartCard chart={slaByPri} />}
            </div>
            {escRootCause && <ChartCard chart={escRootCause} />}
            <SectionLabel>Department SRM Health</SectionLabel>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {topExecutors && <DataTable table={topExecutors} />}
              {deptHealth && <DataTable table={deptHealth} />}
            </div>
          </div>
        )
      }}
    />
  )
}

// ── Business-unit selector + View/Compare toggle (matches the design mockup) ──
function BuToolbar({
  businessUnits, selected, onSelect, mode, onMode,
}: {
  businessUnits: BusinessUnitInfo[]
  selected: string
  onSelect: (v: string) => void
  mode: ViewMode
  onMode: (m: ViewMode) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-foreground">Business Unit</span>
        <Select value={selected} onValueChange={onSelect}>
          <SelectTrigger className="h-9 w-[220px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Business Units</SelectItem>
            {businessUnits.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center rounded-lg border overflow-x-auto">
        <Button variant="ghost" size="sm"
          className={cn('rounded-none h-8', mode === 'view' && 'bg-accent text-foreground')}
          onClick={() => onMode('view')} aria-pressed={mode === 'view'}>
          View BU
        </Button>
        <Button variant="ghost" size="sm"
          className={cn('rounded-none h-8', mode === 'compare' && 'bg-accent text-foreground')}
          onClick={() => onMode('compare')} aria-pressed={mode === 'compare'}>
          Compare BUs
        </Button>
      </div>
    </div>
  )
}

// ── Compare-BUs view: key-metrics grouped bar + SLA-compliance trend line ──
function BuComparison() {
  const { data, isFetching, isError } = useGetSrBuComparisonQuery()

  if (isFetching && !data) {
    return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }
  if (isError || !data || data.charts.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-12">
        <EmptyState icon={BarChart3} title="No business units to compare"
          description="No business units with service request categories were found." />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <SectionLabel>Business Unit Comparison</SectionLabel>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {data.charts.map((c) => <ChartCard key={c.id} chart={c} />)}
      </div>
    </div>
  )
}
