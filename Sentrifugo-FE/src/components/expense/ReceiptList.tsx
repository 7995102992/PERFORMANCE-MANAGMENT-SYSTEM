/**
 * Receipts on an expense (§10).
 *
 * The `×` renders **only when the server says `can_delete`**. A receipt on an
 * in-flight or settled expense is evidence an approver acted on, and allowing
 * removal would let the record be altered after the fact — so the condition
 * (DRAFT + ownership) is computed server-side and read here, never re-derived.
 * The wireframes show the × on submitted expenses; that is correction 2.
 *
 * Downloads go through a short-TTL presigned URL fetched **at click time**. A
 * URL minted on render is dead by the time a slow reader clicks it.
 */
import { useState } from 'react'
import { Download, FileText, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { MultiFileUploader } from '@/components/shared/MultiFileUploader'
import {
  useDeleteReceiptMutation,
  useGetReceiptDownloadUrlMutation,
  useGetReceiptsQuery,
  useUploadReceiptMutation,
} from '@/store/api/expenseApi'
import type { ReceiptResponse } from '@/types/expense'

const MAX_SIZE_MB = 10
const ACCEPT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.svg']

interface Props {
  expenseId: string
  /**
   * The copy embedded on the expense detail. Used only as the first paint —
   * see below for why it cannot be trusted for `can_delete`.
   */
  receipts?: ReceiptResponse[]
  /** False on a read-only detail view; the upload zone is then hidden. */
  canUpload?: boolean
}

export function ReceiptList({ expenseId, receipts = [], canUpload = false }: Props) {
  const [pending, setPending] = useState<File[]>([])
  const [uploadReceipt, { isLoading: uploading }] = useUploadReceiptMutation()
  const [deleteReceipt] = useDeleteReceiptMutation()
  const [getDownloadUrl] = useGetReceiptDownloadUrlMutation()
  const [busyId, setBusyId] = useState<string | null>(null)

  /**
   * Read from the receipts endpoint rather than the copy embedded on the
   * expense.
   *
   * `GET /receipts/expense/{id}` is the only place the server computes
   * `can_delete` — it resolves DRAFT + ownership per caller and stamps each
   * row. The expense detail composes its `receipts` array from the same
   * service function but never overrides the field, so every row there arrives
   * `can_delete: false`. Rendering from the embedded copy would silently hide
   * the × from an owner editing their own draft, which is the one case where
   * removal is legal (§10.2, §19.3).
   */
  const { data } = useGetReceiptsQuery(expenseId, { skip: !expenseId })
  const fetched = (data?.items ?? []) as ReceiptResponse[]
  const source: ReceiptResponse[] = fetched.length ? fetched : receipts

  const live = source.filter((r) => !r.deleted)

  const handleFiles = async (files: File[]) => {
    setPending(files)
    for (const file of files) {
      try {
        await uploadReceipt({ expenseId, file }).unwrap()
      } catch (err) {
        const detail = (err as { data?: { detail?: unknown } })?.data?.detail
        toast.error(
          typeof detail === 'string' ? detail : `Could not upload ${file.name}`,
        )
      }
    }
    setPending([])
  }

  const handleDownload = async (receipt: ReceiptResponse) => {
    setBusyId(receipt.id)
    try {
      const res = await getDownloadUrl(receipt.id).unwrap()
      window.open(res.url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error('Could not open that receipt')
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (receipt: ReceiptResponse) => {
    setBusyId(receipt.id)
    try {
      await deleteReceipt({ receiptId: receipt.id, expenseId }).unwrap()
      toast.success('Receipt removed')
    } catch {
      toast.error('Could not remove that receipt')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      {live.length > 0 && (
        <div className="space-y-2">
          {live.map((receipt) => (
            <div
              key={receipt.id}
              className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => handleDownload(receipt)}
                className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
              >
                {receipt.filename}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatSize(receipt.size)}
              </span>

              {busyId === receipt.id ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => handleDownload(receipt)}
                    aria-label={`Download ${receipt.filename}`}
                  >
                    <Download className="size-3.5" />
                  </Button>
                  {receipt.can_delete && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => handleDelete(receipt)}
                      aria-label={`Remove ${receipt.filename}`}
                    >
                      <X className="size-3.5 text-destructive" />
                    </Button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {canUpload && (
        <MultiFileUploader
          value={pending}
          onChange={handleFiles}
          acceptExtensions={ACCEPT_EXTENSIONS}
          maxSizeMB={MAX_SIZE_MB}
        />
      )}

      {uploading && (
        <p className="text-xs text-muted-foreground">Uploading…</p>
      )}

      {!canUpload && live.length === 0 && (
        <p className="text-sm text-muted-foreground">No receipts attached.</p>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
