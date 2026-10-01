import { PageHeader } from '@/components/shared/PageHeader'
import { LeaveAnalyticsContent } from './LeaveAnalyticsPage'

export default function AnalyticsLanding() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="My Leave Analytics"
        subtitle="View your leave analytics and insights"
      />
      <LeaveAnalyticsContent />
    </div>
  )
}
