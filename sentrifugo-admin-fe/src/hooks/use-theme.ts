import { useEffect, useState } from 'react'

const STORAGE_KEY = 'sentrifugo_theme'

function getInitialTheme(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark') return true
    if (stored === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function useTheme() {
  const [isDark, setIsDark] = useState(getInitialTheme)

  useEffect(() => {
    const el = document.documentElement
    if (isDark) {
      el.classList.add('dark')
      localStorage.setItem(STORAGE_KEY, 'dark')
    } else {
      el.classList.remove('dark')
      localStorage.setItem(STORAGE_KEY, 'light')
    }
  }, [isDark])

  const toggle = () => setIsDark((prev) => !prev)

  return { isDark, toggle }
}
