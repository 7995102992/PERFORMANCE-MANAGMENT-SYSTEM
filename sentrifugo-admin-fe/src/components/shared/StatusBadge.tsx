import type { ComponentType } from 'react'
import { Badge } from '@/components/ui/badge'
import { CircleCheck, CircleX, Clock, History, Check, FilePen, Timer, Bell, Coffee } from 'lucide-react'

type StatusVariant = 'active' | 'inactive' | 'pending' | 'draft' | 'reject' | 'inprogress' | 'open' | 'probation' | 'notice-period' | 'terminated' | 'on-bench'

const STATUS_CONFIG: Record<StatusVariant, { icon: ComponentType<{ className?: string }>; label: string }> = {
  active:          { icon: CircleCheck, label: 'Active' },
  inactive:        { icon: CircleX,     label: 'Inactive' },
  pending:         { icon: Clock,       label: 'Pending' },
  draft:           { icon: FilePen,     label: 'Draft' },
  reject:          { icon: CircleX,     label: 'Reject' },
  inprogress:      { icon: History,     label: 'In Progress' },
  open:            { icon: Check,       label: 'Open' },
  probation:       { icon: Timer,       label: 'Probation' },
  'notice-period': { icon: Bell,        label: 'Notice Period' },
  terminated:      { icon: CircleX,     label: 'Terminated' },
  'on-bench':      { icon: Coffee,      label: 'On Bench' },
}

interface StatusBadgeProps {
  status: StatusVariant | boolean
  activeLabel?: string
  inactiveLabel?: string
}

export function StatusBadge({ status, activeLabel, inactiveLabel }: StatusBadgeProps) {
  const variant: StatusVariant = typeof status === 'boolean' ? (status ? 'active' : 'inactive') : status
  const config = STATUS_CONFIG[variant]
  const Icon = config.icon
  const label = variant === 'active' && activeLabel
    ? activeLabel
    : variant === 'inactive' && inactiveLabel
      ? inactiveLabel
      : config.label

  return (
    <Badge variant={variant}>
      <Icon />
      {label}
    </Badge>
  )
}
