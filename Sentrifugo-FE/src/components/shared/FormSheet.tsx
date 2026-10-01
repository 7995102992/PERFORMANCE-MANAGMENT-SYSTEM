import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Width of the sheet in px (number) or any CSS length string. Defaults to 480px. */
  width?: number | string;
  side?: "left" | "right";
  submitting?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit?: () => void;
  submitDisabled?: boolean;
  /** Hide the default footer entirely (pass null), or supply a custom one (any node). */
  footer?: React.ReactNode | null;
  /** Optional action rendered at the top-right of the header, left of the close button. */
  headerAction?: React.ReactNode;
  /** Optional className for the scrollable body. */
  bodyClassName?: string;
  children: React.ReactNode;
}

export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  width = 480,
  side = "right",
  submitting = false,
  submitLabel = "Submit",
  cancelLabel = "Cancel",
  onSubmit,
  submitDisabled = false,
  footer,
  headerAction,
  bodyClassName,
  children,
}: FormSheetProps) {
  const widthStyle = typeof width === "number" ? `${width}px` : width;

  const defaultFooter = (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={submitting}
      >
        {cancelLabel}
      </Button>
      <Button
        type="button"
        variant="soft"
        onClick={onSubmit}
        disabled={submitDisabled || submitting}
      >
        {submitLabel}
      </Button>
    </>
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="form-sheet-backdrop"
          className="fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Content
          data-slot="form-sheet-content"
          data-side={side}
          style={{ width: widthStyle, maxWidth: "100vw" }}
          className={cn(
            "fixed inset-y-0 z-50 flex flex-col bg-popover text-popover-foreground shadow-lg outline-none",
            "transition duration-200 ease-in-out",
            side === "right" &&
              "right-0 border-l data-open:animate-in data-open:slide-in-from-right-10 data-open:fade-in-0 data-closed:animate-out data-closed:slide-out-to-right-10 data-closed:fade-out-0",
            side === "left" &&
              "left-0 border-r data-open:animate-in data-open:slide-in-from-left-10 data-open:fade-in-0 data-closed:animate-out data-closed:slide-out-to-left-10 data-closed:fade-out-0",
          )}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="border-b px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <DialogPrimitive.Title
                data-slot="form-sheet-title"
                className="text-base font-semibold text-foreground"
              >
                {title}
              </DialogPrimitive.Title>
              <div className="flex items-center gap-1.5 shrink-0">
                {headerAction}
                <DialogPrimitive.Close asChild>
                  <Button variant="ghost" size="icon-sm">
                    <X />
                    <span className="sr-only">Close</span>
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </div>
            {description && (
              <DialogPrimitive.Description
                data-slot="form-sheet-description"
                className="text-sm text-muted-foreground mt-0.5"
              >
                {description}
              </DialogPrimitive.Description>
            )}
          </div>

          <div
            className={cn("flex-1 overflow-y-auto px-5 py-4", bodyClassName)}
          >
            {children}
          </div>

          {footer !== null && (
            <div className="flex justify-end gap-2 border-t bg-popover px-5 py-2.5">
              {footer ?? defaultFooter}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
