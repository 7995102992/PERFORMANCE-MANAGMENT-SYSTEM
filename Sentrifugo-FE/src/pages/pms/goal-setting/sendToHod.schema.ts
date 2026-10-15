import { z } from "zod";
import type { PmsEmployeeTargetKpi } from "@/types/pms-goals";

/** Longest note a manager can leave for the HOD (the API rejects more). */
export const HOD_NOTE_MAX = 500;

/** The optional note that goes to the HOD with the sheet. */
export const sendToHodSchema = z.object({
  remarks: z.string().trim().max(HOD_NOTE_MAX, `Keep the note under ${HOD_NOTE_MAX} characters`),
});

/** A KRA whose target moved after the manager first assigned it. */
export interface MovedKra {
  kpi_id: string;
  kra_name: string;
  kpi_name: string;
  unit: string;
  from: number;
  to: number;
  /** How many times the employee asked for a change on this KPI. */
  requests: number;
}

/** The KPIs whose current target differs from the one first assigned: what the HOD will be asked to approve. */
export function movedKras(kpis: PmsEmployeeTargetKpi[]): MovedKra[] {
  return kpis
    .filter((k) => k.original_target != null && k.target != null && k.original_target !== k.target)
    .map((k) => ({
      kpi_id: k.kpi_id,
      kra_name: k.kra_name,
      kpi_name: k.kpi_name,
      unit: k.unit,
      from: k.original_target as number,
      to: k.target as number,
      requests: k.revision_count ?? 0,
    }));
}

/** What stops a sheet from going to the HOD; empty when it can go. Mirrors the API's check. */
export function sheetProblems(kpis: PmsEmployeeTargetKpi[]): string[] {
  const problems: string[] = [];
  if (kpis.length === 0) {
    problems.push("The goal sheet has no KPIs.");
    return problems;
  }
  const missing = kpis.filter((k) => k.target == null).map((k) => k.kpi_name);
  if (missing.length > 0) problems.push(`Target missing for ${missing.join(", ")}.`);
  const total = kpis.reduce((sum, k) => sum + k.weight, 0);
  if (Math.abs(total - 100) > 0.01) problems.push(`Total weightage is ${Math.round(total * 100) / 100}% (must be 100%).`);
  return problems;
}
