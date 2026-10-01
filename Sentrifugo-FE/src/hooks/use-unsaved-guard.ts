import { useCallback } from 'react'
import { useConfirm } from '@/providers/confirm-dialog-provider'

/**
 * Returns a guarded `onOpenChange` handler for Sheets / Dialogs.
 * When the user tries to close (outside click / escape) and `isDirty` is true,
 * shows a confirmation dialog. Otherwise closes immediately.
 */
export function useUnsavedGuard(
  isDirty: boolean,
  onOpenChange: (open: boolean) => void,
) {
  const confirm = useConfirm()

  return useCallback(
    (open: boolean) => {
      if (open) {
        onOpenChange(true)
        return
      }
      if (!isDirty) {
        onOpenChange(false)
        return
      }
      confirm({
        title: 'Discard changes?',
        description:
          'You have unsaved changes. Are you sure you want to close? Your changes will be lost.',
        confirmText: 'Discard',
        cancelText: 'Stay',
        variant: 'destructive',
        onConfirm: () => onOpenChange(false),
      })
    },
    [isDirty, onOpenChange, confirm],
  )
}
