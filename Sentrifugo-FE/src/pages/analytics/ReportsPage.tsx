import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { FileText } from 'lucide-react'

export default function ReportsPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Reports Dashboard"
        subtitle="Generate and view reports"
      />
      <div className="rounded-xl border bg-card p-12">
        <EmptyState
          icon={FileText}
          title="Coming Soon"
          description="Reports and data exports will be available here."
        />
      </div>
    </div>
  )
}
