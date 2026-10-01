/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { authService } from '@/api/auth'
import { AuthLayout } from '@/layouts/AuthLayout'

type State = 'loading' | 'success' | 'error'

const REDIRECT_DELAY_MS = 2000

export function ActivateAccount() {
  const { token } = useSearch({ strict: false }) as { token?: string }
  const navigate = useNavigate()
  const [state, setState] = useState<State>('loading')
  const [message, setMessage] = useState('')
  const [countdown, setCountdown] = useState(Math.ceil(REDIRECT_DELAY_MS / 1000))
  const calledRef = useRef(false)

  useEffect(() => {
    if (calledRef.current) return
    calledRef.current = true

    if (!token) {
      setState('error')
      setMessage('No activation token found in the link. Please check your email and try again.')
      return
    }

    authService
      .activateAccount(token)
      .then((data) => {
        setMessage(data.message)
        setState('success')

        if (data.password_reset_token) {
          const interval = setInterval(() => {
            setCountdown((prev) => {
              if (prev <= 1) {
                clearInterval(interval)
                return 0
              }
              return prev - 1
            })
          }, 1000)

          setTimeout(() => {
            clearInterval(interval)
            navigate({
              to: '/reset-password',
              search: { token: data.password_reset_token },
            })
          }, REDIRECT_DELAY_MS)
        }
      })
      .catch((err: unknown) => {
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          'Invalid or expired activation link. Please contact your administrator.'
        setMessage(msg)
        setState('error')
      })
  }, [token, navigate])

  const title =
    state === 'loading'
      ? 'Activating your account…'
      : state === 'success'
        ? 'Account activated'
        : 'Activation failed'

  const description =
    state === 'loading'
      ? 'Please wait while we verify your activation link.'
      : message

  const headerIcon =
    state === 'loading' ? (
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    ) : state === 'success' ? (
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50 dark:bg-green-950/30">
        <CheckCircle2 className="h-6 w-6 text-badge-active-text" />
      </div>
    ) : (
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <XCircle className="h-6 w-6 text-destructive" />
      </div>
    )

  return (
    <AuthLayout title={title} description={description} headerIcon={headerIcon}>
      {state === 'success' && countdown > 0 && (
        <p className="text-sm text-muted-foreground">
          Redirecting you to set your password in{' '}
          <span className="font-medium text-foreground">{countdown}s</span>…
        </p>
      )}
      {state !== 'loading' && (
        <Link to="/login" className="block">
          <Button className="h-11 w-full">Go to sign in</Button>
        </Link>
      )}
    </AuthLayout>
  )
}
