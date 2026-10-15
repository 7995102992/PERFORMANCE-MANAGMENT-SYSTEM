import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { RATING_LABELS } from "./rating.constants";

/** 1-5 rating dropdown. `withLabel` shows `4 – Exceeds Expectations`; otherwise just the number. */
export function RatingSelect({
  value,
  onChange,
  label,
  withLabel = false,
  invalid = false,
  disabled = false,
  className,
}: {
  /** Selected rating 1-5, or null when not rated yet. */
  value: number | null;
  /** Called with the chosen rating. */
  onChange: (value: number) => void;
  /** Accessible name (aria-label) of the dropdown. */
  label: string;
  /** Show `4 – Exceeds Expectations` instead of just the number. */
  withLabel?: boolean;
  /** Red border + aria-invalid, set when validation failed for this row. */
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value === null ? "" : String(value)}
      onValueChange={(v) => onChange(Number(v))}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={label}
        aria-invalid={invalid}
        className={cn(withLabel ? "w-64" : "w-20", invalid && "border-destructive", className)}
      >
        <SelectValue placeholder="Rate" />
      </SelectTrigger>
      <SelectContent>
        {[5, 4, 3, 2, 1].map((n) => (
          <SelectItem key={n} value={String(n)}>
            {withLabel ? `${n} – ${RATING_LABELS[n]}` : n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
