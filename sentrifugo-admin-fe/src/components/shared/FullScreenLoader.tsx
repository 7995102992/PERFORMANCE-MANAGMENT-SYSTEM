import { Loader2 } from 'lucide-react'

interface FullScreenLoaderProps {
  message?: string
}

export function FullScreenLoader({ message = 'Please wait...' }: FullScreenLoaderProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-8 shadow-lg">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}
