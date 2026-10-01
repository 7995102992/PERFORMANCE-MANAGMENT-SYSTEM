import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** Optional: description alias for subtitle (backward compat) */
  description?: string
  action?: ReactNode
  meta?: ReactNode
  /** Extra classes on the header row — e.g. `items-center` to vertically
   *  centre the action against the title block. */
  className?: string
}

export function PageHeader({ title, subtitle, description, action, meta, className }: PageHeaderProps) {
  const sub = subtitle ?? description
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {meta}
        </div>
        {sub && (
          <p className="text-sm text-muted-foreground mt-0.5">{sub}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
