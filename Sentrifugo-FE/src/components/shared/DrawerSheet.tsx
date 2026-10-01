import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface DrawerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}

function DrawerSheet({
  open,
  onOpenChange,
  children,
  className,
  wide = true,
}: DrawerSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={cn(
          "flex flex-col p-0 gap-0",
          wide ? "w-[80vw] max-w-[80vw]" : "w-[50vw] max-w-[50vw]",
          className,
        )}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}

function DrawerSheetBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex-1 overflow-y-auto px-5 py-4 space-y-5", className)}
    >
      {children}
    </div>
  );
}

function DrawerSheetFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-t px-5 py-3 flex items-center justify-between",
        className,
      )}
    >
      {children}
    </div>
  );
}

export {
  DrawerSheet,
  DrawerSheetBody,
  DrawerSheetFooter,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
