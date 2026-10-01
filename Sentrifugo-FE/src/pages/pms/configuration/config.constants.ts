import type { PmsCompetencyCategory, PmsTargetType } from "@/types/pms-config";

export const COMPETENCY_CATEGORY_LABEL: Record<PmsCompetencyCategory, string> = {
  behavioural: "Behavioural",
  technical: "Technical",
  leadership: "Leadership",
  functional: "Functional",
};

export const TARGET_TYPE_LABEL: Record<PmsTargetType, string> = {
  individual: "Individual",
  common: "Common",
};

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
