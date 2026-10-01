import { Loader2 } from 'lucide-react'

interface FullScreenLoaderProps {
  message?: string
}

/**
 * Fixed-position blocking loader that covers the viewport. Use while a
 * long-running operation (e.g. file generation, large export) is in flight
 * and the user shouldn't be able to interact with the page underneath.
 */
export function FullScreenLoader({ message = 'Loading…' }: FullScreenLoaderProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-8 py-6 shadow-lg">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-sm font-medium text-foreground">{message}</p>
      </div>
    </div>
  )
}
