import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Lock, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { useAppSelector, useAppDispatch } from '@/store'
import { payrollUnlocked } from '@/store/slices/payrollLockSlice'
import { iamApi } from '@/store/api/iamApi'
import {
  useUnlockPayrollMutation,
  useRegeneratePayslipPinMutation,
  getPayrollError,
  getPayrollErrorMessage,
} from '@/store/api/payrollApi'

const PIN_LENGTH = 6
// After this many wrong PINs with no server-side cooldown, apply a light client
// debounce. The server enforces the real limit (5 fails → 15-min cooldown).
const SOFT_ATTEMPTS = 3
const SOFT_LOCKOUT_MS = 5_000
// Fallback unlock window when the server omits expires_in (fixed 5-min session).
const DEFAULT_UNLOCK_MS = 5 * 60_000

// ── 6-digit PIN entry (masked; nothing is persisted) ──
function PinInput({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onComplete: (v: string) => void
  disabled?: boolean
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    refs.current[0]?.focus()
  }, [])

  const chars = Array.from({ length: PIN_LENGTH }, (_, i) => value[i] ?? '')

  const setAt = (i: number, ch: string) =>
    (value.slice(0, i) + ch + value.slice(i + 1)).slice(0, PIN_LENGTH)

  const handleChange = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (!digits) {
      onChange(setAt(i, ''))
      return
    }
    const next = setAt(i, digits[digits.length - 1])
    onChange(next)
    if (i < PIN_LENGTH - 1) refs.current[i + 1]?.focus()
    if (next.length === PIN_LENGTH) onComplete(next)
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (value[i]) onChange(setAt(i, ''))
      else if (i > 0) {
        refs.current[i - 1]?.focus()
        onChange(setAt(i - 1, ''))
      }
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
    else if (e.key === 'ArrowRight' && i < PIN_LENGTH - 1) refs.current[i + 1]?.focus()
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, PIN_LENGTH)
    if (!text) return
    e.preventDefault()
    onChange(text)
    refs.current[Math.min(text.length, PIN_LENGTH - 1)]?.focus()
    if (text.length === PIN_LENGTH) onComplete(text)
  }

  return (
    <div className="flex items-center justify-center gap-2" onPaste={handlePaste}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          value={c}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          disabled={disabled}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          aria-label={`PIN digit ${i + 1}`}
          className="size-11 rounded-lg border border-input bg-background text-center text-lg font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
        />
      ))}
    </div>
  )
}

