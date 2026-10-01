import { useEffect, useRef, useState } from 'react'
import {
  Search,
  Download,
  Printer,
  CalendarDays,
  CheckCircle2,
  CircleDashed,
  CircleX,
  Loader2,
  ChevronsUpDown,
  AlertTriangle,
  Inbox,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/shared/EmptyState'
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TablePagination } from '@/components/shared/TablePagination'
import { useAppSelector } from '@/store'
import { toast } from '@/lib/toast'
import { MONTH_LABELS } from '@/types/payroll'
import type { UploadedPayslipStatus } from '@/types/payroll'
import {
  useGetMyPayslipListQuery,
  useGetMyPayslipViewQuery,
  getPayrollErrorMessage,
} from '@/store/api/payrollApi'
import { money } from './format'
import { PayrollOverview } from './PayrollOverview'

// POST /my-payroll/export-bulk — 1 period → PDF, 2+ → zip of PIN-protected PDFs.
const BULK_EXPORT = `${(import.meta.env.VITE_PAYROLL_BASE_URL ?? '').replace(/\/+$/, '')}/my-payroll/export-bulk`
const COLUMN_COUNT = 6

const filenameFromDisposition = (disposition: string, fallback: string) => {
  const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition)
  return match ? decodeURIComponent(match[1]) : fallback
}

const HEADERS: { label: string; sortable?: boolean }[] = [
  { label: 'Pay Period', sortable: true },
  { label: 'Gross', sortable: true },
  { label: 'Deductions', sortable: true },
  { label: 'Net Pay', sortable: true },
  { label: 'Status' },
]

interface Period {
  year: number
  month: number
}

function StatusChip({ status }: { status: UploadedPayslipStatus }) {
  if (status === 'failed')
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-destructive">
        <CircleX className="size-4" />
        Failed
      </span>
    )
  if (status === 'uploaded')
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-info">
        <CircleDashed className="size-4" />
        Uploaded
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-success">
      <CheckCircle2 className="size-4" />
      Processed
    </span>
  )
}

