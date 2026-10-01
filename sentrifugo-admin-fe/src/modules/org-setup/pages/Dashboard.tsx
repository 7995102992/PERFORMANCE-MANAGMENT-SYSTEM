import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Users, Building2, Layers, UserPlus, Circle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/api/query-keys'
import { orgDashboardService } from '@/api/org-setup/dashboard'
import { useAppSelector } from '@/store'

// Keep these display labels in sync with the BE MODULE_LABELS
// (Sentrifugo-IAM-Admin-BE/src/models.py). Any module missing here would
// otherwise render as its raw snake_case code (e.g. "service_request").
const MODULE_LABELS: Record<string, string> = {
  core_hr: 'Core HR',
  attendance_management: 'Attendance Management',
  leave_management: 'Leave Management',
  payroll: 'Payroll',
  performance_management: 'Performance Management',
  recruitment: 'Recruitment',
  training_and_development: 'Training & Development',
  expense_management: 'Expense Management',
  asset_management: 'Asset Management',
  service_request: 'Service Request',
  timesheet_management: 'Timesheet Management',
}

export function OrgDashboard() {
  const navigate = useNavigate()
  const user = useAppSelector((s) => s.auth.user)

  const { data: stats, isLoading } = useQuery({
    queryKey: queryKeys.orgDashboard.stats,
    queryFn: () => orgDashboardService.getStats(),
  })

  const firstName = user?.first_name || 'Admin'

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl">Welcome back, {firstName}!</h1>
        <p className="text-muted-foreground mt-1">
          Here's what's happening with your organisation today.
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<Users className="size-5" />}
          label="Total Employees"
          value={stats?.total_employees}
          isLoading={isLoading}
        />
        <StatCard
          icon={<Building2 className="size-5" />}
          label="Business Units"
          value={stats?.total_business_units}
          isLoading={isLoading}
        />
        <StatCard
          icon={<Layers className="size-5" />}
          label="Departments"
          value={stats?.total_departments}
          isLoading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recent Activities */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Activities</CardTitle>
              <p className="text-sm text-muted-foreground">Latest updates from your organisation</p>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground text-center py-8">
                No recent activities yet.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Quick Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                className="w-full justify-start gap-3"
                onClick={() => navigate({ to: '/employees/create' })}
              >
                <UserPlus className="size-4" />
                Add Employee
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-3"
                onClick={() => navigate({ to: '/settings/departments' })}
              >
                <Layers className="size-4" />
                View Departments
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-3"
                onClick={() => navigate({ to: '/settings/business-units' })}
              >
                <Building2 className="size-4" />
                View Business Units
              </Button>
            </CardContent>
          </Card>

          {/* Active Modules */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Active Modules</CardTitle>
              <p className="text-sm text-muted-foreground">Enabled features</p>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : stats?.enabled_modules?.length ? (
                <ul className="space-y-3">
                  {stats.enabled_modules.map((mod) => {
                    const code = typeof mod === 'string' ? mod : mod.code
                    const active = typeof mod === 'string' ? true : mod.is_active
                    return (
                      <li key={code} className="flex items-center gap-2 text-sm">
                        <Circle className={`size-2 ${active ? 'fill-success text-success' : 'fill-muted-foreground/30 text-muted-foreground/30'}`} />
                        <span className={active ? '' : 'text-muted-foreground line-through'}>
                          {MODULE_LABELS[code] ?? code}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No modules enabled.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  isLoading,
}: {
  icon: React.ReactNode
  label: string
  value?: number
  isLoading: boolean
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-icon-bg text-icon">
          {icon}
        </div>
        <div>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p className="text-3xl font-bold">{value?.toLocaleString() ?? 0}</p>
          )}
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
