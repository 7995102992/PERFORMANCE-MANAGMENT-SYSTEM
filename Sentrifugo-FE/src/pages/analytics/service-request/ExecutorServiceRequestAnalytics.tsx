import { AnalyticsScaffold, SectionLabel, KpiCard, ChartCard, DataTable } from './_kit'

// SR Analytics — "My Work" (Executor) dashboard.
// Backend role: "executor"  ·  route: /service-request/analytics/executor
// Descriptive only for now; layout mirrors the executor_srm mockup.
export default function ExecutorServiceRequestAnalytics() {
  return (
    <AnalyticsScaffold
      role="executor"
      title="My Work"
      subtitle="My assigned tickets, SLA health, and resolution metrics"
      render={(f) => {
        const kpis = f.cards('descriptive')
        const capacityChart = f.chartById('descriptive', 'capacity')
        const distChart = f.chartById('descriptive', 'resolution_distribution')
        const activeTable = f.tableById('descriptive', 'my_active_sla')
        const deptQueue = f.tableById('descriptive', 'dept_queue')

        return (
          <div className="space-y-5">
            <SectionLabel>My Workload</SectionLabel>
            {kpis.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((c) => <KpiCard key={c.id} card={c} />)}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {capacityChart && <ChartCard chart={capacityChart} />}
              {distChart && <ChartCard chart={distChart} />}
            </div>
            {activeTable && <DataTable table={activeTable} />}
            {deptQueue && <DataTable table={deptQueue} />}
          </div>
        )
      }}
    />
  )
}
