import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Icon + text status, as used in the manager tables (e.g. "Draft", "Submitted"). */
export function StatusLabel({
  // icon: lucide icon; label: text; className: colour class (e.g. text-emerald-600).
  icon: Icon,
  label,
  className,
}: {
  icon: LucideIcon;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}
