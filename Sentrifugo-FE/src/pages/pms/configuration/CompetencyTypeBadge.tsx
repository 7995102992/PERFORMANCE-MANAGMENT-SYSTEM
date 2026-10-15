import type { PmsCompetencyType } from "@/types/pms-config";
import { cn } from "@/lib/utils";

/** `HR` (orange) or `Manager` (primary) tag, as in the competency master and the template step. */
export function CompetencyTypeBadge({ type }: { type: PmsCompetencyType }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs font-medium",
        type === "hr" ? "bg-orange-500/10 text-orange-600" : "bg-primary/10 text-primary",
      )}
    >
      {type === "hr" ? "HR" : "Manager"}
    </span>
  );
}
