import { useEffect, useState } from 'react'
import {
  Search,
  Download,
  Inbox,
  AlertTriangle,
  Loader2,
  ChevronsUpDown,
  CalendarDays,
  CheckCircle2,
} from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { TablePagination } from '@/components/shared/TablePagination'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { MONTH_LABELS } from '@/types/payroll'
import { useListPayslipsQuery, getPayrollErrorMessage } from '@/store/api/payrollApi'
import { useAppSelector } from '@/store'
import { toast } from '@/lib/toast'
import { formatDate, money } from './format'
import { useEmployeeLookup } from './useEmployeeLookup'
import { PayrollOverview } from './PayrollOverview'

const HEADERS: { label: string; sortable?: boolean }[] = [
  { label: 'Pay Period', sortable: true },
  { label: 'Employee Name' },
  { label: 'Employee ID' },
  { label: 'Gross', sortable: true },
  { label: 'Deductions', sortable: true },
  { label: 'Net Pay', sortable: true },
  { label: 'Uploaded By', sortable: true },
  { label: 'Status' },
]
const COLUMN_COUNT = HEADERS.length + 1

// GET /payslips/export?format=pdf — selected employees' payslips: one PDF, or a ZIP for several.
const EXPORT_BASE = `${(import.meta.env.VITE_PAYROLL_BASE_URL ?? '').replace(/\/+$/, '')}/payslips/export`

/**
 * Uploader shown in the "Uploaded By" cell: the denormalised name when the
 * payslip carries one, otherwise the directory lookup for `uploaded_by`, which
 * itself degrades to the raw id and then to an em dash.
 */
const uploaderName = (
  row: { uploaded_by_name?: string | null; uploaded_by?: string | null },
  nameOf: (id: string | null | undefined) => string,
) => row.uploaded_by_name?.trim() || nameOf(row.uploaded_by)

const filenameFromDisposition = (disposition: string, fallback: string) => {
  const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition)
  return match ? decodeURIComponent(match[1]) : fallback
}

