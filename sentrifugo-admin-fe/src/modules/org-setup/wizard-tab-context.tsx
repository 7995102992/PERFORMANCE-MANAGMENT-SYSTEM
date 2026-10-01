import { createContext, useCallback, useContext, useEffect, useState } from 'react'

interface WizardTabState {
  tabs: string[]
  activeTab: string
  setActiveTab: (tab: string) => void
}

interface WizardTabContextValue {
  current: WizardTabState | null
  register: (state: WizardTabState) => void
  unregister: () => void
}

const WizardTabCtx = createContext<WizardTabContextValue>({
  current: null,
  register: () => {},
  unregister: () => {},
})

export function WizardTabProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<WizardTabState | null>(null)

  const register = useCallback((state: WizardTabState) => setCurrent(state), [])
  const unregister = useCallback(() => setCurrent(null), [])

  return (
    <WizardTabCtx.Provider value={{ current, register, unregister }}>
      {children}
    </WizardTabCtx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWizardTabContext() {
  return useContext(WizardTabCtx)
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRegisterWizardTabs(tabs: string[]) {
  const { register, unregister } = useWizardTabContext()
  const [activeTab, setActiveTabLocal] = useState(tabs[0])

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabLocal(tab)
  }, [])

  useEffect(() => {
    register({ tabs, activeTab, setActiveTab })
  }, [activeTab, tabs, register, setActiveTab])

  useEffect(() => {
    return () => unregister()
  }, [unregister])

  return { activeTab, setActiveTab }
}
