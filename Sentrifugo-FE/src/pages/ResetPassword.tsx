import { useState } from 'react'
import { Eye, EyeOff, Lock, CheckCircle2, XCircle } from 'lucide-react'
import { Link, useSearch } from '@tanstack/react-router'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useResetPasswordMutation } from '@/store/api/iamApi'
import { AuthLayout } from '@/layouts/AuthLayout'

function getApiError(error: unknown): string {
  if (!error) return ''
  const err = error as { data?: { detail?: string } }
  return err.data?.detail ?? 'Invalid or expired reset link. Please request a new one.'
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (!/\d/.test(password)) return 'Password must contain at least one number.'
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password))
    return 'Password must contain at least one special character.'
  return null
}

export function ResetPassword() {
  const { token } = useSearch({ strict: false }) as { token?: string }
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [localError, setLocalError] = useState('')
  const [success, setSuccess] = useState(false)
  const [resetPassword, { isLoading, error }] = useResetPasswordMutation()

  const apiError = getApiError(error)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLocalError('')

    const pwError = validatePassword(password)
    if (pwError) { setLocalError(pwError); return }
    if (password !== confirmPassword) { setLocalError('Passwords do not match.'); return }

    try {
      await resetPassword({ token: token!, new_password: password }).unwrap()
      setSuccess(true)
    } catch {
      // handled via apiError
    }
  }

  if (!token) {
    return (
      <AuthLayout
        title="Invalid Link"
        description="This password reset link is invalid or has expired."
        headerIcon={<XCircle className="h-10 w-10 text-destructive" />}
        footerSlot={
          <Link to="/forgot-password" className="block w-full">
            <Button className="h-11 w-full">Request New Link</Button>
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
        title="Password Reset"
        description="Your password has been reset. You can now sign in with your new password."
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
      title="Reset Password"
      description="Enter your new password below."
      footerSlot={
        <p className="text-sm text-center text-muted-foreground">
          Remember it?{' '}
          <Link to="/login" className="text-primary hover:underline font-medium">
            Back to login
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {(localError || apiError) && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {localError || apiError}
          </div>
        )}
        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium text-foreground">
            New Password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter new password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
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
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={isLoading}
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
        <Button type="submit" className="h-11 w-full" disabled={isLoading}>
          {isLoading ? 'Resetting…' : 'Reset Password'}
        </Button>
      </form>
    </AuthLayout>
  )
}