export default function MyPayroll() {
  const now = new Date()
  const token = useAppSelector((s) => s.auth.accessToken)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [monthFilter, setMonthFilter] = useState('all')
  const [yearFilter, setYearFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [exporting, setExporting] = useState(false)
  // Selected payslips keyed by row id → period (so it survives pagination).
  const [selected, setSelected] = useState<Map<string, Period>>(new Map())
  // Row clicked for the HTML preview.
  const [preview, setPreview] = useState<{ year: number; month: number; label: string } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const query = useGetMyPayslipListQuery({
    year: yearFilter === 'all' ? undefined : Number(yearFilter),
    month: monthFilter === 'all' ? undefined : Number(monthFilter),
    search: debouncedSearch || undefined,
    page,
    page_size: pageSize,
  })
  const rows = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = query.data?.total_pages ?? 1
  const startIndex = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endIndex = Math.min(page * pageSize, total)

  // Standalone payslip HTML for the preview dialog.
  const viewQuery = useGetMyPayslipViewQuery(
    preview ? { year: preview.year, month: preview.month } : { year: 0, month: 0 },
    { skip: !preview },
  )

  const clearSelection = () => setSelected(new Map())

  const toggleRow = (id: string, period: Period) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, period)
      return next
    })

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const someChecked = rows.some((r) => selected.has(r.id))
  const headerChecked: boolean | 'indeterminate' = allChecked
    ? true
    : someChecked
      ? 'indeterminate'
      : false

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (allChecked) rows.forEach((r) => next.delete(r.id))
      else rows.forEach((r) => next.set(r.id, { year: r.year, month: r.month }))
      return next
    })

  // Download periods — one PDF, or a zip when several are picked.
  const downloadPeriods = async (periods: Period[]): Promise<boolean> => {
    if (!periods.length) return false
    setExporting(true)
    try {
      const res = await fetch(BULK_EXPORT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ periods }),
      })
      if (res.status === 404) {
        toast.info('No payslip found for the selected period(s).')
        return false
      }
      if (!res.ok) {
        toast.error('Could not download payslips. Please try again.')
        return false
      }
      const pinEmailed = res.headers.get('X-Payslip-Pin-Emailed') === 'true'
      const missing = res.headers.get('X-Payslip-Missing-Periods') ?? ''
      const fallback =
        periods.length === 1
          ? `payslip_${periods[0].year}_${String(periods[0].month).padStart(2, '0')}.pdf`
          : 'my_payslips.zip'
      const filename = filenameFromDisposition(res.headers.get('Content-Disposition') ?? '', fallback)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)

      const notes: string[] = []
      if (pinEmailed) notes.push('A PIN to open them has been emailed to you.')
      if (missing) notes.push(`No payslip for: ${missing.replace(/,/g, ', ')}.`)
      toast.success(
        periods.length > 1 ? 'Payslips downloaded' : 'Payslip downloaded',
        notes.join(' ') || undefined,
      )
      return true
    } catch {
      toast.error('Could not download payslips. Please try again.')
      return false
    } finally {
      setExporting(false)
    }
  }

  const handleBulkDownload = async () => {
    const ok = await downloadPeriods(Array.from(selected.values()))
    if (ok) clearSelection()
  }

  const handlePrint = () => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.focus()
    win.print()
  }

  return (
    <div className="space-y-5 p-6">
      {/* Overview + chart (the caller's own data) */}
      <PayrollOverview scope="me" />

      {/* My payslips */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by pay period"
              className="h-9 pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
                clearSelection()
              }}
            />
          </div>

          <Select
            value={yearFilter}
            onValueChange={(v) => {
              setYearFilter(v)
              setPage(1)
              clearSelection()
            }}
          >
            <SelectTrigger className="h-9 w-32 gap-2">
              <CalendarDays className="size-4 text-primary" />
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Year</SelectItem>
              {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Select
            value={monthFilter}
            onValueChange={(v) => {
              setMonthFilter(v)
              setPage(1)
              clearSelection()
            }}
          >
            <SelectTrigger className="h-9 w-36 gap-2">
              <CalendarDays className="size-4 text-primary" />
              <SelectValue placeholder="Month" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Month</SelectItem>
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
            onClick={handleBulkDownload}
            disabled={exporting || selected.size === 0}
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
                  disabled={rows.length === 0}
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
                    title="Couldn't load payslips"
                    description={getPayrollErrorMessage(query.error)}
                    action={
                      <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="p-0">
                  <EmptyState
                    icon={Inbox}
                    title="No payslips yet"
                    description={
                      search || yearFilter !== 'all'
                        ? 'No payslips match your filters.'
                        : 'Your payslips will appear here once payroll is processed.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() =>
                    setPreview({ year: r.year, month: r.month, label: r.period_label })
                  }
                >
                  <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(r.id)}
                      onCheckedChange={() => toggleRow(r.id, { year: r.year, month: r.month })}
                      aria-label={`Select ${r.period_label}`}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-foreground">{r.period_label}</TableCell>
                  <TableCell className="text-sm text-foreground">{money(r.gross)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{money(r.deductions)}</TableCell>
                  <TableCell className="text-sm font-semibold text-foreground">
                    {money(r.net_pay)}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={r.status} />
                  </TableCell>
                </TableRow>
              ))
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

      {/* Payslip preview */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <DialogTitle>Payslip</DialogTitle>
              <DialogDescription>{preview?.label}</DialogDescription>
            </div>
            <div className="flex items-center gap-3 pr-8">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 font-medium hover:bg-transparent"
                onClick={() =>
                  preview && downloadPeriods([{ year: preview.year, month: preview.month }])
                }
                disabled={exporting}
              >
                {exporting ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <Download className="size-4 text-primary" />
                )}
                Download
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 font-medium hover:bg-transparent"
                onClick={handlePrint}
                disabled={!viewQuery.data}
              >
                <Printer className="size-4 text-primary" /> Print
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden bg-muted/20">
            {viewQuery.isFetching ? (
              <div className="flex h-[70vh] items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : viewQuery.isError ? (
              <EmptyState
                icon={AlertTriangle}
                variant="error"
                title="Couldn't load payslip"
                description={getPayrollErrorMessage(viewQuery.error)}
              />
            ) : viewQuery.data ? (
              <iframe
                ref={iframeRef}
                srcDoc={viewQuery.data}
                title="Payslip preview"
                className="h-[70vh] w-full border-0 bg-white"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
