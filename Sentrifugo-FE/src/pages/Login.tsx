import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { LogIn, Eye, EyeOff, Mail, Lock, KeyRound } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { PinInput } from '@/components/shared/PinInput'
import {
  useLoginMutation,
  useLazyGetMeQuery,
  useLazyGetAzureLoginUrlQuery,
  useMpinLoginMutation,
  useMpinRegisterMutation,
} from '@/store/api/iamApi'
import { useAppDispatch, resetAllApiState } from '@/store'
import { AuthLayout } from '@/layouts/AuthLayout'
import { setRememberPreference } from '@/lib/cookies'
import { toast } from '@/lib/toast'
import {
  getMpinDeviceToken,
  setMpinDeviceToken,
  clearMpinDeviceToken,
  getMpinAccount,
  setMpinAccount,
  isMpinPromptDismissed,
  dismissMpinPrompt,
} from '@/lib/mpin'
import type { MeResponse } from '@/types/auth'
import type { MpinAccount } from '@/lib/mpin'

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

function getErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'object' && 'status' in (error as object)) {
    const err = error as { status: number | string; data?: { detail?: string } }
    if (err.status === 401) return 'Invalid email or password.'
    if (err.status === 403) return 'You are not authorised to access this portal.'
    if (err.data?.detail) return String(err.data.detail)
  }
  return 'Something went wrong. Please try again.'
}

/** Pull { status, code, message } out of an RTK/mPIN error. */
function parseMpinError(error: unknown): { status?: number; code?: string; message?: string } {
  if (error && typeof error === 'object' && 'status' in (error as object)) {
    const err = error as { status?: number; data?: { code?: string; message?: string } }
    return { status: err.status, code: err.data?.code, message: err.data?.message }
  }
  return {}
}

/** mPIN is the payslip PIN, so only offer quick login to users who have that permission. */
function hasPayrollPin(me: MeResponse): boolean {
  if (me.is_super_admin || me.is_org_admin) return true
  const core = me.permissions?.core_hr as { actions?: Record<string, boolean> } | undefined
  return core?.actions?.my_payroll === true
}

