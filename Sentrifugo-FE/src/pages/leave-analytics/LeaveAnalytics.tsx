import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, FileSpreadsheet, Search, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { useGetYearEndReportDataQuery } from '@/store/api/lmsApi'
import { toast } from '@/lib/toast'
import { getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'

const LMS_BASE_URL = import.meta.env.VITE_LMS_API_URL || 'http://localhost:8001'

export function YearEndProcessingContent() {
  const [planFilter, setPlanFilter] = useState<string>('')
  const [yearFilter, setYearFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [isDownloading, setIsDownloading] = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  const { data, isLoading } = useGetYearEndReportDataQuery({
    leave_plan_id: planFilter && planFilter !== 'all' ? planFilter : undefined,
    year: yearFilter && yearFilter !== 'all' ? Number(yearFilter) : undefined,
  })

  const records = data?.records ?? []
  const plans = data?.plans ?? []
  const years = data?.years ?? []
  const leaveTypes = data?.leave_types ?? []

  const defaultsApplied = useRef(false)
  useEffect(() => {
    if (defaultsApplied.current || !data) return
    defaultsApplied.current = true

    if (plans.length > 0 && !planFilter) {
      setPlanFilter(plans[0].id)
    }

    const previousYear = new Date().getFullYear() - 1
    if (years.length > 0 && !yearFilter) {
      const match = years.find((y) => y === previousYear)
      setYearFilter(String(match ?? years[0]))
    }
  }, [data])

  const filtered = records.filter((r) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      r.employee_name.toLowerCase().includes(q) ||
      r.emp_code.toLowerCase().includes(q) ||
      r.department.toLowerCase().includes(q) ||
      r.business_unit.toLowerCase().includes(q)
    )
  })

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      const params = new URLSearchParams()
      if (planFilter && planFilter !== 'all') params.set('leave_plan_id', planFilter)
      if (yearFilter && yearFilter !== 'all') params.set('year', yearFilter)

      const token = getCookie('access_token')
      const res = await fetch(
        `${LMS_BASE_URL}/leave-analytics/year-end-report/download?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) throw new Error('Download failed')

      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `Year_End_Report${yearFilter && yearFilter !== 'all' ? `_${yearFilter}` : ''}.xlsx`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch {
      toast.error('Failed to download report')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, code, department..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>

          <Select value={planFilter} onValueChange={setPlanFilter}>
            <SelectTrigger className="w-[200px] h-9">
              <SelectValue placeholder="All Plans" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Plans</SelectItem>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="w-[120px] h-9">
              <SelectValue placeholder="All Years" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto">
            <Button
              variant="outline"
              className="gap-2"
              onClick={handleDownload}
              disabled={isDownloading || filtered.length === 0}
            >
              {isDownloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Export
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="No year-end records found"
            description="Year-end processing records will appear here once processing has been run."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-table-header border-b border-table-border">
                <th className="w-8 px-3 py-2.5" />
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">#</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Emp Code</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Employee Name</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Department</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Business Unit</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Year</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Opening</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Payout</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Carry Fwd</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Expired</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Closing</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((rec, idx) => {
                const isExpanded = expandedRows.has(rec.id)
                const hasPerType = leaveTypes.length > 0 && rec.per_type && Object.keys(rec.per_type).length > 0

                return (
                  <>
                    <tr
                      key={rec.id}
                      className={cn(
                        'border-b border-border transition-colors',
                        hasPerType && 'cursor-pointer hover:bg-muted/30',
                        isExpanded && 'bg-muted/20',
                      )}
                      onClick={() => hasPerType && toggleRow(rec.id)}
                    >
                      <td className="px-3 py-2.5 text-center">
                        {hasPerType && (
                          isExpanded
                            ? <ChevronDown className="size-3.5 text-muted-foreground inline" />
                            : <ChevronRight className="size-3.5 text-muted-foreground inline" />
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{idx + 1}</td>
                      <td className="px-3 py-2.5 font-medium text-foreground">{rec.emp_code}</td>
                      <td className="px-3 py-2.5 text-foreground">{rec.employee_name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{rec.department}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{rec.business_unit}</td>
                      <td className="px-3 py-2.5 text-foreground">{rec.year}</td>
                      <td className="px-3 py-2.5 text-right font-medium text-foreground">{rec.opening_balance}</td>
                      <td className="px-3 py-2.5 text-right text-foreground">{rec.payout_amount}</td>
                      <td className="px-3 py-2.5 text-right text-foreground">{rec.carry_forward_amount}</td>
                      <td className="px-3 py-2.5 text-right text-foreground">{rec.expired_amount}</td>
                      <td className="px-3 py-2.5 text-right font-medium text-foreground">{rec.closing_balance}</td>
                      <td className="px-3 py-2.5">
                        <span className={rec.execution_status === 'SUCCESS' ? 'text-success' : 'text-destructive'}>
                          {rec.execution_status}
                        </span>
                      </td>
                    </tr>

                    {isExpanded && hasPerType && (
                      <tr key={`${rec.id}-detail`} className="border-b border-border bg-muted/10">
                        <td />
                        <td colSpan={12} className="px-3 py-3">
                          <div className="ml-4">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                              Leave Type Breakdown
                            </p>
                            <div className="rounded-lg border overflow-x-auto">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-table-header border-b border-table-border">
                                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Leave Type</th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Opening</th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Payout</th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Carry Forward</th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Expired</th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Closing</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {leaveTypes.map((lt) => {
                                    const detail = rec.per_type?.[lt.name] || {}
                                    return (
                                      <tr key={lt.id} className="border-b border-border last:border-0">
                                        <td className="px-3 py-2 font-medium text-foreground">{lt.name}</td>
                                        <td className="px-3 py-2 text-right text-foreground">{detail.opening_balance ?? 0}</td>
                                        <td className="px-3 py-2 text-right text-foreground">{detail.payout ?? 0}</td>
                                        <td className="px-3 py-2 text-right text-foreground">{detail.carry_forward ?? 0}</td>
                                        <td className="px-3 py-2 text-right text-foreground">{detail.expired ?? 0}</td>
                                        <td className="px-3 py-2 text-right text-foreground">{detail.closing_balance ?? 0}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
  )
}

export default function LeaveAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Leave Analytics"
        subtitle="Year-end processing reports for all employees"
      />
      <YearEndProcessingContent />
    </div>
  )
}
