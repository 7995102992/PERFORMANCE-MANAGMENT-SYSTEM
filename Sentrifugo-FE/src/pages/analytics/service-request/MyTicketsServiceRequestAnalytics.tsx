import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import {
  AnalyticsScaffold, SectionLabel, KpiCard, PredCard, AlertCard, ChartCard, DataTable,
} from './_kit'

// SR Analytics — "My Tickets" (Employee) dashboard.
// Backend role: "employee"  ·  route: /service-request/analytics/my-tickets
export default function MyTicketsServiceRequestAnalytics() {
  return (
    <AnalyticsScaffold
      role="employee"
      title="My Tickets"
      subtitle="Track, manage, and forecast your service requests"
      render={(f) => {
        const kpis = f.cards('descriptive')
        const activeTable = f.tableById('descriptive', 'my_active_tickets')
        const catChart = f.chartById('descriptive', 'requests_by_category')
        const volChart = f.chartById('descriptive', 'monthly_volume')
        const timeline = f.tableById('descriptive', 'my_timeline')
        const statusChart = f.chartById('descriptive', 'requests_by_status')
        const priorityChart = f.chartById('descriptive', 'requests_by_priority')
        const recentResolved = f.tableById('descriptive', 'recently_resolved')
        const prescAlerts = f.alerts('prescriptive')
        const resChart = f.chartById('prescriptive', 'resolution_vs_target')
        const predCards = f.cards('predictive')

        return (
          <Tabs defaultValue="descriptive" className="space-y-6">
            {/* Tab bar only shows once Prescriptive/Predictive are enabled (currently hidden). */}
            {(f.has('prescriptive') || f.has('predictive')) && (
              <TabsList>
                <TabsTrigger value="descriptive">Descriptive</TabsTrigger>
                {f.has('prescriptive') && <TabsTrigger value="prescriptive">Prescriptive</TabsTrigger>}
                {f.has('predictive') && <TabsTrigger value="predictive">Predictive</TabsTrigger>}
              </TabsList>
            )}

            {/* ── DESCRIPTIVE ── */}
            <TabsContent value="descriptive" className="space-y-5">
              <SectionLabel>My Request Snapshot</SectionLabel>
              {kpis.length > 0 && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {kpis.map((c) => <KpiCard key={c.id} card={c} />)}
                </div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
                {activeTable && <DataTable table={activeTable} />}
                {catChart && <ChartCard chart={catChart} />}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {volChart && <ChartCard chart={volChart} />}
                {timeline && <DataTable table={timeline} />}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {statusChart && <ChartCard chart={statusChart} />}
                {priorityChart && <ChartCard chart={priorityChart} />}
              </div>
              {recentResolved && <DataTable table={recentResolved} />}
            </TabsContent>

            {/* ── PRESCRIPTIVE ── */}
            {f.has('prescriptive') && (
              <TabsContent value="prescriptive" className="space-y-5">
                <SectionLabel>Actions &amp; Recommendations</SectionLabel>
                <div className="space-y-3">{prescAlerts.map((a) => <AlertCard key={a.id} alert={a} />)}</div>
                {resChart && <ChartCard chart={resChart} />}
              </TabsContent>
            )}

            {/* ── PREDICTIVE ── */}
            {f.has('predictive') && (
              <TabsContent value="predictive" className="space-y-5">
                <SectionLabel>Predictions for My Requests</SectionLabel>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {predCards.map((c) => <PredCard key={c.id} card={c} />)}
                </div>
              </TabsContent>
            )}
          </Tabs>
        )
      }}
    />
  )
}
