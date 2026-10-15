import type { ZodError } from "zod";

/** Field errors keyed by the dotted path (`rows.2.target`); the first message per field wins. */
export type FieldErrors = Record<string, string>;

export function toFieldErrors(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** `""` → null, otherwise the number (NaN when the text is not numeric). */
export function parseDecimal(text: string): number | null {
  if (text.trim() === "") return null;
  return Number(text);
}

/** Display a number without trailing zeros: `18.50` → `18.5`, `5650` → `5,650`. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}
