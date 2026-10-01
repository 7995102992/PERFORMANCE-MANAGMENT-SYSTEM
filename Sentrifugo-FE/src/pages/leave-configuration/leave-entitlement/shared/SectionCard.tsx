import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Card, CardContent } from '@/components/ui/card'

interface SectionCardProps {
  title: string
  description: string
  children: ReactNode
  defaultOpen?: boolean
}

export function SectionCard({ title, description, children, defaultOpen = true }: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CardContent className="space-y-5 pt-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between text-left hover:bg-muted/30 transition-colors rounded-xl -mx-2 px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-b pb-4"
            >
              <div className="space-y-1">
                <p className="text-base font-semibold text-foreground">{title}</p>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
              <div className="ml-4 shrink-0 text-muted-foreground">
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight  />}
              </div>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {children}
          </CollapsibleContent>
        </CardContent>
      </Card>
    </Collapsible>
  )
}
