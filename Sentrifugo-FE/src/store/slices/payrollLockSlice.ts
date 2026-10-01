import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { clearAuth } from './authSlice'

// The payroll unlock window. Held in the store (not the gate component) so it
// survives the gate remounting on every payroll tab switch, AND mirrored to
// sessionStorage so it survives a full page refresh too: the server keeps the
// 300 s Valkey unlock valid across a reload, so the FE must NOT re-prompt for the
// PIN just because Redux was reset. The gate reads `unlocked = Date.now() <
// unlockedUntil` and only asks once it lapses.
//
// `unlockedUntil` is an epoch-ms deadline set from the /my-payroll/unlock
// response's expires_in. There is no server endpoint to *read* the remaining
// window (unlock requires the PIN), so the persisted deadline is how a refresh
// restores it. It is reset to 0 — and the stored value cleared — when any payroll
// call answers 403 PAYSLIP_LOCKED (the authoritative backstop if the persisted
// deadline is ever wrong) and on logout.
const STORAGE_KEY = 'sentrifugo.payrollUnlockedUntil'

// Storage can throw (private mode, disabled cookies, SSR/tests) — never let that
// break the gate; the in-memory value still works, we just lose refresh-survival.
function readPersistedDeadline(): number {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function persistDeadline(deadline: number): void {
  try {
    if (deadline > 0) sessionStorage.setItem(STORAGE_KEY, String(deadline))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — in-memory unlock still functions */
  }
}

interface PayrollLockState {
  unlockedUntil: number
}

const initialState: PayrollLockState = {
  // Hydrate from sessionStorage so a refresh within the window doesn't re-prompt.
  unlockedUntil: readPersistedDeadline(),
}

const payrollLockSlice = createSlice({
  name: 'payrollLock',
  initialState,
  reducers: {
    // payload = Date.now() + expires_in*1000, computed by the caller (keeps
    // Date.now() out of the reducer).
    payrollUnlocked(state, action: PayloadAction<number>) {
      state.unlockedUntil = action.payload
      persistDeadline(action.payload)
    },
    payrollLocked(state) {
      state.unlockedUntil = 0
      persistDeadline(0)
    },
  },
  extraReducers: (builder) => {
    builder.addCase(clearAuth, (state) => {
      state.unlockedUntil = 0
      persistDeadline(0)
    })
  },
})

export const { payrollUnlocked, payrollLocked } = payrollLockSlice.actions
export default payrollLockSlice.reducer
