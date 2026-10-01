/**
 * Receipt drop zone matching the Attach Receipts design: a dashed card with a
 * cloud icon, a "Browse Files" button and the size/format hint.
 *
 * Purely the picker + validation. The parent owns the file list (`value`) and
 * decides when to upload — on a new expense they are staged until the draft
 * exists, on an existing one they upload immediately.
 */
import * as React from 'react'
import { UploadCloud, X, FileText, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const ACCEPT_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.jpg',
  '.jpeg',
  '.png',
  '.svg',
]
const MAX_SIZE_MB = 10

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  value: File[]
  onChange: (files: File[]) => void
  maxFiles?: number
  /** Draws the drop zone with a red border to flag a failed required check. */
  invalid?: boolean
}

export function ReceiptDropzone({
  value,
  onChange,
  maxFiles = 10,
  invalid = false,
}: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [errors, setErrors] = React.useState<string[]>([])
  const [isDragging, setIsDragging] = React.useState(false)

  const getExtension = (name: string) => {
    const dot = name.lastIndexOf('.')
    return dot === -1 ? '' : name.slice(dot).toLowerCase()
  }

  function validate(file: File, currentCount: number): string | null {
    if (!ACCEPT_EXTENSIONS.includes(getExtension(file.name)))
      return `${file.name} — unsupported file type`
    if (file.size > MAX_SIZE_MB * 1024 * 1024)
      return `${file.name} — exceeds ${MAX_SIZE_MB} MB`
    if (currentCount >= maxFiles)
      return `${file.name} — attachment limit of ${maxFiles} reached`
    return null
  }

  function ingest(incoming: FileList | File[]) {
    const arr = Array.isArray(incoming) ? incoming : Array.from(incoming)
    const accepted: File[] = []
    const rejects: string[] = []
    let count = value.length
    for (const f of arr) {
      const err = validate(f, count)
      if (err) {
        rejects.push(err)
        continue
      }
      accepted.push(f)
      count += 1
    }
    if (accepted.length) onChange([...value, ...accepted])
    setErrors(rejects)
  }

  const atLimit = value.length >= maxFiles

  // Open a staged (not-yet-uploaded) file in a new tab via a temporary blob URL.
  const openFile = (file: File) => {
    const url = URL.createObjectURL(file)
    window.open(url, '_blank', 'noopener,noreferrer')
    // Give the new tab time to load before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
    setErrors([])
  }

  return (
    <div className="w-full space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_EXTENSIONS.join(',')}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) ingest(e.target.files)
          e.target.value = ''
        }}
      />

      <div
        onDragOver={(e) => {
          if (atLimit) return
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          if (atLimit) return
          if (e.dataTransfer.files?.length) ingest(e.dataTransfer.files)
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          atLimit
            ? 'cursor-not-allowed border-muted-foreground/20 bg-muted/20 opacity-60'
            : isDragging
              ? 'border-primary bg-primary/5'
              : invalid
                ? 'border-destructive bg-card'
                : 'border-muted-foreground/25 bg-card',
        )}
      >
        <UploadCloud className="size-9 text-muted-foreground" strokeWidth={1.5} />
        <p className="text-sm font-semibold text-foreground">
          Drag and drop your files here or
        </p>
        <Button
          type="button"
          variant="secondary"
          className="bg-primary/10 text-primary hover:bg-primary/15"
          disabled={atLimit}
          onClick={() => inputRef.current?.click()}
        >
          Browse Files
        </Button>
        <p className="text-xs text-muted-foreground">
          Maximum file size : {MAX_SIZE_MB}MB. Supported formats : PDF, DOC,
          DOCX, JPG, PNG, SVG
        </p>
      </div>

      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((err, i) => (
            <li
              key={i}
              className="flex items-center gap-1.5 text-xs text-destructive"
            >
              <AlertCircle className="size-3 shrink-0" />
              {err}
            </li>
          ))}
        </ul>
      )}

      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => openFile(f)}
                  className="block max-w-full truncate text-left text-sm font-medium text-foreground hover:text-primary hover:underline"
                  title={`View ${f.name}`}
                >
                  {f.name}
                </button>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(f.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${f.name}`}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
