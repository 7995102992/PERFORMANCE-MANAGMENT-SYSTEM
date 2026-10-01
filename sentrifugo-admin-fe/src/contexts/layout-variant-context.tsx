import { createContext, useContext } from 'react'

/**
 * 'elevated' — main area has a grey tinted background (SuperAdminLayout).
 *              Shared pages should wrap content in white Cards for visual separation.
 * 'flat'     — main area is already white (OrgSetupLayout).
 *              Shared pages render bare forms directly.
 */
export type LayoutVariant = 'elevated' | 'flat'

export const LayoutVariantContext = createContext<LayoutVariant>('flat')

export function useLayoutVariant(): LayoutVariant {
  return useContext(LayoutVariantContext)
}
