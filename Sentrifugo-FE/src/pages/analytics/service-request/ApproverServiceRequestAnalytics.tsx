import { AnalyticsScaffold, SectionLabel, KpiCard, ChartCard, DataTable } from './_kit'

// SR Analytics — "My Approvals" (Approver) dashboard.
// Backend role: "approver"  ·  route: /service-request/analytics/approver
// Descriptive only for now; layout mirrors the approver_srm mockup.
export default function ApproverServiceRequestAnalytics() {
  return (
    <AnalyticsScaffold
      role="approver"
      title="My Approvals"
      subtitle="My pending approval queue, decision history, and performance"
      render={(f) => {
        const kpis = f.cards('descriptive')
        const decisionChart = f.chartById('descriptive', 'decision_distribution')
        const volumeChart = f.chartById('descriptive', 'monthly_approvals')
        const turnaroundChart = f.chartById('descriptive', 'turnaround_by_priority')
        const pendingDecisions = f.tableById('descriptive', 'pending_decisions')

        return (
          <div className="space-y-5">
            <SectionLabel>Approval Queue Overview</SectionLabel>
            {kpis.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((c) => <KpiCard key={c.id} card={c} />)}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
              {pendingDecisions && <DataTable table={pendingDecisions} />}
              {decisionChart && <ChartCard chart={decisionChart} />}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {volumeChart && <ChartCard chart={volumeChart} />}
              {turnaroundChart && <ChartCard chart={turnaroundChart} />}
            </div>
          </div>
        )
      }}
    />
  )
}
