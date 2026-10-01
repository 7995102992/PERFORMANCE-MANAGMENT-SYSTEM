import {
  CheckCircle2,
  Clock,
  Layers,
  PenLine,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { PmsCycleStatus, PmsCycleSummary } from "@/types/pms";

export type CycleFilter = PmsCycleStatus | "all";

const CARDS: {
  key: CycleFilter;
  label: string;
  icon: LucideIcon;
  tone: string;
}[] = [
  { key: "all", label: "All Cycles", icon: Layers, tone: "bg-primary/10 text-primary" },
  { key: "draft", label: "Draft", icon: PenLine, tone: "bg-amber-500/10 text-amber-600" },
  { key: "active", label: "Active", icon: Clock, tone: "bg-sky-500/10 text-sky-600" },
  { key: "closed", label: "Closed", icon: CheckCircle2, tone: "bg-emerald-500/10 text-emerald-600" },
  { key: "cancelled", label: "Cancelled", icon: XCircle, tone: "bg-muted text-muted-foreground" },
];

interface CycleStatCardsProps {
  summary?: PmsCycleSummary;
  selected: CycleFilter;
  onSelect: (filter: CycleFilter) => void;
  loading?: boolean;
}

/** Status counters that double as the primary list filter. */
export function CycleStatCards({
  summary,
  selected,
  onSelect,
  loading,
}: CycleStatCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {CARDS.map(({ key, label, icon: Icon, tone }) => {
        const active = selected === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            aria-pressed={active}
            className={cn(
              "group flex items-center justify-between rounded-xl border bg-card px-4 py-3.5 text-left",
              "transition-all hover:-translate-y-0.5 hover:shadow-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary/40 bg-primary/5 shadow-sm ring-1 ring-primary/20"
                : "border-border",
            )}
          >
            <div>
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              {loading ? (
                <Skeleton className="mt-1.5 h-7 w-8" />
              ) : (
                <p className="mt-0.5 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
                  {summary?.[key] ?? 0}
                </p>
              )}
            </div>
            <span
              className={cn(
                "flex size-10 items-center justify-center rounded-xl transition-transform group-hover:scale-105",
                tone,
              )}
            >
              <Icon className="size-5" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
