import { configureStore } from '@reduxjs/toolkit'
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux'
import organisationReducer from './slices/organisation-slice'
import authReducer from './slices/auth-slice'
import type { OrganisationState } from './slices/organisation-slice'
import type { AuthState } from './slices/auth-slice'
import { getCookie, setCookie, deleteCookie, isRemembered, TOKEN_MAX_AGE } from '@/lib/cookies'

// ─── localStorage persistence ────────────────────────────────────────────────

const PERSIST_KEY = 'sentrifugo_redux_state'

/** Shape of the state we actually persist to localStorage */
interface PersistedState {
  organisation: OrganisationState
  auth: AuthState
}

// Tokens live in cookies (remember-me controls their lifetime: 7-day vs
// session), never in the localStorage blob — so cookies are the source of
// truth for auth, and "remember me" actually controls how long login survives.
function syncTokenCookies(token: string | null, refreshToken: string | null): void {
  if (token && refreshToken) {
    const maxAge = isRemembered() ? TOKEN_MAX_AGE : undefined
    setCookie('access_token', token, maxAge)
    setCookie('refresh_token', refreshToken, maxAge)
  } else {
    deleteCookie('access_token')
    deleteCookie('refresh_token')
  }
}

function loadPersistedState(): PersistedState | undefined {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (!parsed.organisation || !parsed.auth) return undefined
    // Tokens come from cookies, not the persisted blob.
    parsed.auth.token = getCookie('access_token')
    parsed.auth.refreshToken = getCookie('refresh_token')
    return parsed as PersistedState
  } catch {
    return undefined
  }
}

function savePersistedState(state: PersistedState): void {
  try {
    // Only persist specific slices (not transient UI state), and never the raw
    // tokens — those go to cookies via syncTokenCookies.
    const toPersist: PersistedState = {
      organisation: state.organisation,
      auth: { ...state.auth, token: null, refreshToken: null },
    }
    localStorage.setItem(PERSIST_KEY, JSON.stringify(toPersist))
    syncTokenCookies(state.auth.token, state.auth.refreshToken)
  } catch {
    // Ignore quota errors
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const store = configureStore({
  reducer: {
    organisation: organisationReducer,
    auth: authReducer,
  },
  preloadedState: loadPersistedState(),
})

// Save to localStorage on every state change
store.subscribe(() => savePersistedState(store.getState()))

// ─── Typed hooks ──────────────────────────────────────────────────────────────

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppDispatch: () => AppDispatch = useDispatch
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
