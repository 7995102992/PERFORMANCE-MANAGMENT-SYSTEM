import { useCallback, useRef } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { useConfirm } from '@/providers/confirm-dialog-provider'

type GuardLocation = { pathname: string; search: Record<string, unknown> }

/**
 * Blocks in-app navigation (sidebar clicks, link clicks, back/forward)
 * when the form has unsaved changes. Shows a confirm dialog so the user
 * can choose to discard or stay. Also guards browser refresh / tab close
 * via beforeunload.
 *
 * `isInternalNav` (optional): return true for navigations that stay *within*
 * the current screen and must NOT be guarded — e.g. a multi-step wizard
 * switching steps via a search param. Those transitions are handled by the
 * page's own discard confirm; without this, the guard would also fire and a
 * spurious "Discard changes?" dialog pops when simply moving between steps.
 *
 * Returns a `release()` function. Call it synchronously right before a
 * programmatic `navigate()` that follows a successful save — this bypasses
 * the guard for the next navigation without waiting for React state to
 * settle.
 */
export function useNavigationGuard(
  isDirty: boolean,
  isInternalNav?: (args: { current: GuardLocation; next: GuardLocation }) => boolean,
) {
  const confirm = useConfirm()
  const dirtyRef = useRef(isDirty)
  dirtyRef.current = isDirty
  const internalRef = useRef(isInternalNav)
  internalRef.current = isInternalNav
  const skipNextRef = useRef(false)

  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      new Promise<boolean>((resolve) => {
        if (skipNextRef.current) {
          skipNextRef.current = false
          resolve(false)
          return
        }
        // Same-screen navigation (e.g. a wizard switching steps) — never block.
        if (
          internalRef.current?.({
            current: current as GuardLocation,
            next: next as GuardLocation,
          })
        ) {
          resolve(false)
          return
        }
        if (!dirtyRef.current) {
          resolve(false)
          return
        }
        confirm({
          title: 'Discard changes?',
          description:
            'You have unsaved changes. Are you sure you want to leave? Your changes will be lost.',
          confirmText: 'Leave',
          cancelText: 'Stay',
          variant: 'destructive',
          onConfirm: () => resolve(false),
          onCancel: () => resolve(true),
        })
      }),
    enableBeforeUnload: isDirty,
  })

  return useCallback(() => {
    skipNextRef.current = true
  }, [])
}
