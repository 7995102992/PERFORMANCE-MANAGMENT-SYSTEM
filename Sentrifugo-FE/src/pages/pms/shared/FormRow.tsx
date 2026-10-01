import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface FormRowProps {
  label: string;
  required?: boolean;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}

/** Label-left / control-right row used by every wizard step. */
export function FormRow({
  label,
  required,
  htmlFor,
  hint,
  error,
  children,
  className,
}: FormRowProps) {
  return (
    <div
      className={cn(
        "grid gap-1.5 sm:grid-cols-[16rem_minmax(0,1fr)] sm:gap-6 sm:py-1",
        className,
      )}
    >
      <Label
        htmlFor={htmlFor}
        className="pt-2 text-sm font-medium text-foreground sm:leading-9 sm:pt-0"
      >
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      <div className="min-w-0 max-w-xl space-y-1.5">
        {children}
        {hint && !error && (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** Section heading inside a step card. */
export function StepSection({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description && (
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
