import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAzureCallbackMutation, useLazyGetMeQuery } from '@/store/api/iamApi'
import { useAppDispatch, resetAllApiState, store } from '@/store'
import { AuthLayout } from '@/layouts/AuthLayout'

type Search = {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

export function AzureCallback() {
  const { code, state, error, error_description } = useSearch({ strict: false }) as Search
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const [azureCallback] = useAzureCallbackMutation()
  const [fetchMe] = useLazyGetMeQuery()
  const [message, setMessage] = useState('')
  const calledRef = useRef(false)

  useEffect(() => {
    if (calledRef.current) return
    calledRef.current = true

    // Already signed in (e.g. user hit Back onto a spent /callback URL) — don't
    // try to re-exchange a single-use code; just send them to their portal.
    if (store.getState().auth.accessToken) {
      navigate({ to: '/', replace: true })
      return
    }

    // Azure redirected back with an explicit error (e.g. user cancelled).
    if (error) {
      setMessage(error_description || 'Microsoft sign-in was cancelled or failed.')
      return
    }

    const expectedState = sessionStorage.getItem('azure_login_state')
    sessionStorage.removeItem('azure_login_state')

    if (!code || !state) {
      setMessage('Missing sign-in response from Microsoft. Please try again.')
      return
    }
    if (expectedState && state !== expectedState) {
      setMessage('Sign-in response did not match this session. Please try again.')
      return
    }

    ;(async () => {
      try {
        resetAllApiState(dispatch)
        await azureCallback({ code, state }).unwrap()
        // Resolve the user before routing so client-only users land on their portal.
        let isClientOnly = false
        try {
          const me = await fetchMe().unwrap()
          const tsPerms = me?.permissions?.timesheet_management as
            | {
                actions?: {
                  client_timesheet?: boolean
                  manage_timesheet?: boolean
                  my_timesheet?: boolean
                }
              }
            | undefined
          const ts = tsPerms?.actions
          // Only users whose *sole* timesheet access is client review land on the
          // review portal. Anyone who also has their own/managed timesheets is a
          // regular user and belongs on the dashboard.
          isClientOnly =
            !me?.is_org_admin &&
            !me?.is_super_admin &&
            !!ts?.client_timesheet &&
            !ts?.manage_timesheet &&
            !ts?.my_timesheet
        } catch {
          // If /me fails, fall back to the default landing route.
        }
        // replace: true drops the spent /callback?code=... from history so the
        // browser Back button can never land on it and re-trigger a failed exchange.
        navigate({ to: isClientOnly ? '/timesheet/client-review' : '/', replace: true })
      } catch (err: unknown) {
        const detail = (err as { data?: { detail?: string } })?.data?.detail
        setMessage(detail ?? 'Could not complete Microsoft sign-in. Please contact your administrator.')
      }
    })()
  }, [code, state, error, error_description, azureCallback, fetchMe, navigate, dispatch])

  if (message) {
    return (
      <AuthLayout
        title="Sign-in failed"
        description={message}
        headerIcon={<XCircle className="h-10 w-10 text-destructive" />}
        footerSlot={
          <Link to="/login" className="block w-full">
            <Button className="h-11 w-full">Back to sign in</Button>
          </Link>
        }
      >
        <div />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Signing you in…"
      description="Completing your Microsoft sign-in."
      headerIcon={<Loader2 className="h-10 w-10 animate-spin text-primary" />}
    >
      <div />
    </AuthLayout>
  )
}
