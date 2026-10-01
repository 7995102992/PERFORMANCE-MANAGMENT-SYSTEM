import { useEffect, useRef, useState } from 'react'
import {
  UploadCloud,
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CircleX,
  Inbox,
  X,
} from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  MONTH_LABELS,
  ALLOWED_PAYSLIP_EXTENSIONS,
  MAX_PAYSLIP_SIZE_BYTES,
} from '@/types/payroll'
import type { PayslipValidationResult } from '@/types/payroll'
import {
  useValidatePayslipUploadMutation,
  useCreatePayslipUploadMutation,
  getPayrollError,
  getPayrollErrorMessage,
} from '@/store/api/payrollApi'
import { downloadAuthed } from '@/lib/download'
import { toast } from '@/lib/toast'

const SUPPORTED_FORMATS = 'CSV, XLS, XLSX'
const TEMPLATE_BASE = `${(import.meta.env.VITE_PAYROLL_BASE_URL as string).replace(/\/+$/, '')}/payslips/uploads/template`
const COLUMN_COUNT = 6

type BulkStatus =
  | 'validating'
  | 'uploading'
  | 'uploaded'
  | 'warning'
  | 'error'
  | 'failed'
  | 'invalid'
  | 'no_period'

interface BulkFile {
  id: string
  file: File
  period: { month: number; year: number } | null
  status: BulkStatus
  validation?: PayslipValidationResult
  message?: string
}

/** Derive { month, year } from a file name, e.g. "Payslip Jan -2026.csv" or "payslip_2026_06.xlsx". */
function parsePeriod(name: string): { month: number; year: number } | null {
  const lower = name.toLowerCase()

  // YYYY-MM / YYYY_MM / YYYY MM (e.g. payslip_2026_06)
  let m = lower.match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])(?!\d)/)
  if (m) return { year: Number(m[1]), month: Number(m[2]) }

  // MM-YYYY / MM_YYYY (e.g. 06_2026)
  m = lower.match(/(0[1-9]|1[0-2])[-_ ](20\d{2})/)
  if (m) return { year: Number(m[2]), month: Number(m[1]) }

  // month name + year (e.g. may_2026, june-2026)
  const yearMatch = lower.match(/(20\d{2})/)
  if (yearMatch) {
    const year = Number(yearMatch[1])
    for (let i = 0; i < 12; i++) {
      const full = MONTH_LABELS[i].toLowerCase()
      if (lower.includes(full) || new RegExp(`\\b${full.slice(0, 3)}`).test(lower)) {
        return { month: i + 1, year }
      }
    }
  }
  return null
}

function validatePayslipFile(file: File): string | null {
  const lower = file.name.toLowerCase()
  const okExt = ALLOWED_PAYSLIP_EXTENSIONS.some((ext) => lower.endsWith(ext))
  if (!okExt) return `Unsupported file type. Allowed: ${ALLOWED_PAYSLIP_EXTENSIONS.join(', ')}.`
  if (file.size === 0) return 'The selected file is empty.'
  if (file.size > MAX_PAYSLIP_SIZE_BYTES) return 'File is too large. Maximum size is 10 MB.'
  return null
}

const STATUS_META: Record<
  BulkStatus,
  { label: string; className: string; icon: typeof CheckCircle2; spin?: boolean }
> = {
  validating: { label: 'Validating…', className: 'text-muted-foreground', icon: Loader2, spin: true },
  uploading: { label: 'Uploading…', className: 'text-primary', icon: Loader2, spin: true },
  uploaded: { label: 'Uploaded', className: 'text-success', icon: CheckCircle2 },
  warning: { label: 'Has warnings', className: 'text-warning', icon: AlertTriangle },
  error: { label: 'Validation failed', className: 'text-destructive', icon: CircleX },
  failed: { label: 'Upload failed', className: 'text-destructive', icon: CircleX },
  invalid: { label: 'Invalid file', className: 'text-destructive', icon: CircleX },
  no_period: { label: 'No pay period', className: 'text-destructive', icon: CircleX },
}

function StatusPill({ status }: { status: BulkStatus }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', meta.className)}>
      <Icon className={cn('size-4', meta.spin && 'animate-spin')} />
      {meta.label}
    </span>
  )
}

function detailText(f: BulkFile): string {
  if (f.message) return f.message
  if (f.validation) {
    if (f.status === 'error')
      return f.validation.file_errors.join(', ') || `${f.validation.error_rows} row error(s)`
    if (f.status === 'warning') return `${f.validation.error_rows} row(s) with issues`
    if (f.status === 'uploaded') return `${f.validation.valid_rows} record(s) imported`
  }
  return '—'
}

