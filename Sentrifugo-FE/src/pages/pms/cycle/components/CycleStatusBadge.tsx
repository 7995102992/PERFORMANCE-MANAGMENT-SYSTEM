import { cn } from "@/lib/utils";
import type { PmsCycleStatus } from "@/types/pms";
import { CYCLE_STATUS_META } from "../cycle.constants";

export function CycleStatusBadge({
  status,
  className,
}: {
  status: PmsCycleStatus;
  className?: string;
}) {
  const { label, icon: Icon, className: tone } = CYCLE_STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone,
        className,
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}
