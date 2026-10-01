import { toast } from '@/lib/toast'
import { useLazyGetPayslipUploadQuery, getPayrollErrorMessage } from '@/store/api/payrollApi'

/**
 * Shared payslip download logic. `download_url` is short-lived (~5 min), so we
 * always re-fetch the record by id to obtain a fresh presigned URL before opening.
 */
export function usePayslipDownload() {
  const [fetchOne, state] = useLazyGetPayslipUploadQuery()

  const download = async (id: string) => {
    try {
      const fresh = await fetchOne(id).unwrap()
      if (fresh.download_url) {
        window.open(fresh.download_url, '_blank', 'noopener,noreferrer')
      } else {
        toast.error('Download is currently unavailable for this file.')
      }
    } catch (e) {
      toast.error(getPayrollErrorMessage(e, 'Could not fetch the download link.'))
    }
  }

  return {
    download,
    /** id currently being fetched, or undefined when idle. */
    downloadingId: state.isFetching ? (state.originalArgs as string | undefined) : undefined,
  }
}
