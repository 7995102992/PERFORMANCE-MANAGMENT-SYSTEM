import { useNavigate } from '@tanstack/react-router'
import { LogIn } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppDispatch, useAppSelector } from '@/store'
import { clearToken } from '@/store/slices/auth-slice'

export function SessionExpiredModal() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const sessionExpired = useAppSelector((s) => s.auth.sessionExpired)

  function handleLoginAgain() {
    dispatch(clearToken())
    navigate({ to: '/login' })
  }

  return (
    <Dialog open={sessionExpired}>
      <DialogContent
        className="sm:max-w-sm text-center"
        showCloseButton={false}
      >
        <DialogHeader className="items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <LogIn size={22} className="text-destructive" />
          </div>
          <DialogTitle className="text-lg font-bold">Session Expired</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Your session has expired. Please log in again to continue.
          </DialogDescription>
        </DialogHeader>
        <Button className="w-full mt-2 rounded-xl font-semibold" onClick={handleLoginAgain}>
          Login Again
        </Button>
      </DialogContent>
    </Dialog>
  )
}
