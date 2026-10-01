import { useState } from 'react'
import { Eye, EyeOff, Lock, CheckCircle2, XCircle } from 'lucide-react'
import { Link, useSearch, useNavigate } from '@tanstack/react-router'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useActivateAccountMutation, useResetPasswordMutation } from '@/store/api/iamApi'
import { AuthLayout } from '@/layouts/AuthLayout'

function getApiError(error: unknown): string {
  if (!error) return ''
  const err = error as { data?: { detail?: string } }
  return err.data?.detail ?? 'Invalid or expired activation link.'
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (!/\d/.test(password)) return 'Password must contain at least one number.'
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password))
    return 'Password must contain at least one special character.'
  return null
}

export function ActivateAccount() {
  const navigate = useNavigate()
  const { token } = useSearch({ strict: false }) as { token?: string }
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [localError, setLocalError] = useState('')
  const [success, setSuccess] = useState(false)
  const [activateAccount, { isLoading, error }] = useActivateAccountMutation()
  const [resetPassword, { isLoading: isResetting }] = useResetPasswordMutation()

  const apiError = getApiError(error)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLocalError('')

    const pwError = validatePassword(password)
    if (pwError) { setLocalError(pwError); return }
    if (password !== confirmPassword) { setLocalError('Passwords do not match.'); return }

    try {
      const { password_reset_token } = await activateAccount({ token: token!, password }).unwrap()
      await resetPassword({ token: password_reset_token, new_password: password }).unwrap()
      setSuccess(true)
      setTimeout(() => navigate({ to: '/login' }), 2000)
    } catch {
      // handled via apiError
    }
  };

  if (!token) {
    return (
      <AuthLayout
        title="Invalid Link"
        description="No activation token found. Please check your email and try again."
        headerIcon={<XCircle className="h-10 w-10 text-destructive" />}
        footerSlot={
          <Link to="/login" className="block w-full">
            <Button className="h-11 w-full">Go to Login</Button>
          </Link>
        }
      >
        <div />
      </AuthLayout>
    )
  }

  if (success) {
    return (
      <AuthLayout
        title="Account Activated!"
        description="Your account has been activated. Redirecting you to login…"
        headerIcon={<CheckCircle2 className="h-10 w-10 text-success" />}
        footerSlot={
          <Link to="/login" className="block w-full">
            <Button className="h-11 w-full">Go to Login</Button>
          </Link>
        }
      >
        <div />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Activate Account"
      description="Set your password to activate your account."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {(localError || apiError) && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {localError || apiError}
          </div>
        )}
        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium text-foreground">
            Password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading || isResetting}
              autoComplete="new-password"
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
          <p className="text-xs text-muted-foreground">
            Min. 8 characters, including a number and a special character.
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="confirmPassword" className="text-sm font-medium text-foreground">
            Confirm Password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="confirmPassword"
              type={showConfirm ? 'text' : 'password'}
              placeholder="Confirm your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={isLoading || isResetting}
              autoComplete="new-password"
              className="h-11 pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowConfirm((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
              tabIndex={-1}
              aria-label={showConfirm ? 'Hide password' : 'Show password'}
            >
              {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <Button type="submit" className="h-11 w-full" disabled={isLoading || isResetting}>
          {(isLoading || isResetting) ? 'Activating…' : 'Activate Account'}
        </Button>
      </form>
    </AuthLayout>
  )
}
