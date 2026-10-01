import { useConfirm } from '@/providers/confirm-dialog-provider'
import { useCallback } from 'react'

/**
 * Returns a guarded `onOpenChange` handler for dialogs.
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
      // Opening — always allow
      if (open) { onOpenChange(true); return }

      // Closing without changes — allow
      if (!isDirty) { onOpenChange(false); return }

      // Closing with unsaved changes — confirm
      confirm({
        title: 'Discard changes?',
        description: 'You have unsaved changes. Are you sure you want to close? Your changes will be lost.',
        confirmText: 'Discard',
        onConfirm: async () => onOpenChange(false),
      })
    },
    [isDirty, onOpenChange, confirm],
  )
}