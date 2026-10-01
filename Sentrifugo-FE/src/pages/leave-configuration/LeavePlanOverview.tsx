import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Users, Building2, Briefcase, Calendar, ChevronDown, ChevronRight,
  Layers, TrendingUp, Clock, Filter, X, Download,
} from 'lucide-react'
import { useGetLeavePlanOverviewQuery, useLazyDownloadLeavePlanOverviewQuery } from '@/store/api/lmsApi'
import { toast } from '@/lib/toast'
import { PageLoader } from '@/components/shared/PageLoader'
import type {
  LeavePlanOverviewBU,
  LeavePlanOverviewDepartment,
  LeavePlanOverviewLeaveType,
  LeavePlanOverviewEmployee,
} from '@/types/leave'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function formatLabel(s: string): string {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const STATUS_CHIP_STYLES: Record<string, string> = {
  permanent:              'bg-badge-active-bg text-badge-active-text border-badge-active-text/20',
  'allocated-to-project': 'bg-indigo-100 text-indigo-800 border-indigo-200',
  bench:                  'bg-primary/10 text-primary border-primary/20',
  'long-leave':           'bg-violet-100 text-violet-800 border-violet-200',
  probation:              'bg-badge-pending-bg text-badge-pending-text border-badge-pending-text/20',
  'notice-period':        'bg-orange-100 text-orange-800 border-orange-200',
  retired:                'bg-muted text-muted-foreground border-border',
  exit:                   'bg-destructive/10 text-destructive border-destructive/20',
  absconded:              'bg-destructive/10 text-destructive border-destructive/20',
}

function statusChipClass(status: string): string {
  return STATUS_CHIP_STYLES[status.toLowerCase()]
    ?? 'bg-muted text-muted-foreground border-border'
}

// ─── Multi-select filter popover ────────────────────────────────────────────

interface FilterOption { id: string; label: string }

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: FilterOption[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) => {
    onChange(
      selected.includes(id)
        ? selected.filter((s) => s !== id)
        : [...selected, id],
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <Filter className="size-3" />
          {label}
          {selected.length > 0 && (
            <span className="ml-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {selected.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="max-h-60 overflow-y-auto p-1">
          {options.map((opt) => (
            <label
              key={opt.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selected.includes(opt.id)}
                onCheckedChange={() => toggle(opt.id)}
              />
              <span className="truncate">{opt.label}</span>
            </label>
          ))}
          {options.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground text-center">No options</p>
          )}
        </div>
        {selected.length > 0 && (
          <div className="border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

interface Props {
  planId?: string
}

export default function LeavePlanOverview({ planId }: Props) {
  const [selectedBUs, setSelectedBUs] = useState<string[]>([])
  const [selectedDepts, setSelectedDepts] = useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])

  const queryParams = useMemo(() => {
    if (!planId) return undefined
    return {
      planId,
      business_unit_ids: selectedBUs.length ? selectedBUs.join(',') : undefined,
      department_ids: selectedDepts.length ? selectedDepts.join(',') : undefined,
      employment_status_keys: selectedStatuses.length ? selectedStatuses.join(',') : undefined,
    }
  }, [planId, selectedBUs, selectedDepts, selectedStatuses])

  const hasFilters = selectedBUs.length > 0 || selectedDepts.length > 0 || selectedStatuses.length > 0

  const { data, isLoading, isFetching } = useGetLeavePlanOverviewQuery(queryParams!, { skip: !queryParams })
  const [triggerDownload, { isFetching: isDownloading }] = useLazyDownloadLeavePlanOverviewQuery()

  const handleExport = async () => {
    if (!queryParams) return
    try {
      const { data: blob } = await triggerDownload(queryParams)
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `leave-plan-overview.xlsx`
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch { toast.error('Failed to download overview') }
  }

  // Build filter options from the first (unfiltered) response so options
  // stay stable as users toggle filters.
  const optionsRef = useRef<{ buOptions: FilterOption[]; deptOptions: FilterOption[]; statusOptions: FilterOption[] } | null>(null)

  const { buOptions, deptOptions, statusOptions } = useMemo(() => {
    if (optionsRef.current && hasFilters) return optionsRef.current
    if (!data) return optionsRef.current ?? { buOptions: [], deptOptions: [], statusOptions: [] }

    const bus: FilterOption[] = data.business_units.map((bu) => ({
      id: bu.id,
      label: bu.name,
    }))

    const depts: FilterOption[] = data.business_units.flatMap((bu) =>
      bu.departments.map((d) => ({ id: d.id, label: d.name })),
    )
    const seenDepts = new Set<string>()
    const uniqueDepts = depts.filter((d) => {
      if (seenDepts.has(d.id)) return false
      seenDepts.add(d.id)
      return true
    })

    const statusSet = new Set<string>()
    for (const bu of data.business_units) {
      for (const dept of bu.departments) {
        for (const key of Object.keys(dept.employee_counts.by_status)) {
          statusSet.add(key)
        }
      }
    }
    const statuses: FilterOption[] = Array.from(statusSet)
      .sort()
      .map((key) => ({ id: key, label: formatLabel(key) }))

    const result = { buOptions: bus, deptOptions: uniqueDepts, statusOptions: statuses }
    optionsRef.current = result
    return result
  }, [data, hasFilters])

  const clearAllFilters = () => {
    setSelectedBUs([])
    setSelectedDepts([])
    setSelectedStatuses([])
  }

  if (isLoading) return <PageLoader />
  if (!data) return <div className="text-muted-foreground text-center py-12">No overview data available</div>

  const calendarStart =
    data.calendar_start_month >= 1 && data.calendar_start_month <= 12
      ? MONTH_NAMES[data.calendar_start_month - 1]
      : 'January'

  return (
    <div className="space-y-6">

      {/* Plan identity */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">{data.plan_name}</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
          <Calendar className="size-3.5" />
          Leave year starts in {calendarStart}
        </span>
      </div>

      {/* Filters + Export */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          label="Business Unit"
          options={buOptions}
          selected={selectedBUs}
          onChange={setSelectedBUs}
        />
        <MultiSelectFilter
          label="Department"
          options={deptOptions}
          selected={selectedDepts}
          onChange={setSelectedDepts}
        />
        <MultiSelectFilter
          label="Employment Status"
          options={statusOptions}
          selected={selectedStatuses}
          onChange={setSelectedStatuses}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={clearAllFilters}>
            <X className="size-3" />
            Clear all
          </Button>
        )}
        {isFetching && (
          <span className="text-xs text-muted-foreground animate-pulse ml-1">Updating…</span>
        )}

        <div className="ml-auto">
          <Button
            variant="default"
            className="gap-2"
            disabled={isDownloading}
            onClick={handleExport}
          >
            <Download className="size-4" />
            {isDownloading ? 'Exporting…' : 'Export to Excel'}
          </Button>
        </div>
      </div>

      {/* Summary stat cards — 5 cols on lg+ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
          <Users className="size-8 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground font-medium">Total Employees</p>
            <p className="text-2xl font-bold text-foreground">{data.totals.total_employees}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
          <Building2 className="size-8 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground font-medium">Business Units</p>
            <p className="text-2xl font-bold text-foreground">{data.totals.total_business_units}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
          <Layers className="size-8 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground font-medium">Departments</p>
            <p className="text-2xl font-bold text-foreground">{data.totals.total_departments}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
          <Briefcase className="size-8 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground font-medium">Leave Types</p>
            <p className="text-2xl font-bold text-foreground">{data.leave_types.length}</p>
          </div>
        </div>
        {data.totals.total_leaves_allocated != null && (
          <div className="flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
            <TrendingUp className="size-8 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground font-medium">Total Days Allocated</p>
              <p className="text-2xl font-bold text-foreground">{data.totals.total_leaves_allocated}</p>
            </div>
          </div>
        )}
      </div>

      {/* Employees by employment type (active types only) */}
      {data.employment_status_counts && data.employment_status_counts.length > 0 && (
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Users className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Employees by Employment Type</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {data.employment_status_counts.map((s) => (
              <div
                key={s.key}
                className="rounded-lg border bg-muted/20 px-4 py-3 flex items-center justify-between gap-2"
              >
                <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', statusChipClass(s.key))}>
                  {s.label}
                </span>
                <span className="text-xl font-bold text-foreground">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Assignment drill-down — Plan → BU → Dept */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Assignment Breakdown</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data.totals.total_business_units} business unit{data.totals.total_business_units !== 1 ? 's' : ''} ·{' '}
            {data.totals.total_departments} department{data.totals.total_departments !== 1 ? 's' : ''} ·{' '}
            {data.totals.total_employees} employee{data.totals.total_employees !== 1 ? 's' : ''}
          </p>
          {data.totals.leaves_allocated_by_employee_type &&
            Object.keys(data.totals.leaves_allocated_by_employee_type).length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {Object.entries(data.totals.leaves_allocated_by_employee_type).map(([status, days]) => (
                <span
                  key={status}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
                    statusChipClass(status),
                  )}
                >
                  <span className="font-medium">{formatLabel(status)}</span>
                  · {days} days
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="p-5">
          {data.business_units.length === 0 ? (
            <p className="text-sm text-muted-foreground">No assignments configured.</p>
          ) : (
            <div className="space-y-3">
              {data.business_units.map((bu) => (
                <BUCard key={bu.id} bu={bu} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Probation + Leave Types */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Probation Configuration */}
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Probation Configuration</span>
          </div>
          {data.probation_config ? (
            <div className="space-y-3">
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                  data.probation_config.enabled
                    ? 'bg-success/10 text-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {data.probation_config.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {data.probation_config.enabled && (
                <div className="space-y-2">
                  {data.probation_config.credit_mode && (
                    <div>
                      <p className="text-xs text-muted-foreground">Credit Mode</p>
                      <p className="text-sm font-medium text-foreground">
                        {formatLabel(data.probation_config.credit_mode)}
                      </p>
                    </div>
                  )}
                  {data.probation_config.probation_duration_months != null && (
                    <div>
                      <p className="text-xs text-muted-foreground">Duration</p>
                      <p className="text-sm font-medium text-foreground">
                        {data.probation_config.probation_duration_months} months
                      </p>
                    </div>
                  )}
                  {data.probation_config.band_rules.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Band Rules</p>
                      <div className="space-y-1">
                        {data.probation_config.band_rules.map((rule, i) => (
                          <p key={i} className="text-xs text-foreground">
                            Month {rule.from_month}–{rule.to_month}: {rule.credit_amount} {rule.unit}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Not configured</p>
          )}
        </div>

        {/* Leave Types — internal scroll, no expand */}
        <LeaveTypesCard leaveTypes={data.leave_types} />
      </div>

      {/* Per-employee allocation, broken down by leave type */}
      {data.employees && data.employees.length > 0 && (
        <EmployeeAllocationTable employees={data.employees} leaveTypes={data.leave_types} />
      )}

    </div>
  )
}

// ─── Employee allocation by leave type ────────────────────────────────────────

const EMP_PAGE_SIZE = 10

function EmployeeAllocationTable({
  employees, leaveTypes,
}: {
  employees: LeavePlanOverviewEmployee[]
  leaveTypes: LeavePlanOverviewLeaveType[]
}) {
  const [search, setSearch] = useState('')
  const [buFilter, setBuFilter] = useState('all')
  const [deptFilter, setDeptFilter] = useState('all')
  const [page, setPage] = useState(1)

  const buOptions = useMemo(
    () => Array.from(new Set(employees.map((e) => e.business_unit_name).filter(Boolean))).sort(),
    [employees],
  )
  const deptOptions = useMemo(
    () =>
      Array.from(
        new Set(
          employees
            .filter((e) => buFilter === 'all' || e.business_unit_name === buFilter)
            .map((e) => e.department_name)
            .filter(Boolean),
        ),
      ).sort(),
    [employees, buFilter],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return employees.filter((e) => {
      if (buFilter !== 'all' && e.business_unit_name !== buFilter) return false
      if (deptFilter !== 'all' && e.department_name !== deptFilter) return false
      if (q && !`${e.name} ${e.email} ${e.emp_code}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [employees, search, buFilter, deptFilter])

  // Reset to page 1 whenever the filters change.
  useEffect(() => {
    setPage(1)
  }, [search, buFilter, deptFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / EMP_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * EMP_PAGE_SIZE
  const pageRows = filtered.slice(start, start + EMP_PAGE_SIZE)
  const colCount = 3 + leaveTypes.length + 1

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b space-y-3">
        <div>
          <div className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Employee Allocation by Leave Type</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Annual leaves each employee receives this leave year, broken down by leave type.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search name, email, or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-60 text-sm"
          />
          <Select
            value={buFilter}
            onValueChange={(v) => {
              setBuFilter(v)
              setDeptFilter('all')
            }}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Business Unit" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Business Units</SelectItem>
              {buOptions.map((b) => (
                <SelectItem key={b} value={b}>{b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={deptFilter} onValueChange={setDeptFilter}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Departments</SelectItem>
              {deptOptions.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ml-auto">
            {filtered.length} employee{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="bg-table-header border-b border-table-border">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide sticky left-0 bg-table-header">Employee</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">Department</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
              {leaveTypes.map((lt) => (
                <th key={lt.id} className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                  {lt.name}
                </th>
              ))}
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Total</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No employees match your filters.
                </td>
              </tr>
            ) : (
              pageRows.map((emp, i) => (
                <tr key={`${emp.emp_code}-${start + i}`} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-2.5 text-sm text-foreground sticky left-0 bg-card">
                    <div className="font-medium">{emp.name}</div>
                    <div className="text-xs text-muted-foreground">{emp.emp_code}{emp.email ? ` · ${emp.email}` : ''}</div>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">{emp.department_name}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', statusChipClass(emp.status_key))}>
                      {formatLabel(emp.status_key)}
                    </span>
                  </td>
                  {leaveTypes.map((lt) => (
                    <td key={lt.id} className="px-4 py-2.5 text-sm text-foreground text-right">
                      {emp.allocation_by_leave_type?.[lt.name] ?? 0}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-sm font-semibold text-foreground text-right">
                    {emp.total_days_allocated}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-t">
        <span className="text-xs text-muted-foreground">
          {filtered.length === 0
            ? 'No employees'
            : `Showing ${start + 1}–${Math.min(start + EMP_PAGE_SIZE, filtered.length)} of ${filtered.length}`}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Prev
          </Button>
          <span className="text-xs text-muted-foreground">Page {safePage} of {totalPages}</span>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Leave Types card ─────────────────────────────────────────────────────────

function LeaveTypesCard({ leaveTypes }: { leaveTypes: LeavePlanOverviewLeaveType[] }) {
  return (
    <div className="rounded-xl border bg-card flex flex-col max-h-[280px] overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b shrink-0">
        <Briefcase className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Leave Types</span>
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground ml-1">
          {leaveTypes.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {leaveTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground px-5 py-4">No leave types configured</p>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 z-10">
              <tr className="bg-table-header border-b border-table-border">
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Leave Type
                </th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Allocated / year
                </th>
              </tr>
            </thead>
            <tbody>
              {leaveTypes.map((lt) => {
                const unit = (lt.unit ?? 'DAYS').toLowerCase()
                return (
                  <tr key={lt.id} className="border-b last:border-0">
                    <td className="px-5 py-3 text-sm text-foreground">
                      <span>{lt.name}</span>
                      {lt.is_statutory && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Statutory
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-foreground text-right">
                      {lt.annual_allocated != null ? `${lt.annual_allocated} ${unit}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── BU card ─────────────────────────────────────────────────────────────────

function BUCard({ bu }: { bu: LeavePlanOverviewBU }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-xl border overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-4 text-left hover:bg-accent transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-8 rounded-lg bg-primary/10">
            <Building2 className="size-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{bu.name}</p>
            <p className="text-xs text-muted-foreground">
              {bu.departments.length} dept · {bu.employee_counts.total} emp.
              {bu.total_leaves_allocated != null && ` · ${bu.total_leaves_allocated} days allocated`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Per-status: emp count paired with days allocated */}
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(bu.employee_counts.by_status).map(([status, count]) => (
              <span
                key={status}
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs',
                  statusChipClass(status),
                )}
              >
                {formatLabel(status)}: {count} emp.
                {bu.leaves_allocated_by_employee_type?.[status] != null &&
                  ` · ${bu.leaves_allocated_by_employee_type[status]} days`}
              </span>
            ))}
          </div>
          {expanded
            ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 py-3 bg-muted/20">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Departments</p>
          <div className="space-y-2">
            {bu.departments.map((dept) => (
              <DeptRow key={dept.id} dept={dept} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Department row (expandable — shows type breakdown on expand) ─────────────

function DeptRow({ dept }: { dept: LeavePlanOverviewDepartment }) {
  const [expanded, setExpanded] = useState(false)

  // Merge by_status (emp counts) with leaves_allocated_by_employee_type (days)
  const allStatuses = Array.from(
    new Set([
      ...Object.keys(dept.employee_counts.by_status),
      ...Object.keys(dept.leaves_allocated_by_employee_type ?? {}),
    ])
  )
  const hasBreakdown = allStatuses.length > 0

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-3 text-left hover:bg-accent transition-colors"
        onClick={() => hasBreakdown && setExpanded((v) => !v)}
        style={{ cursor: hasBreakdown ? 'pointer' : 'default' }}
      >
        <div className="flex items-center gap-2">
          <Layers className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{dept.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{dept.employee_counts.total} emp.</span>
          {dept.total_leaves_allocated != null && (
            <span className="text-xs font-semibold text-foreground">
              {dept.total_leaves_allocated} days
            </span>
          )}
          {hasBreakdown && (
            expanded
              ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && hasBreakdown && (
        <div className="border-t">
          <table className="w-full">
            <thead>
              <tr className="bg-table-header border-b border-table-border">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Employee Type
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Employees
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Days Allocated
                </th>
              </tr>
            </thead>
            <tbody>
              {allStatuses.map((status) => (
                <tr key={status} className="border-b last:border-0">
                  <td className="px-4 py-2.5 text-sm text-foreground">{formatLabel(status)}</td>
                  <td className="px-4 py-2.5 text-sm text-foreground text-right">
                    {dept.employee_counts.by_status[status] ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-foreground text-right">
                    {dept.leaves_allocated_by_employee_type?.[status] ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