export const Login = () => {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const [login, { isLoading }] = useLoginMutation()
  const [mpinLogin, { isLoading: mpinLoading }] = useMpinLoginMutation()
  const [registerDevice, { isLoading: registering }] = useMpinRegisterMutation()
  const [fetchMe] = useLazyGetMeQuery()
  const [fetchAzureUrl, { isFetching: isAzureLoading }] = useLazyGetAzureLoginUrlQuery()

  // Start in mPIN mode when this device has a stored token.
  const [mode, setMode] = useState<'password' | 'mpin'>(() =>
    getMpinDeviceToken() ? 'mpin' : 'password',
  )

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [ssoError, setSsoError] = useState('')

  // mPIN entry state.
  const [pin, setPin] = useState('')
  const [mpinError, setMpinError] = useState('')
  const [mpinLocked, setMpinLocked] = useState(false)

  // Post-login "enable quick login?" prompt (+ the account we'd enrol).
  const [promptOpen, setPromptOpen] = useState(false)
  const [enrollAccount, setEnrollAccount] = useState<MpinAccount | null>(null)

  const goToDashboard = () => navigate({ to: '/' })

  const handleMicrosoftLogin = async () => {
    setSsoError('')
    try {
      const { authorization_url, state } = await fetchAzureUrl().unwrap()
      sessionStorage.setItem('azure_login_state', state)
      window.location.href = authorization_url
    } catch {
      setSsoError('Could not start Microsoft sign-in. Please try again.')
    }
  }

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError('')
    try {
      setRememberPreference(remember)
      resetAllApiState(dispatch)
      await login({ email, password, remember }).unwrap()
      // Resolve the user, then decide whether to offer mPIN enrolment.
      let me: MeResponse | undefined
      try {
        me = await fetchMe().unwrap()
      } catch {
        /* /me failure still routes to dashboard */
      }
      if (
        me &&
        me.auth_method === 'local' && // SSO users have no password → can't enrol
        !getMpinDeviceToken() &&
        !isMpinPromptDismissed() &&
        me.is_pin_exists &&
        hasPayrollPin(me)
      ) {
        setEnrollAccount({
          name: `${me.first_name} ${me.last_name}`.trim(),
          email: me.email,
        })
        setPromptOpen(true) // navigate happens when the prompt is resolved
      } else {
        goToDashboard()
      }
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }

  const handleMpinLogin = async (candidate = pin) => {
    if (candidate.length !== 6 || mpinLocked || mpinLoading) return
    const token = getMpinDeviceToken()
    if (!token) {
      setMode('password')
      return
    }
    setMpinError('')
    try {
      setRememberPreference(true) // trusted device
      resetAllApiState(dispatch)
      await mpinLogin({ pin: candidate, device_token: token }).unwrap()
      try {
        await fetchMe().unwrap()
      } catch {
        /* noop */
      }
      goToDashboard()
    } catch (err) {
      const { status, code, message } = parseMpinError(err)
      setPin('')
      if (status === 429 || code === 'MPIN_LOCKED') {
        setMpinLocked(true)
        setMpinError(message || 'Too many failed attempts. Try again in 15 minutes.')
      } else if (status === 401) {
        // MPIN_INVALID: with an attempts hint it's a wrong PIN; without one the
        // device token is invalid/expired → drop it and fall back to password.
        if (message && /remaining/i.test(message)) {
          setMpinError(message)
        } else {
          clearMpinDeviceToken()
          setMpinError('')
          setMode('password')
        }
      } else {
        setMpinError(message || 'Could not sign in with your PIN. Please try again.')
      }
    }
  }

  const handleEnableMpin = async () => {
    try {
      // Reuse the password just entered on this screen — no second prompt needed.
      const { device_token } = await registerDevice({ password }).unwrap()
      setMpinDeviceToken(device_token)
      if (enrollAccount) setMpinAccount(enrollAccount)
      toast.success('Quick login enabled', 'Use your Secure PIN to sign in on this device.')
    } catch {
      toast.error('Could not enable quick login. You can try again later from this device.')
    } finally {
      setPromptOpen(false)
      goToDashboard()
    }
  }

  // Use password this time but keep this device enrolled for next time.
  const usePasswordInstead = () => {
    setMode('password')
    setPin('')
    setMpinError('')
    setMpinLocked(false)
  }

  // Different person: forget this device's enrolment, then show the password form.
  const useDifferentAccount = () => {
    clearMpinDeviceToken()
    usePasswordInstead()
  }

  // Never offer enrolment again on this device.
  const dontAskAgain = () => {
    dismissMpinPrompt()
    setPromptOpen(false)
    goToDashboard()
  }

  // ── mPIN entry screen ──
  if (mode === 'mpin') {
    const account = getMpinAccount()
    return (
      <AuthLayout title="">
        <div className="space-y-5">
          <div className="text-center">
            {account ? (
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {initialsOf(account.name)}
              </div>
            ) : (
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
                <KeyRound className="size-6 text-primary" />
              </div>
            )}
            <h2 className="mt-4 text-lg font-semibold text-foreground">
              {account ? `Welcome back, ${account.name.split(' ')[0] || account.name}` : 'Quick sign in'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {account?.email
                ? `${account.email} · enter your 6-digit Secure PIN.`
                : 'Enter your 6-digit Secure PIN to continue on this device.'}
            </p>
          </div>

          <PinInput
            value={pin}
            onChange={(v) => {
              setPin(v)
              if (mpinError) setMpinError('')
            }}
            onComplete={(v) => void handleMpinLogin(v)}
            disabled={mpinLocked || mpinLoading}
          />

          {mpinError && (
            <p className="text-center text-sm text-destructive">{mpinError}</p>
          )}

          <Button
            className="h-11 w-full"
            onClick={() => void handleMpinLogin()}
            disabled={pin.length !== 6 || mpinLocked || mpinLoading}
          >
            <LogIn />
            {mpinLoading ? 'Signing in…' : 'Sign in with PIN'}
          </Button>

          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={usePasswordInstead}
              className="text-sm font-medium text-primary hover:underline"
            >
              Use password instead
            </button>
            <button
              type="button"
              onClick={useDifferentAccount}
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              Sign in with a different account
            </button>
          </div>
        </div>
      </AuthLayout>
    )
  }

  // ── Password / SSO screen ──
  return (
    <AuthLayout title="">
      <form onSubmit={(e) => handleLogin(e)} className="space-y-5">
        {(error || ssoError) && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {ssoError || error}
          </div>
        )}
        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium text-foreground">
            Email
          </label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
              autoComplete="email"
              className="h-11 pl-9"
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <a href="/forgot-password" className="text-sm text-primary hover:underline">
              Forgot password?
            </a>
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
              autoComplete="current-password"
              className="h-11 pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={isLoading}
            className="size-4 rounded border-input accent-primary"
          />
          Remember me
        </label>
        <Button type="submit" className="h-11 w-full" disabled={isLoading}>
          <LogIn />
          {isLoading ? 'Signing in…' : 'Sign in'}
        </Button>

        <div className="flex items-center gap-3 py-1">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            or continue with
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          disabled={isLoading || isAzureLoading}
          onClick={handleMicrosoftLogin}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-md border border-input bg-background text-sm font-medium text-foreground shadow-sm transition-all hover:border-primary/40 hover:bg-accent hover:shadow disabled:pointer-events-none disabled:opacity-60"
        >
          <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          <span>{isAzureLoading ? 'Redirecting…' : 'Sign in with Microsoft'}</span>
        </button>
      </form>

      {/* Offer to enrol this device for PIN quick-login after a first password login. */}
      <Dialog open={promptOpen} onOpenChange={(o) => { if (!o) { setPromptOpen(false); goToDashboard() } }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Enable quick login with your PIN?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            On this device you can sign in next time with your 6-digit Secure PIN instead of
            your password.
          </p>
          <DialogFooter className="gap-2 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={dontAskAgain} disabled={registering}>
              No, Never ask again
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setPromptOpen(false)
                  goToDashboard()
                }}
                disabled={registering}
              >
                Not now
              </Button>
              <Button onClick={handleEnableMpin} disabled={registering}>
                {registering ? 'Enabling…' : 'Enable'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthLayout>
  )
}
