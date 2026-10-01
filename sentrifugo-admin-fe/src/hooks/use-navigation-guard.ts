import { useBlocker } from '@tanstack/react-router'
import { useConfirm } from '@/providers/confirm-dialog-provider'

/**
 * Blocks in-app navigation (sidebar clicks, link clicks, back/forward)
 * when the form has unsaved changes. Shows a confirm dialog to let
 * the user choose to discard or stay.
 *
 * Also sets `beforeunload` to guard against browser refresh / tab close.
 */
export function useNavigationGuard(isDirty: boolean) {
  const confirm = useConfirm()

  useBlocker({
    condition: isDirty,
    blockerFn: () =>
      new Promise<boolean>((resolve) => {
        confirm({
          title: 'Discard changes?',
          description:
            'You have unsaved changes. Are you sure you want to leave? Your changes will be lost.',
          confirmText: 'Leave',
          cancelText: 'Stay',
          onConfirm: () => resolve(false),
          onCancel: () => resolve(true),
        })
      }),
  })
}
