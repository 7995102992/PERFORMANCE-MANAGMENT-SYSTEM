import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { Clock, Ticket, LogOut } from 'lucide-react'
import { useLocation } from '@tanstack/react-router'

const moduleConfig: Record<string, { label: string; icon: typeof Clock; description: string }> = {
  'service-request': {
    label: 'Service Request',
    icon: Ticket,
    description: 'Service request analytics and trends will be available here.',
  },
  time: {
    label: 'Time',
    icon: Clock,
    description: 'Timesheet analytics and reports will be available here.',
  },
  exit: {
    label: 'Exit',
    icon: LogOut,
    description: 'Exit process analytics and reports will be available here.',
  },
}

export default function AnalyticsComingSoon() {
  const { pathname } = useLocation()
  const segments = pathname.split('/').filter(Boolean)

  let roleLabel = 'My'
  let moduleKey = 'service-request'

  if (segments.includes('manager')) {
    roleLabel = 'Manager'
    moduleKey = segments[segments.indexOf('manager') + 1] ?? 'service-request'
  } else if (segments.includes('hr')) {
    roleLabel = 'HR'
    moduleKey = segments[segments.indexOf('hr') + 1] ?? 'service-request'
  } else {
    moduleKey = segments[segments.indexOf('analytics') + 1] ?? 'service-request'
  }

  const config = moduleConfig[moduleKey] ?? moduleConfig['service-request']

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={`${roleLabel} ${config.label} Analytics`}
        subtitle="Coming soon"
      />
      <div className="rounded-xl border bg-card p-12">
        <EmptyState
          icon={config.icon}
          title="Coming Soon"
          description={config.description}
        />
      </div>
    </div>
  )
}
