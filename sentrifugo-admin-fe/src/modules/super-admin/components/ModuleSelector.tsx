import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULE_DEFINITIONS, type ModuleKey } from "@/api/super-admin/types";
import { useModuleCatalog } from "@/hooks/queries/use-module-catalog";
import type { ModuleCatalogItem } from "@/api/super-admin/types";
import {
  Users,
  CalendarCheck,
  Calendar,
  CircleDollarSign,
  TrendingUp,
  UserPlus,
  GraduationCap,
  Receipt,
  Package,
  Headphones,
  Clock,
  BarChart3,
} from "lucide-react";
import type { ElementType } from "react";

// ─── Icon map ─────────────────────────────────────────────────────────────────

const MODULE_ICONS: Record<ModuleKey, ElementType> = {
  core_hr: Users,
  attendance_management: CalendarCheck,
  leave_management: Calendar,
  payroll: CircleDollarSign,
  performance_management: TrendingUp,
  recruitment: UserPlus,
  training_and_development: GraduationCap,
  expense_management: Receipt,
  asset_management: Package,
  service_request: Headphones,
  timesheet_management: Clock,
  reports_and_analytics: BarChart3,
};

// ─── Individual module card ───────────────────────────────────────────────────

interface ModuleCardProps {
  module: ModuleCatalogItem;
  selected: boolean;
  onToggle: (key: ModuleKey) => void;
  readOnly: boolean;
}

function ModuleCard({ module, selected, onToggle, readOnly }: ModuleCardProps) {
  const Icon = MODULE_ICONS[module.code] ?? Package;
  const isChecked = module.mandatory || selected;

  return (
    <button
      type="button"
      disabled={module.mandatory || readOnly}
      onClick={() => !module.mandatory && !readOnly && onToggle(module.code)}
      className={cn(
        "relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isChecked
          ? "border-border bg-muted/30"
          : "border-border bg-card hover:border-foreground/20 hover:shadow-sm",
        (module.mandatory || readOnly) && "cursor-default",
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition-colors",
          isChecked ? "bg-icon-bg text-icon" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold leading-tight">{module.label}</p>
          <Checkbox
            checked={isChecked}
            disabled={module.mandatory || readOnly}
            className="shrink-0 pointer-events-none mt-0.5"
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground leading-snug">
          {module.description}
        </p>
        {module.mandatory && (
          <Badge className="mt-2 w-fit bg-muted text-muted-foreground border-border text-[10px] px-2 py-0">
            Mandatory
          </Badge>
        )}
      </div>
    </button>
  );
}

// ─── Module selector ──────────────────────────────────────────────────────────

interface ModuleSelectorProps {
  selected: ModuleKey[];
  onChange: (selected: ModuleKey[]) => void;
  readOnly?: boolean;
  catalog?: ModuleCatalogItem[];
}

export function ModuleSelector({
  selected,
  onChange,
  readOnly = false,
  catalog,
}: ModuleSelectorProps) {
  const { data: apiModules, isLoading } = useModuleCatalog();

  // Use provided catalog, API data, or fall back to hardcoded definitions
  const modules: ModuleCatalogItem[] =
    catalog && catalog.length > 0
      ? catalog
      : apiModules && apiModules.length > 0
        ? apiModules
        : MODULE_DEFINITIONS.map((m) => ({
            id: m.key,
            code: m.key,
            label: m.label,
            description: m.description,
            mandatory: m.mandatory ?? false,
          }));

  const handleToggle = (key: ModuleKey) => {
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : [...selected, key];
    onChange(next);
  };

  const selectedCount = modules.filter(
    (m) => m.mandatory || selected.includes(m.code),
  ).length;

  if (isLoading && !catalog) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-64" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {readOnly
          ? "Modules enabled for this organisation."
          : "Choose the modules to enable for this organisation. Core HR is mandatory."}
      </p>
      <p className="text-sm font-medium text-foreground">
        {selectedCount} module{selectedCount !== 1 ? "s" : ""} selected
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {modules.map((mod) => (
          <ModuleCard
            key={mod.code}
            module={mod}
            selected={mod.mandatory ? true : selected.includes(mod.code)}
            onToggle={readOnly ? () => {} : handleToggle}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
}
