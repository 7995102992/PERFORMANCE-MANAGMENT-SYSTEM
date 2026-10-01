import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: "default" | "error" | "warning";
}

const iconBoxStyles = {
  default: "bg-icon-bg text-icon",
  error: "bg-destructive/10 text-destructive",
  warning: "bg-badge-pending-bg text-badge-pending-text",
};

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  variant = "default",
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-14 gap-3 text-center">
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-xl",
          iconBoxStyles[variant],
        )}
      >
        <Icon className="size-5" />
      </div>
      <div>
        <p
          className={cn(
            "text-sm font-semibold",
            variant === "error" ? "text-destructive" : "text-foreground",
          )}
        >
          {title}
        </p>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
