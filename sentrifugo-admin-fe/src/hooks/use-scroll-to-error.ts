import { useCallback } from 'react'

/**
 * Returns a function that scrolls to the first invalid field in the form.
 *
 * @param scope - Optional CSS selector or Element to scope the search within.
 *   Useful for dialogs: pass `'[role="dialog"]'` to scroll only inside the modal.
 *   Defaults to the whole document.
 */
export function useScrollToError(scope?: string | Element | null) {
  return useCallback(() => {
    requestAnimationFrame(() => {
      const root: Element | Document =
        typeof scope === 'string'
          ? (document.querySelector(scope) ?? document)
          : (scope ?? document)

      // Priority order: aria-invalid fields → data-invalid fields → visible error text
      const el = root.querySelector<Element>(
        '[aria-invalid="true"], [data-invalid="true"], .text-destructive:not(span)'
      )
      if (el) {
        // Try to focus the nearest input/select/textarea inside the errored field container
        const parent = el.closest('.field-group, [data-invalid], .space-y-1\\.5, [class*="space-y"]') ?? el
        const focusable = parent.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'
        )
        // Scroll to the field container or focusable input rather than the error text
        const scrollTarget = focusable ?? parent ?? el
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' })
        focusable?.focus({ preventScroll: true })
      }
    })
  }, [scope])
}
