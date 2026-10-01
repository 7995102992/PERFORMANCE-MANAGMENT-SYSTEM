import { useEffect, useRef, useState } from 'react'
import {
  CalendarDays,
  Download,
  UploadCloud,
  Loader2,
  ChevronsUpDown,
  CheckCircle2,
  CircleDashed,
  CircleX,
  AlertTriangle,
  Search,
  Inbox,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TablePagination } from '@/components/shared/TablePagination'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  MONTH_LABELS,
  ALLOWED_PAYSLIP_EXTENSIONS,
  MAX_PAYSLIP_SIZE_BYTES,
} from '@/types/payroll'
import type { PayslipValidationResult, UploadedPayslipStatus } from '@/types/payroll'
import {
  useListPayslipUploadsQuery,
  useCreatePayslipUploadMutation,
  useReplacePayslipUploadMutation,
  useValidatePayslipUploadMutation,
  getPayrollError,
  getPayrollErrorMessage,
} from '@/store/api/payrollApi'
import { downloadAuthed } from '@/lib/download'
import { formatDate, money } from './format'
import { Separator } from "@/components/ui/separator"

const SUPPORTED_FORMATS = 'CSV, XLS, XLSX'
const TEMPLATE_BASE = `${(import.meta.env.VITE_PAYROLL_BASE_URL ?? '').replace(/\/+$/, '')}/payslips/uploads/template`
const UPLOADS_BASE = `${(import.meta.env.VITE_PAYROLL_BASE_URL ?? '').replace(/\/+$/, '')}/payslips/uploads`
const TABLE_COLUMN_COUNT = 7

// GET /payslips/uploads/{id}/download — authenticated proxy that decrypts the original xlsx.
// Prefer the server-provided absolute URL; otherwise build it from the payroll base.
const uploadDownloadUrl = (u: { id: string; download_url: string | null }) =>
  u.download_url && /^https?:\/\//i.test(u.download_url)
    ? u.download_url
    : `${UPLOADS_BASE}/${u.id}/download`

const TABLE_HEADERS: { label: string; sortable?: boolean }[] = [
  { label: 'Pay Period', sortable: true },
  { label: 'File Name' },
  { label: 'No. of Records' },
  { label: 'Uploaded By', sortable: true },
  { label: 'Net Total', sortable: true },
  { label: 'Avg. Net', sortable: true },
  { label: 'Status' },
]

const STATUS_META: Record<
  UploadedPayslipStatus,
  { label: string; className: string }
> = {
  processed: { label: 'Processed', className: 'text-success' },
  uploaded: { label: 'Uploaded', className: 'text-info' },
  failed: { label: 'Failed', className: 'text-destructive' },
}

/**
 * Uploader display name. The API denormalises `uploaded_by_name` onto every
 * upload, so this screen no longer fetches the IAM employee directory just to
 * turn one id into one name.
 *
 * Uploads created before the BE populated that field have it null and fall back
 * to the raw `uploaded_by` id — without the directory call there's nothing to
 * resolve it against.
 */
const uploaderName = (u: {
  uploaded_by_name?: string | null
  uploaded_by?: string | null
}): string => u.uploaded_by_name?.trim() || u.uploaded_by || '—'

function StatusCell({ status }: { status?: UploadedPayslipStatus }) {
  const meta = STATUS_META[status ?? 'processed'] ?? STATUS_META.processed
  const Icon = status === 'failed' ? CircleX : status === 'uploaded' ? CircleDashed : CheckCircle2
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', meta.className)}>
      <Icon className="size-4" />
      {meta.label}
    </span>
  )
}

/** Client-side pre-validation that mirrors the server rules. */
function validatePayslipFile(file: File): string | null {
  const lower = file.name.toLowerCase()
  const okExt = ALLOWED_PAYSLIP_EXTENSIONS.some((ext) => lower.endsWith(ext))
  if (!okExt) return `Unsupported file type. Allowed: ${ALLOWED_PAYSLIP_EXTENSIONS.join(', ')}.`
  if (file.size === 0) return 'The selected file is empty.'
  if (file.size > MAX_PAYSLIP_SIZE_BYTES) return 'File is too large. Maximum size is 10 MB.'
  return null
}

