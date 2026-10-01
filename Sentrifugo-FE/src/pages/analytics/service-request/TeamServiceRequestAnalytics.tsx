import { AnalyticsScaffold, SectionLabel, KpiCard, ChartCard, DataTable } from './_kit'

// SR Analytics — "Team" (Manager) dashboard.
// Backend role: "manager"  ·  route: /service-request/analytics/team
// Descriptive only for now (prescriptive/predictive builders not yet enabled
// server-side); layout mirrors the employee dashboard + manager_srm mockup.
export default function TeamServiceRequestAnalytics() {
  return (
    <AnalyticsScaffold
      role="manager"
      title="Team"
      subtitle="Team requests, approval queue, and SLA management"
      render={(f) => {
        const kpis = f.cards('descriptive')
        const statusChart = f.chartById('descriptive', 'team_by_status')
        const catSlaChart = f.chartById('descriptive', 'team_sla_by_category')
        const turnaroundChart = f.chartById('descriptive', 'my_approval_turnaround')
        const pendingQueue = f.tableById('descriptive', 'pending_queue')

        return (
          <div className="space-y-5">
            <SectionLabel>Team Snapshot</SectionLabel>
            {kpis.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((c) => <KpiCard key={c.id} card={c} />)}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
              {pendingQueue && <DataTable table={pendingQueue} />}
              {statusChart && <ChartCard chart={statusChart} />}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {catSlaChart && <ChartCard chart={catSlaChart} />}
              {turnaroundChart && <ChartCard chart={turnaroundChart} />}
            </div>
          </div>
        )
      }}
    />
  )
}
