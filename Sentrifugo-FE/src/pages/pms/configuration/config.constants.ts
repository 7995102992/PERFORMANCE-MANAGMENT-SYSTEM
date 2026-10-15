import type { PmsCompetencyCategory, PmsTargetType } from "@/types/pms-config";

/** Competency category value to display label. */
export const COMPETENCY_CATEGORY_LABEL: Record<PmsCompetencyCategory, string> = {
  behavioural: "Behavioural",
  technical: "Technical",
  leadership: "Leadership",
  functional: "Functional",
};

/** KPI target type value to display label (individual or common). */
export const TARGET_TYPE_LABEL: Record<PmsTargetType, string> = {
  individual: "Individual",
  common: "Common",
};

/** Route of the goal template list; wizard exits go here. */
export const GOAL_TEMPLATES_PATH = "/pms/configuration/goal-templates";

/** Current financial year start (April–March). */
export function currentFinancialYear(now = new Date()): number {
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

/** Next year, this year and the three before — newest first. */
export function financialYearOptions(now = new Date()): number[] {
  const cur = currentFinancialYear(now);
  return [cur + 1, cur, cur - 1, cur - 2, cur - 3];
}