function ValidationReport({ result }: { result: PayslipValidationResult }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        {result.valid ? (
          <CheckCircle2 className="size-4 shrink-0 text-success" />
        ) : (
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
        )}
        <span className="font-medium text-foreground">
          {result.valid_rows} valid · {result.error_rows} error{result.error_rows === 1 ? '' : 's'} ·{' '}
          {result.total_rows} rows
        </span>
      </div>

      {result.file_errors.length > 0 && (
        <ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {result.file_errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}

      {result.missing_columns.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Missing columns (import as 0 / blank): {result.missing_columns.join(', ')}
        </p>
      )}

      {!result.employees_checked && (
        <p className="text-xs text-warning">
          Employee verification skipped — the directory was unavailable.
        </p>
      )}

      {result.rows.length > 0 && (
        <div className="max-h-44 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="sticky top-0 z-10 border-b border-table-border bg-table-header hover:bg-table-header">
                {['Row', 'Employee ID', 'Status', 'Issues'].map((h) => (
                  <TableHead
                    key={h}
                    className="h-9 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((r) => (
                <TableRow key={r.row_num}>
                  <TableCell className="text-sm text-foreground">{r.row_num}</TableCell>
                  <TableCell className="text-sm text-foreground">{r.emp_code ?? '—'}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                        r.status === 'valid'
                          ? 'bg-success/10 text-success'
                          : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {r.status === 'valid' ? 'Valid' : 'Error'}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.issues.length ? r.issues.join(', ') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default function NewPayroll() {
  const now = new Date()

  // ── Payslip uploads list (real, server-paginated) + filters ──
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [yearFilter, setYearFilter] = useState('all')
  const [monthFilter, setMonthFilter] = useState('all')
  // Status filter hidden for now:
  // const [statusFilter, setStatusFilter] = useState<'all' | UploadedPayslipStatus>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(5)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const handleDownloadFile = async (u: { id: string; file_name: string; download_url: string | null }) => {
    setDownloadingId(u.id)
    try {
      await downloadAuthed(uploadDownloadUrl(u), u.file_name)
    } catch {
      toast.error('Could not download the file. Please try again.')
    } finally {
      setDownloadingId(null)
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const listQuery = useListPayslipUploadsQuery({
    year: yearFilter === 'all' ? undefined : Number(yearFilter),
    month: monthFilter === 'all' ? undefined : Number(monthFilter),
    search: debouncedSearch || undefined,
    page,
    page_size: pageSize,
  })
  const rows = listQuery.data?.items ?? []
  const total = listQuery.data?.total ?? 0
  const totalPages = listQuery.data?.total_pages ?? 1
  const startIndex = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endIndex = Math.min(page * pageSize, total)

  // ── Upload dialog (real) ──
  const [month, setMonth] = useState(String(now.getMonth() + 1))
  const [year, setYear] = useState(String(now.getFullYear()))
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [templateLoading, setTemplateLoading] = useState(false)
  const [validation, setValidation] = useState<PayslipValidationResult | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const periodQuery = useListPayslipUploadsQuery({ year: Number(year), month: Number(month) })
  const periodRecords = periodQuery.data?.items ?? []
  const exists = periodRecords.length > 0
  const latest = periodRecords[0]
  const reasonRequired = exists

  const [createUpload, createState] = useCreatePayslipUploadMutation()
  const [replaceUpload, replaceState] = useReplacePayslipUploadMutation()
  const [validateUpload, validateState] = useValidatePayslipUploadMutation()
  const uploading = createState.isLoading || replaceState.isLoading
  const validating = validateState.isLoading

  const runValidation = async (f: File, m: number, y: number) => {
    try {
      const result = await validateUpload({ file: f, month: m, year: y }).unwrap()
      setValidation(result)
      if (result.file_errors.length > 0) {
        toast.error('This file cannot be uploaded — see the issues below.')
      }
    } catch (e) {
      toast.error(getPayrollErrorMessage(e, 'Could not validate the file.'))
    }
  }

  const selectFile = (f: File) => {
    const err = validatePayslipFile(f)
    setFile(f)
    setFileError(err)
    setValidation(null)
    if (err) {
      toast.error(err)
      return
    }
    runValidation(f, Number(month), Number(year))
    // Selecting a file for a period that already exists → confirm right away.
    if (exists) setConfirmOpen(true)
  }

  const chooseFile = (list: FileList | null) => {
    const next = list?.[0]
    if (next) selectFile(next)
  }

  const resetUpload = () => {
    setFile(null)
    setFileError(null)
    setValidation(null)
    setReason('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const clearFile = () => {
    resetUpload()
  }

  const onPeriodChange = (m: string, y: string) => {
    setMonth(m)
    setYear(y)
    setValidation(null)
    if (file && !validatePayslipFile(file)) runValidation(file, Number(m), Number(y))
  }

  const handleTemplateDownload = async () => {
    setTemplateLoading(true)
    try {
      const qs = new URLSearchParams({ month, year })
      await downloadAuthed(`${TEMPLATE_BASE}?${qs.toString()}`, 'payslip_upload_template.xlsx')
    } catch {
      toast.error('Could not download the template. Please try again.')
    } finally {
      setTemplateLoading(false)
    }
  }

  const performUpload = async () => {
    if (!file) return
    const base = { file, month: Number(month), year: Number(year) }
    const newVersion = exists && latest ? latest.version + 1 : 1
    try {
      if (exists) {
        await replaceUpload({ ...base, reason: reason.trim() }).unwrap()
      } else {
        await createUpload({ ...base, reason: reason.trim() || undefined }).unwrap()
      }
      toast.success(
        'Payslip uploaded',
        `Version ${newVersion} for ${MONTH_LABELS[Number(month) - 1]} ${year}.`,
      )
      clearFile()
    } catch (e) {
      if (getPayrollError(e)?.code === 'PAYSLIP_UPLOAD_CONFLICT') {
        await periodQuery.refetch()
        toast.error('A payslip already exists for this period. Add a comment and upload a new version.')
        return
      }
      toast.error(getPayrollErrorMessage(e))
    }
  }

  const handleUpload = async () => {
    if (!file) return
    const err = validatePayslipFile(file)
    if (err) {
      setFileError(err)
      toast.error(err)
      return
    }
    if (reasonRequired && !reason.trim()) {
      toast.error('A comment is required to upload a new version.')
      return
    }
    await performUpload()
  }

  const handleConfirmUpdate = () => setConfirmOpen(false)

  const handleCancelUpdate = () => {
    setConfirmOpen(false)
    clearFile()
  }

  const blockedByValidation = validation != null && !validation.valid
  const uploadDisabled =
    !file ||
    !!fileError ||
    uploading ||
    validating ||
    blockedByValidation ||
    (reasonRequired && !reason.trim())

  return (
    <div className="space-y-5 p-6">
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-5 text-warning" />
              <DialogTitle>Payslip already exists</DialogTitle>
            </div>
            <DialogDescription>
              A payslip for {MONTH_LABELS[Number(month) - 1]} {year} already exists. Are you sure you
              want to upload and update it with the new data?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelUpdate}>
              No
            </Button>
            <Button onClick={handleConfirmUpdate}>Yes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-4 sm:items-start sm:justify-between">
          <h2 className="text-lg text-foreground font-medium">
            Create or upload employee&apos;s payslip
          </h2>
          <Button
            variant="outline"
            className="h-9 gap-2"
            onClick={handleTemplateDownload}
            disabled={templateLoading}
          >
            {templateLoading ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <Download className="size-4 text-primary" />
            )}
            Payslip Template
          </Button>
        </div>
        <Separator className="my-5" />

        <div className="mt-5 flex flex-col gap-4 xl:flex-row">
          <div className="space-y-4 rounded-xl p-4 xl:basis-[45%]">
            {!file ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  chooseFile(e.dataTransfer.files)
                }}
                className={cn(
                  'h-full flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-7 text-center transition-colors',
                  dragOver ? 'border-primary bg-primary/5' : 'border-border',
                )}
              >
                <UploadCloud className="size-8 text-muted-foreground" />
                <p className="text-sm text-foreground font-semibold">
                  Drag and drop your files here or{' '}
                </p>
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  className="font-normal bg-[var(--btn-soft)] text-[var(--btn-soft-fg)] hover:bg-[var(--btn-soft)]/90 border-[var(--btn-soft)]">
                  Browse Files
                </Button>
                <p className="text-xs text-muted-foreground">
                  Maximum file size: 10MB. Supported formats: {SUPPORTED_FORMATS}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => chooseFile(e.target.files)}
                />
              </div>
            ) : (
              <div className="space-y-4">

                {validating ? (
                  <div className="flex h-24 items-center justify-center">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : validation ? (
                  <ValidationReport result={validation} />
                ) : (
                  <div className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">
                    File selected. Validation is running.
                  </div>
                )}
              </div>
            )}

            {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          </div>

          <div className="flex flex-col gap-4 rounded-xl bg-card p-4 xl:basis-[55%]">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Select Year<span className="text-destructive">*</span></Label>
                <Select value={year} onValueChange={(v) => onPeriodChange(month, v)}>
                  <SelectTrigger className="h-9 w-full">
                    <CalendarDays className="size-4 text-primary" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Three years back through two ahead — payslips are
                        sometimes uploaded well after the pay period */}
                    {Array.from(
                      { length: 6 },
                      (_, i) => now.getFullYear() - 3 + i,
                    ).map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Select Month<span className="text-destructive">*</span></Label>
                <Select value={month} onValueChange={(v) => onPeriodChange(v, year)}>
                  <SelectTrigger className="h-9 flex-1 gap-2">
                    <CalendarDays className="size-4 text-primary" />
                    <SelectValue placeholder="Select Month" />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_LABELS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="payslip-comment">
                Add Comment{exists && <span className="text-destructive">*</span>}
              </Label>
              <Textarea
                id="payslip-comment"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  exists ? 'Add Comment' : 'Required only when replacing an existing payslip'
                }
                className="min-h-[120px] flex-1 resize-none"
                disabled={!exists}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <Button variant="outline" className="font-normal" onClick={clearFile} disabled={!file}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={uploadDisabled} className="font-normal gap-2 bg-[var(--btn-soft)] text-[var(--btn-soft-fg)] hover:bg-[var(--btn-soft)]/90 border-[var(--btn-soft)]">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : ""}
            Submit
          </Button>
        </div>
      </div>

      {/* Payslip list */}
      <div className="overflow-hidden rounded-xl border bg-card">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by file name or pay period"
              className="h-9 pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
            />
          </div>

          <Select
            value={yearFilter}
            onValueChange={(v) => {
              setYearFilter(v)
              setPage(1)
            }}
          >
            <SelectTrigger className="h-9 w-32 gap-2">
              <CalendarDays className="size-4 text-primary" />
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All years</SelectItem>
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
            }}
          >
            <SelectTrigger className="h-9 w-32 gap-2">
              <CalendarDays className="size-4 text-primary" />
              <SelectValue placeholder="Month" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {MONTH_LABELS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Status filter — hidden for now
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v as 'all' | UploadedPayslipStatus)
              setPage(1)
            }}
          >
            <SelectTrigger className="h-9 w-36">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="processed">Processed</SelectItem>
              <SelectItem value="uploaded">Uploaded</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          */}
        </div>

        <Table>
          <TableHeader>
            <TableRow className="border-b border-table-border bg-table-header hover:bg-table-header">
              {TABLE_HEADERS.map((h) => (
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
            {listQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={TABLE_COLUMN_COUNT} className="h-40 text-center">
                  <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : listQuery.isError ? (
              <TableRow>
                <TableCell colSpan={TABLE_COLUMN_COUNT} className="p-0">
                  <EmptyState
                    icon={AlertTriangle}
                    variant="error"
                    title="Couldn't load payslips"
                    description={getPayrollErrorMessage(listQuery.error)}
                    action={
                      <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={TABLE_COLUMN_COUNT} className="p-0">
                  <EmptyState
                    icon={Inbox}
                    title="No payslips uploaded"
                    description={
                      search || yearFilter !== 'all' || monthFilter !== 'all'
                        ? 'No payslips match your filters.'
                        : 'Uploaded payslips will appear here.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="text-sm text-foreground">
                    {u.period_label ?? `${MONTH_LABELS[u.month - 1]} ${u.year}`}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => handleDownloadFile(u)}
                      disabled={downloadingId === u.id}
                      title={`Download ${u.file_name}`}
                      className="text-left hover:text-primary hover:underline disabled:opacity-60 hover:cursor-pointer"
                    >
                      {u.file_name}
                    </button>
                  </TableCell>
                  <TableCell className="text-sm text-foreground">{u.no_of_records ?? '—'}</TableCell>
                  <TableCell className="text-sm">
                    <span
                      className="block max-w-[160px] truncate text-foreground"
                      title={uploaderName(u)}
                    >
                      {uploaderName(u)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDate(u.uploaded_on)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {u.net_total != null ? money(u.net_total) : '—'}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {u.avg_net != null ? money(u.avg_net) : '—'}
                  </TableCell>
                  <TableCell>
                    <StatusCell status={u.status} />
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
    </div>
  )
}

