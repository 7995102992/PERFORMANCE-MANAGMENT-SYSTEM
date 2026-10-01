import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap transition-all [&>svg]:pointer-events-none [&>svg]:size-3.5!",
  {
    variants: {
      variant: {
        default:
          "h-5 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [a]:hover:bg-primary/80",
        secondary:
          "h-5 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "h-5 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "h-5 overflow-hidden rounded-4xl border px-2 py-0.5 text-xs font-medium border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "h-5 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-xs font-medium text-primary underline-offset-4 hover:underline",
        // Status variants — colored icon + muted label text
        active:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-active-text",
        inactive:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-inactive-text",
        pending:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-pending-text",
        draft:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-draft-text",
        reject:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-reject-text",
        inprogress:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-inprogress-text",
        open: "text-xs font-medium text-muted-foreground [&>svg]:text-badge-open-text",
        probation:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-probation-text",
        "notice-period":
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-notice-period-text",
        terminated:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-terminated-text",
        "on-bench":
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-on-bench-text",
        // Timesheet status variants
        submitted:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-pending-text",
        l1_approved:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-active-text",
        l1_rejected:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-reject-text",
        client_approved:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-active-text",
        client_rejected:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-reject-text",
        resubmitted:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-inprogress-text",
        not_submitted:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-draft-text",
        pending_approval:
          "text-xs font-medium text-muted-foreground [&>svg]:text-badge-pending-text",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { Badge, badgeVariants };
