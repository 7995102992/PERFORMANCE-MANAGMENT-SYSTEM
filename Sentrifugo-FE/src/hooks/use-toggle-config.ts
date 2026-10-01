import { createContext, useContext } from 'react'
import type { ToggleConfigResponse, ToggleConfigUpsert } from '@/types/leave'

export type ToggleKey = keyof ToggleConfigUpsert

interface ToggleConfigContextValue {
  config: ToggleConfigResponse | null
  isToggleOn: (key: ToggleKey) => boolean
}

export const ToggleConfigContext = createContext<ToggleConfigContextValue>({
  config: null,
  isToggleOn: () => false,
})

export function useToggleConfig() {
  return useContext(ToggleConfigContext)
}