export default function BulkPayslipUpload() {
  const now = new Date()
  const idRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [templateLoading, setTemplateLoading] = useState(false)
  const [files, setFiles] = useState<BulkFile[]>([])

  const [validateUpload] = useValidatePayslipUploadMutation()
  const [createUpload] = useCreatePayslipUploadMutation()

  const patch = (id: string, p: Partial<BulkFile>) =>
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...p } : f)))

  // Upload one already-validated file (clean auto-upload, "upload anyway", or retry).
  const uploadFile = async (item: BulkFile) => {
    if (!item.period) return
    patch(item.id, { status: 'uploading', message: undefined })
    try {
      await createUpload({ file: item.file, month: item.period.month, year: item.period.year }).unwrap()
      patch(item.id, { status: 'uploaded' })
    } catch (e) {
      const conflict = getPayrollError(e)?.code === 'PAYSLIP_UPLOAD_CONFLICT'
      patch(item.id, {
        status: 'failed',
        message: conflict
          ? 'A payslip already exists for this period.'
          : getPayrollErrorMessage(e),
      })
    }
  }

  // Validate, then auto-upload if clean (no file errors and no row errors).
  const processFile = async (item: BulkFile) => {
    const clientErr = validatePayslipFile(item.file)
    if (clientErr) return patch(item.id, { status: 'invalid', message: clientErr })
    if (!item.period)
      return patch(item.id, {
        status: 'no_period',
        message: 'Could not read the pay period from the file name (e.g. "Payslip Jan -2026.csv").',
      })

    patch(item.id, { status: 'validating' })
    try {
      const result = await validateUpload({
        file: item.file,
        month: item.period.month,
        year: item.period.year,
      }).unwrap()
      if (result.file_errors.length > 0) return patch(item.id, { status: 'error', validation: result })
      if (result.error_rows > 0) return patch(item.id, { status: 'warning', validation: result })
      patch(item.id, { validation: result })
      await uploadFile({ ...item, validation: result })
    } catch (e) {
      patch(item.id, { status: 'error', message: getPayrollErrorMessage(e, 'Validation failed.') })
    }
  }

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return
    const incoming: BulkFile[] = Array.from(list).map((file) => ({
      id: String(idRef.current++),
      file,
      period: parsePeriod(file.name),
      status: 'validating' as BulkStatus,
    }))
    setFiles((prev) => [...prev, ...incoming])
    incoming.forEach((item) => processFile(item))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Whole-window drag & drop target.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragOver(true)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragOver(false)
      addFiles(e.dataTransfer?.files ?? null)
    }
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false)
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragleave', onLeave)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragleave', onLeave)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id))
  const clearAll = () => setFiles([])

  const handleTemplateDownload = async () => {
    setTemplateLoading(true)
    try {
      const qs = new URLSearchParams({ month: String(now.getMonth() + 1), year: String(now.getFullYear()) })
      await downloadAuthed(`${TEMPLATE_BASE}?${qs.toString()}`, 'payslip_upload_template.xlsx')
    } catch {
      toast.error('Could not download the template. Please try again.')
    } finally {
      setTemplateLoading(false)
    }
  }

  const uploaded = files.filter((f) => f.status === 'uploaded').length
  const warnings = files.filter((f) => f.status === 'warning').length
  const errored = files.filter((f) =>
    ['error', 'failed', 'invalid', 'no_period'].includes(f.status),
  ).length
  const busy = files.some((f) => f.status === 'validating' || f.status === 'uploading')

  return (
    <div className="space-y-5 p-6">
      {/* Whole-screen drop overlay */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-primary bg-primary/10 text-center backdrop-blur-[1px]">
          <UploadCloud className="size-10 text-primary" />
          <p className="text-base font-semibold text-foreground">Drop payslip files to upload</p>
          <p className="text-xs text-muted-foreground">
            Maximum file size: 10MB. Supported formats: {SUPPORTED_FORMATS}
          </p>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xls,.xlsx"
        multiple
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />

      {/* Results */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            {files.length > 0
              ? `${uploaded} uploaded · ${warnings} warning${warnings === 1 ? '' : 's'} · ${errored} error${errored === 1 ? '' : 's'}`
              : 'No files added yet'}
          </span>
          {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <div className="ml-auto flex items-center gap-2">
            {files.length > 0 && (
              <Button variant="outline" size="sm" onClick={clearAll}>
                Clear all
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleTemplateDownload}
              disabled={templateLoading}
            >
              {templateLoading ? (
                <Loader2 className="size-4 animate-spin text-primary" />
              ) : (
                <Download className="size-4 text-primary" />
              )}
              Template
            </Button>
            <Button size="sm" className="gap-2" onClick={() => fileInputRef.current?.click()}>
              <UploadCloud className="size-4" /> Upload
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="border-b border-table-border bg-table-header hover:bg-table-header">
              {['File Name', 'Pay Period', 'Records', 'Status', 'Details'].map((h) => (
                <TableHead
                  key={h}
                  className="h-10 text-xs font-normal uppercase tracking-wide text-muted-foreground"
                >
                  {h}
                </TableHead>
              ))}
              <TableHead className="h-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="p-0">
                  <EmptyState
                    icon={Inbox}
                    title="No files yet"
                    description="Drag payslip files anywhere on this screen, or use Upload, to validate and upload them."
                  />
                </TableCell>
              </TableRow>
            ) : (
              files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="max-w-[220px] truncate text-sm text-foreground" title={f.file.name}>
                    {f.file.name}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {f.period ? `${MONTH_LABELS[f.period.month - 1]} ${f.period.year}` : '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {f.validation ? `${f.validation.valid_rows}/${f.validation.total_rows}` : '—'}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={f.status} />
                  </TableCell>
                  <TableCell className="max-w-[280px] text-sm text-muted-foreground">
                    {detailText(f)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {f.status === 'warning' && (
                        <Button variant="ghost" size="sm" onClick={() => uploadFile(f)}>
                          Upload anyway
                        </Button>
                      )}
                      {f.status === 'failed' && (
                        <Button variant="ghost" size="sm" onClick={() => uploadFile(f)}>
                          Retry
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => removeFile(f.id)}
                        aria-label="Remove file"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
