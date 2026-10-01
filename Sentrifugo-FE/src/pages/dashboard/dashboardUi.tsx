import type { ReactNode } from "react";
import { format, parseISO } from "date-fns";
import {
  CircleCheck,
  CircleX,
  Clock,
  History,
  Inbox,
  Loader2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const ACCENTS: Record<string, string> = {
  primary: "bg-primary/10 text-primary",
  violet: "bg-primary/10 text-primary",
  blue: "bg-info/10 text-info",
  emerald: "bg-success/10 text-success",
  amber: "bg-warning/10 text-warning",
  rose: "bg-destructive/10 text-destructive",
  slate: "bg-muted text-muted-foreground",
};

export function DashCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function DashHeader({
  title,
  icon,
  accent = "primary",
  action,
}: {
  title: string;
  icon?: ReactNode;
  accent?: keyof typeof ACCENTS | string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? (
          <span
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-xl ${ACCENTS[accent] ?? ACCENTS.primary}`}
          >
            {icon}
          </span>
        ) : null}
        <h3 className="truncate text-sm font-semibold text-foreground tracking-tight">
          {title}
        </h3>
      </div>
      {action ? (
        <button
          onClick={action.onClick}
          className="shrink-0 text-xs font-medium text-primary transition-opacity hover:opacity-70"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </h2>
  );
}

export function DashSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center py-7 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

export function Stat({
  value,
  caption,
  className = "",
}: {
  value: ReactNode;
  caption?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-2xl font-bold leading-none tracking-tight text-foreground">
        {value}
      </div>
      {caption ? (
        <div className="mt-1.5 text-xs text-muted-foreground">{caption}</div>
      ) : null}
    </div>
  );
}

// ─── Shared helpers (consolidated from MyView / ManagerTeamView / teamCards) ──

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function fmtDate(
  iso: string | null | undefined,
  pattern = "dd-MMM",
): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), pattern);
  } catch {
    return iso;
  }
}

export function dateRange(
  start: string,
  end: string,
  pattern = "dd-MMM",
): string {
  return start === end
    ? fmtDate(start, pattern)
    : `${fmtDate(start, pattern)} – ${fmtDate(end, pattern)}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const diff = Date.now() - parseISO(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return "";
  }
}

// ─── Shared small components ─────────────────────────────────────────────────

export function DashEmpty({
  icon: Icon = Inbox,
  label,
}: {
  icon?: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-6 text-center text-[13px] text-muted-foreground">
      <Icon className="size-5 opacity-40" />
      {label}
    </div>
  );
}

export function StatRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${muted ? "text-muted-foreground" : ""}`}
    >
      <span>{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function DashTabList({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex items-center gap-3 text-xs ${className}`}
    >
      {children}
    </div>
  );
}

// Inline status — icon + label, mirrors <StatusCell> at dashboard scale
export type DashTone = "success" | "destructive" | "pending" | "muted";

const TONE_CLASS: Record<DashTone, string> = {
  success: "text-success",
  destructive: "text-destructive",
  pending: "text-badge-inprogress-text",
  muted: "text-muted-foreground",
};

const TONE_ICON: Record<DashTone, LucideIcon | null> = {
  success: CircleCheck,
  destructive: CircleX,
  pending: History,
  muted: null,
};

export function DashStatus({
  label,
  tone,
}: {
  label: string;
  tone: DashTone;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${TONE_CLASS[tone]}`}
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      {label}
    </span>
  );
}

export function TimeAgo({ iso }: { iso?: string | null }) {
  const text = ago(iso);
  if (!text) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
      <Clock className="size-3" />
      {text}
    </span>
  );
}

// Scrollable card body with dashed row dividers
export function DashList({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`min-h-0 flex-1 divide-y divide-dashed overflow-y-auto thin-scrollbar ${className}`}
    >
      {children}
    </div>
  );
}

export function DashTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`border-b-2 pb-0.5 font-medium transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
