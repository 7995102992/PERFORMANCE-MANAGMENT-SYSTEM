import { addMonths, format, getDaysInMonth, parseISO, startOfMonth } from "date-fns";

/** ISO `YYYY-MM-DD` → local Date (undefined for empty / invalid input). */
export function isoToDate(iso?: string | null): Date | undefined {
  if (!iso) return undefined;
  const d = parseISO(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function dateToIso(date?: Date): string {
  return date ? format(date, "yyyy-MM-dd") : "";
}

/** `2026-04-18` → `18-Apr-2026`, matching the other list pages. */
export function formatDisplayDate(iso?: string | null): string {
  const d = isoToDate(iso);
  return d ? format(d, "dd-MMM-yyyy") : "—";
}

/** `2026-04-01` → `Apr 2026`. */
export function formatMonthYear(iso?: string | null): string {
  const d = isoToDate(iso);
  return d ? format(d, "MMM yyyy") : "—";
}

/** Financial year start of the date, assuming an April–March year. */
export function financialYearOf(iso: string): number {
  const d = isoToDate(iso);
  if (!d) return new Date().getFullYear();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

/** `2026` → `FY 2026-27`. */
export function financialYearLabel(startYear: number): string {
  return `FY ${startYear}-${String(startYear + 1).slice(2)}`;
}

/** Day `day` of the month `monthOffset` months after the period start's month. */
export function relativeDate(
  periodStart: Date,
  monthOffset: number,
  day: number,
): string {
  const month = addMonths(startOfMonth(periodStart), monthOffset);
  month.setDate(Math.min(day, getDaysInMonth(month)));
  return format(month, "yyyy-MM-dd");
}
