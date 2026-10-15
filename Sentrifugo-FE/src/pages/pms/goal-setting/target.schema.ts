import { z } from "zod";
import type { FieldErrors } from "../shared/validation";

/** One KPI row of the target form, as typed (text until it is turned into numbers for the API). */
export interface TargetFormRow {
  kpi_id: string;
  kpi_name: string;
  weight: string;
  target: string;
}

/** A weight typed as text: required, numeric, 0 to 100. */
const weightField = z
  .string()
  .trim()
  .min(1, "Required")
  .refine((v) => Number.isFinite(Number(v)), "Numbers only")
  .refine((v) => Number(v) >= 0 && Number(v) <= 100, "0 to 100");

/** A target typed as text: required and numeric. */
const targetField = z
  .string()
  .trim()
  .min(1, "Required")
  .refine((v) => Number.isFinite(Number(v)), "Numbers only");

/** Result of checkTargetRows. */
export interface TargetCheck {
  /** Keyed `rows.<index>.weight` / `rows.<index>.target`. */
  fieldErrors: FieldErrors;
  /** Sentences for the banner above the table. */
  summary: string[];
  total: number;
}

/** Screens 3.3 / 3.4: the checks the manager sees before the sheet is validated on the server. */
export function checkTargetRows(rows: TargetFormRow[]): TargetCheck {
  const fieldErrors: FieldErrors = {};
  const summary: string[] = [];

  const total = rows.reduce((sum, r) => {
    const n = Number(r.weight);
    return sum + (r.weight.trim() !== "" && Number.isFinite(n) ? n : 0);
  }, 0);
  const roundedTotal = Math.round(total * 100) / 100;
  const totalBad = Math.abs(total - 100) > 0.01;
  if (totalBad) summary.push(`Total weightage is ${roundedTotal}% (must be 100%)`);

  rows.forEach((r, i) => {
    const w = weightField.safeParse(r.weight);
    if (!w.success) {
      fieldErrors[`rows.${i}.weight`] = w.error.issues[0].message;
      summary.push(`${r.kpi_name} weight must be a number between 0 and 100`);
    } else if (totalBad) {
      // The sum is wrong, so every weight is a suspect: mark them all without a message per row.
      fieldErrors[`rows.${i}.weight`] = "";
    }

    const t = targetField.safeParse(r.target);
    if (!t.success) {
      const message = t.error.issues[0].message;
      fieldErrors[`rows.${i}.target`] = message;
      summary.push(
        message === "Required"
          ? `Target missing for ${r.kpi_name}`
          : `${r.kpi_name} target must be a number (no <, >, ≤, ≥)`,
      );
    }
  });

  return { fieldErrors, summary, total: roundedTotal };
}
