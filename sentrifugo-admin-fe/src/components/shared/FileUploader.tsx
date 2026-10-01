import * as React from 'react'
import {
  Upload, X, FileText, FileSpreadsheet, FileImage, File,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(mimeType: string) {
  if (mimeType.includes('pdf'))
    return <FileText className="h-9 w-9 text-red-500 shrink-0" />
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv'))
    return <FileSpreadsheet className="h-9 w-9 text-green-600 shrink-0" />
  if (mimeType.includes('word') || mimeType.includes('document'))
    return <FileText className="h-9 w-9 text-blue-600 shrink-0" />
  if (mimeType.startsWith('image/'))
    return <FileImage className="h-9 w-9 text-violet-500 shrink-0" />
  return <File className="h-9 w-9 text-muted-foreground shrink-0" />
}

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'text/csv': 'CSV',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface FileUploaderProps {
  /** Currently selected file (controlled) */
  value?: File | null
  onChange: (file: File | null) => void
  /** MIME types to accept. Defaults to common documents. */
  accept?: string[]
  maxSizeMB?: number
  className?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FileUploader({
  value,
  onChange,
  accept = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
  ],
  maxSizeMB = 2,
  className,
}: FileUploaderProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)

  const extLabels = accept.map((t) => MIME_TO_EXT[t] ?? t.split('/')[1]?.toUpperCase() ?? t)

  function validate(file: File): string | null {
    if (accept.length > 0 && !accept.includes(file.type))
      return `File type not supported. Accepted: ${extLabels.join(', ')}`
    if (file.size > maxSizeMB * 1024 * 1024)
      return `File exceeds ${maxSizeMB} MB limit.`
    return null
  }

  function handleFile(file: File) {
    const err = validate(file)
    if (err) { setError(err); return }
    setError(null)
    onChange(file)
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div className={cn('w-full space-y-3', className)}>
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(',')}
        className="hidden"
        onChange={handleInputChange}
      />

      {!value ? (
        /* ── Drop zone ── */
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 transition-colors',
            isDragging
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-muted-foreground/20 bg-muted/30 text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/50',
          )}
        >
          <div className={cn(
            'flex items-center justify-center rounded-full p-3',
            isDragging ? 'bg-primary/10' : 'bg-background shadow-sm',
          )}>
            <Upload className="h-6 w-6" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">
              <span className={isDragging ? 'text-primary' : 'text-foreground'}>
                Click to upload
              </span>
              {' '}or drag &amp; drop
            </p>
            <p className="mt-0.5 text-xs">
              {extLabels.join(' · ')} &mdash; max {maxSizeMB} MB
            </p>
          </div>
        </div>
      ) : (
        /* ── Selected file ── */
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
          {getFileIcon(value.type)}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{value.name}</p>
            <p className="text-xs text-muted-foreground">{formatBytes(value.size)}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => { setError(null); onChange(null) }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  )
}
