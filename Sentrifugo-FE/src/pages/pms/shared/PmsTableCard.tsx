import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** White card the masters' tables sit in. */
export function PmsTableCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 sm:p-5", className)}>
      {children}
    </div>
  );
}

/** Uppercase table header cell, as in every PMS table. */
export function PmsTh({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <TableHead
      className={cn(
        "h-10 text-xs font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

export const PMS_HEADER_ROW =
  "border-0 bg-table-header hover:bg-table-header [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg";

/** `Showing 1 to 7 of 7 KRAs` — the footer under every master table. */
export function ShowingFooter({ count, noun }: { count: number; noun: string }) {
  if (count === 0) return null;
  return (
    <p className="px-1 pt-4 text-sm text-muted-foreground">
      Showing 1 to {count} of {count} {noun}
    </p>
  );
}

/** Placeholder rows while a master list loads. */
export function SkeletonRows({ rows = 5, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <TableRow key={r}>
          {Array.from({ length: cols }, (_c, c) => (
            <TableCell key={c}>
              <Skeleton className="h-4 w-full max-w-[10rem]" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
