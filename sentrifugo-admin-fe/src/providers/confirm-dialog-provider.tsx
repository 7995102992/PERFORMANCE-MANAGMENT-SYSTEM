import * as React from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export type ConfirmOptions = {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: "default" | "destructive"
  onConfirm: () => void | Promise<void>
  onCancel?: () => void
}

type ConfirmContextType = (options: ConfirmOptions) => void

const ConfirmContext = React.createContext<ConfirmContextType | undefined>(undefined)

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null)
  const [loading, setLoading] = React.useState(false)

  const confirm = React.useCallback((newOptions: ConfirmOptions) => {
    setOptions(newOptions)
    setOpen(true)
  }, [])

  const handleConfirm = async () => {
    if (!options) return
    try {
      setLoading(true)
      await options.onConfirm()
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setOpen(false)
    }
  }

  const handleCancel = () => {
    options?.onCancel?.()
    setOpen(false)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={(isOpen) => !loading && setOpen(isOpen)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && (
              <AlertDialogDescription>
                {options.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel} disabled={loading}>
              {options?.cancelText || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction 
              onClick={(e) => {
                e.preventDefault() // prevent closing before promise resolves
                handleConfirm()
              }} 
              disabled={loading}
              className={options?.variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
            >
              {loading ? "Please wait..." : (options?.confirmText || "Confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfirm() {
  const context = React.useContext(ConfirmContext)
  if (!context) {
    throw new Error("useConfirm must be used within a ConfirmDialogProvider")
  }
  return context
}