export default function EmployeePayroll() {
  const now = new Date()
  const token = useAppSelector((s) => s.auth.accessToken)
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(5)
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const effectiveSearch = debouncedSearch

  const query = useListPayslipsQuery({
    year,
    month,
    search: effectiveSearch || undefined,
    page,
    page_size: pageSize,
  })
  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = query.data?.total_pages ?? 1

  const lookup = useEmployeeLookup()

  const resetView = () => {
    setPage(1)
    setSelected(new Set())
  }
  const onMonthChange = (v: string) => {
    setMonth(Number(v))
    resetView()
  }
  const onYearChange = (v: string) => {
    setYear(Number(v))
    resetView()
  }
  const onSearchChange = (v: string) => {
    setSearch(v)
    resetView()
  }

  const toggleRow = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })

  const pageIds = items.map((i) => i.user_id)
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const someChecked = pageIds.some((id) => selected.has(id))
  const headerChecked: boolean | 'indeterminate' = allChecked
    ? true
    : someChecked
      ? 'indeterminate'
      : false

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (allChecked) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })

  // Download the SELECTED employees' payslips as PDF (one) or ZIP (several).
  const handleDownload = async () => {
    if (selected.size === 0) return
    setExporting(true)
    try {
      const qs = new URLSearchParams({ year: String(year), month: String(month), format: 'pdf' })
      if (effectiveSearch) qs.set('search', effectiveSearch)
      selected.forEach((id) => qs.append('user_ids', id))
      const res = await fetch(`${EXPORT_BASE}?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        toast.error('Could not download payslips. Please try again.')
        return
      }
      const pinEmailed = res.headers.get('X-Payslip-Pin-Emailed') === 'true'
      const fallback =
        selected.size === 1
          ? `payslip_${year}_${String(month).padStart(2, '0')}.pdf`
          : `payslips_${year}_${String(month).padStart(2, '0')}.zip`
      const filename = filenameFromDisposition(res.headers.get('Content-Disposition') ?? '', fallback)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast.success(
        selected.size > 1 ? 'Payslips downloaded' : 'Payslip downloaded',
        pinEmailed
          ? 'A PIN to open them has been emailed to you.'
          : 'Open them with your Secure PIN.',
      )
      setSelected(new Set())
    } catch {
      toast.error('Could not download payslips. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  const startIndex = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endIndex = Math.min(page * pageSize, total)

  return (
    <div className="space-y-5 p-6">
      {/* Overview + chart (mock) */}
      <PayrollOverview />

      {/* Employee payslips */}
      <div className="overflow-hidden rounded-xl border bg-card">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search Employee by name or id"
              className="h-9 pl-9"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>

          <Select value={String(year)} onValueChange={onYearChange}>
            <SelectTrigger className="h-9 w-36 gap-2">
              <CalendarDays className="size-4 text-primary" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={String(month)} onValueChange={onMonthChange}>
            <SelectTrigger className="h-9 w-36 gap-2">
              <CalendarDays className="size-4 text-primary" />
              <SelectValue placeholder="Month" />
            </SelectTrigger>
            <SelectContent>
              {MONTH_LABELS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            className="ml-auto gap-2"
            onClick={handleDownload}
            disabled={selected.size === 0 || exporting}
          >
            {exporting ? <Loader2 className="size-4 animate-spin text-primary" /> : <Download className="size-4 text-primary" />}
            Download{selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="border-b border-table-border bg-table-header hover:bg-table-header">
              <TableHead className="h-10 w-10">
                <Checkbox
                  checked={headerChecked}
                  onCheckedChange={toggleAll}
                  disabled={items.length === 0}
                  aria-label="Select all"
                />
              </TableHead>
              {HEADERS.map((h) => (
                <TableHead
                  key={h.label}
                  className="h-10 text-xs font-normal uppercase tracking-wide text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-1">
                    {h.label}
                    {h.sortable && <ChevronsUpDown className="size-3" />}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="h-40 text-center">
                  <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : query.isError ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="p-0">
                  <EmptyState
                    icon={AlertTriangle}
                    variant="error"
                    title="Couldn't load payroll"
                    description={getPayrollErrorMessage(query.error)}
                    action={
                      <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="p-0">
                  <EmptyState
                    icon={Inbox}
                    title="No payroll found"
                    description="No employee payroll matches the selected period or filters."
                  />
                </TableCell>
              </TableRow>
            ) : (
              items.map((r) => {
                const name = r.full_name ?? lookup.infoFor(r.user_id, r.emp_code)?.name ?? '—'
                return (
                  <TableRow key={r.id}>
                    <TableCell className="w-10">
                      <Checkbox
                        checked={selected.has(r.user_id)}
                        onCheckedChange={() => toggleRow(r.user_id)}
                        aria-label={`Select ${r.emp_code}`}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-foreground">
                      {MONTH_LABELS[r.month - 1]} {r.year}
                    </TableCell>
                    <TableCell className="text-sm font-medium text-foreground">{name}</TableCell>
                    <TableCell className="text-sm text-foreground">{r.emp_code}</TableCell>
                    <TableCell className="text-sm text-foreground">{money(r.earnings.total)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {money(r.deductions.total)}
                    </TableCell>
                    <TableCell className="text-sm font-semibold text-foreground">
                      {money(r.net_amount)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {/* Denormalised name when the payslip has one; older rows
                          predate it, so those still resolve the id through the
                          directory (which itself falls back to the raw id). */}
                      <span
                        className="block max-w-[140px] truncate text-foreground"
                        title={uploaderName(r, lookup.nameOf)}
                      >
                        {uploaderName(r, lookup.nameOf)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDate(r.uploaded_on)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm text-success">
                        <CheckCircle2 className="size-4" />
                        Processed
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>

        <TablePagination
          currentPage={page}
          totalPages={totalPages}
          startIndex={startIndex}
          endIndex={endIndex}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s)
            setPage(1)
          }}
        />
      </div>
    </div>
  )
}