export function PayrollPinGate({ children }: { children: ReactNode }) {
  // Whether the caller already has a Secure PIN (from /me → session). Defaults
  // to true when unknown so we never wrongly hide the entry field.
  const isPinExists = useAppSelector((s) => s.auth.user?.is_pin_exists ?? true)

  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  // A PIN has been generated & emailed this session (so there's now one to enter).
  const [generated, setGenerated] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [lockoutUntil, setLockoutUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  // The PIN/unlock service is temporarily unreachable (503) — offer a retry
  // instead of treating it as a wrong PIN.
  const [serviceDown, setServiceDown] = useState(false)
  // Password-confirmation step for generating / resending the PIN.
  const [pwStep, setPwStep] = useState<null | 'generate' | 'forgot'>(null)
  const [pwValue, setPwValue] = useState('')
  const [pwError, setPwError] = useState('')

  const dispatch = useAppDispatch()
  const [unlockPayroll, { isLoading: verifying }] = useUnlockPayrollMutation()
  const [regeneratePin, { isLoading: regenerating }] = useRegeneratePayslipPinMutation()

  // The unlock window lives in the store so it survives this gate remounting on
  // every payroll tab switch — while it's valid the FE never re-prompts and
  // never re-calls /unlock; the 403 PAYSLIP_LOCKED interceptor (which zeroes
  // unlockedUntil) is the backstop if the local deadline is ever wrong.
  const unlockedUntil = useAppSelector((s) => s.payrollLock.unlockedUntil)
  const unlocked = unlockedUntil > now

  const lockedOut = lockoutUntil > now
  const remaining = Math.max(0, Math.ceil((lockoutUntil - now) / 1000))
  const busy = verifying || regenerating

  // Tick during a lockout so the countdown updates.
  useEffect(() => {
    if (lockoutUntil <= Date.now()) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [lockoutUntil])

  // Re-render exactly when the fixed unlock window elapses so the prompt reappears
  // (activity does NOT extend it). The authoritative signal is still the server's
  // PAYSLIP_LOCKED on the next call; this just re-prompts proactively at expiry.
  useEffect(() => {
    if (unlockedUntil <= Date.now()) return
    const id = window.setTimeout(() => setNow(Date.now()), unlockedUntil - Date.now())
    return () => window.clearTimeout(id)
  }, [unlockedUntil])

  const submit = async (candidate = pin) => {
    if (candidate.length !== PIN_LENGTH || lockedOut || busy) return
    setError(null)
    setServiceDown(false)
    try {
      const res = await unlockPayroll({ pin: candidate }).unwrap()

      if (res.unlocked) {
        const ms =
          (res.expires_in && res.expires_in > 0
            ? res.expires_in
            : DEFAULT_UNLOCK_MS / 1000) * 1000
        dispatch(payrollUnlocked(Date.now() + ms))
        setPin('')
        setAttempts(0)
        setNeedsSetup(false)
        return
      }

      // Server-side cooldown after too many wrong attempts — show the countdown,
      // not a "wrong PIN" message.
      if (res.locked) {
        setPin('')
        setAttempts(0)
        setLockoutUntil(Date.now() + Math.max(0, res.retry_after) * 1000)
        setNow(Date.now())
        return
      }

      // No PIN configured yet → switch to the generate flow (which confirms the
      // password before issuing one). Don't auto-email.
      if (!res.pin_set) {
        setPin('')
        setNeedsSetup(true)
        return
      }

      // Wrong PIN. The server owns the real limit; apply only a light client
      // debounce after a few local misses.
      const n = attempts + 1
      setPin('')
      setError('Incorrect PIN. Please try again.')
      if (n >= SOFT_ATTEMPTS) {
        setAttempts(0)
        setLockoutUntil(Date.now() + SOFT_LOCKOUT_MS)
        setNow(Date.now())
      } else {
        setAttempts(n)
      }
    } catch (e) {
      const code = getPayrollError(e)?.code
      const status = (e as { status?: number }).status
      // PIN service unreachable → retry, never a wrong-PIN / logout.
      if (
        status === 503 ||
        code === 'PIN_SERVICE_UNAVAILABLE' ||
        code === 'PAYSLIP_UNLOCK_FAILED'
      ) {
        setServiceDown(true)
        setError('PIN service unavailable. Please retry.')
        return
      }
      // 401 SESSION_INVALID is handled by the shared baseQuery (refresh →
      // session-expired modal); just surface a message here.
      setPin('')
      setError(getPayrollErrorMessage(e, 'Could not verify your PIN. Please try again.'))
    }
  }

  // Generating or resending a PIN requires the password → open that step.
  const openPwStep = (intent: 'generate' | 'forgot') => {
    if (busy) return
    setPwStep(intent)
    setPwValue('')
    setPwError('')
  }

  const submitPw = async () => {
    if (!pwValue || regenerating) return
    setPwError('')
    try {
      await regeneratePin({ password: pwValue }).unwrap()
      const wasGenerate = pwStep === 'generate'
      setPwStep(null)
      setPwValue('')
      setPin('')
      setError(null)
      if (wasGenerate) setGenerated(true)
      // Backend flips is_pin_exists on the session → refresh /me so other screens
      // (e.g. Profile) reflect that a PIN now exists.
      dispatch(iamApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }))
      toast.success(
        wasGenerate ? 'Secure PIN sent' : 'New PIN sent',
        'Check your email for your Secure PIN, then enter it here.',
      )
    } catch (e) {
      const err = e as { status?: number; data?: { code?: string } }
      if (err?.status === 401 && err.data?.code === 'INCORRECT_PASSWORD') {
        setPwError('Incorrect password. Please try again.')
      } else {
        setPwError(getPayrollErrorMessage(e, 'Could not update your PIN. Please try again.'))
      }
    }
  }

  if (unlocked) return <>{children}</>

  const setupMode = needsSetup || !isPinExists
  // No PIN on file (or backend reported none) and none generated yet → show the
  // "generate" call to action instead of a PIN field with nothing to type into.
  const noPinYet = !generated && (!isPinExists || needsSetup)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl border bg-card p-8 shadow-lg">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => window.history.back()}
          aria-label="Close"
          className="absolute right-3 top-3 size-8 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </Button>
        <div className="flex flex-col items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Lock className="size-6 text-primary" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-foreground">
            {pwStep
              ? 'Confirm your password'
              : setupMode
                ? 'Set up your Secure PIN'
                : 'Enter your Secure PIN'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {pwStep
              ? 'Enter your password to continue.'
              : noPinYet
                ? "You don't have a Secure PIN yet. Generate one and we'll email it to you."
                : setupMode
                  ? "We've emailed you a Secure PIN. Enter the 6-digit PIN to continue."
                  : 'This is the same 6-digit PIN that opens your payslip PDFs.'}
          </p>
        </div>

        {pwStep ? (
          <div className="mt-6 space-y-3">
            <Input
              type="password"
              autoFocus
              placeholder="Confirm your password"
              value={pwValue}
              onChange={(e) => {
                setPwValue(e.target.value)
                if (pwError) setPwError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitPw()
                }
              }}
              aria-invalid={!!pwError}
            />
            {pwError && <p className="text-center text-sm text-destructive">{pwError}</p>}
            <Button
              className="w-full"
              onClick={() => void submitPw()}
              disabled={!pwValue || regenerating}
            >
              {regenerating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : pwStep === 'generate' ? (
                'Generate PIN'
              ) : (
                'Send new PIN'
              )}
            </Button>
            <div className="text-center">
              <button
                type="button"
                onClick={() => {
                  setPwStep(null)
                  setPwValue('')
                  setPwError('')
                }}
                className="text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                Back
              </button>
            </div>
          </div>
        ) : noPinYet ? (
          <Button className="mt-6 w-full" onClick={() => openPwStep('generate')} disabled={busy}>
            Generate PIN
          </Button>
        ) : (
          <>
            <div className="mt-6">
              <PinInput
                value={pin}
                onChange={(v) => {
                  setPin(v)
                  if (error) setError(null)
                }}
                onComplete={(v) => void submit(v)}
                disabled={lockedOut || busy}
              />
            </div>

            {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}
            {lockedOut && (
              <p className="mt-3 text-center text-sm text-muted-foreground">
                Too many attempts. Try again in {remaining}s.
              </p>
            )}

            <Button
              className="mt-5 w-full"
              onClick={() => void submit()}
              disabled={pin.length !== PIN_LENGTH || lockedOut || busy}
            >
              {verifying ? (
                <Loader2 className="size-4 animate-spin" />
              ) : serviceDown ? (
                'Retry'
              ) : (
                'Unlock'
              )}
            </Button>

            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => openPwStep('forgot')}
                disabled={busy}
                className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
              >
                {setupMode ? 'Resend PIN' : 'Forgot PIN?'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
