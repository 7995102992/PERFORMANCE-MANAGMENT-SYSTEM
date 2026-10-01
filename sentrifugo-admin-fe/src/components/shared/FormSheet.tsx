import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** Width of the sheet in px (number) or any CSS length string. Defaults to 480px. */
  width?: number | string
  side?: 'left' | 'right'
  submitting?: boolean
  submitLabel?: string
  cancelLabel?: string
  onSubmit?: () => void
  submitDisabled?: boolean
  /** Hide the default footer entirely (pass null), or supply a custom one (any node). */
  footer?: React.ReactNode | null
  /** Optional action rendered at the top-right of the header, left of the close button. */
  headerAction?: React.ReactNode
  /** Optional className for the scrollable body. */
  bodyClassName?: string
  children: React.ReactNode
}

export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  width = 480,
  side = 'right',
  submitting = false,
  submitLabel = 'Submit',
  cancelLabel = 'Cancel',
  onSubmit,
  submitDisabled = false,
  footer,
  headerAction,
  bodyClassName,
  children,
}: FormSheetProps) {
  const widthStyle = typeof width === 'number' ? `${width}px` : width

  const defaultFooter = (
    <>
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
        {cancelLabel}
      </Button>
      <Button type="button" variant="soft" onClick={onSubmit} disabled={submitDisabled || submitting}>
        {submitLabel}
      </Button>
    </>
  )

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => onOpenChange(o)}
      modal
      disablePointerDismissal
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="form-sheet-backdrop"
          className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-100 supports-backdrop-filter:backdrop-blur-xs data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
        />
        <DialogPrimitive.Popup
          data-slot="form-sheet-content"
          data-side={side}
          style={{ width: widthStyle, maxWidth: '100vw' }}
          className={cn(
            'fixed inset-y-0 z-50 flex flex-col bg-popover text-popover-foreground shadow-lg outline-none',
            'transition-transform duration-200 ease-in-out',
            side === 'right' && 'right-0 border-l data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
            side === 'left' && 'left-0 border-r data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full',
          )}
        >
          <div className="relative flex flex-col gap-1 border-b px-6 py-5">
            <DialogPrimitive.Title
              data-slot="form-sheet-title"
              className="text-lg font-semibold text-foreground"
              render={<h2 />}
            >
              {title}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description
                data-slot="form-sheet-description"
                className="text-sm text-muted-foreground"
                render={<p />}
              >
                {description}
              </DialogPrimitive.Description>
            )}
            {headerAction && (
              <div className="absolute top-2.5 right-14">{headerAction}</div>
            )}
            <DialogPrimitive.Close
              data-slot="form-sheet-close"
              render={
                <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3">
                  <X />
                  <span className="sr-only">Close</span>
                </Button>
              }
            />
          </div>

          <div className={cn('flex-1 overflow-y-auto px-6 py-5', bodyClassName)}>
            {children}
          </div>

          {footer !== null && (
            <div className="flex justify-end gap-2 border-t bg-popover px-6 py-4">
              {footer ?? defaultFooter}
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
