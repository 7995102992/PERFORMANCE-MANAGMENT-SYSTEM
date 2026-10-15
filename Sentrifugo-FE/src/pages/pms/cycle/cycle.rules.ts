import { formatDisplayDate } from "../shared/pms.utils";
import { STAGE_LABEL } from "./cycle.constants";
import type { PmsStageKey } from "@/types/pms";

/** One stage row as the timeline form holds it (ISO `YYYY-MM-DD` dates, "" while empty). */
export interface StageDates {
  stage: string;
  start_date: string;
  end_date: string;
}

/** A broken rule: which stage row, which date field, and what to tell the user. */
export interface TimelineIssue {
  index: number;
  field: "start_date" | "end_date";
  message: string;
}

/** Stages that must finish inside the performance period; the appraisal stages follow it. */
const WITHIN_PERIOD: PmsStageKey[] = ["goal_setting", "employee_acknowledgement", "hod_approval"];

/** The year-end appraisal chain: each stage opens only after the one before it has closed (no overlap). */
const APPRAISAL_CHAIN: PmsStageKey[] = [
  "self_appraisal",
  "manager_appraisal",
  "hod_review",
  "hr_competency_rating",
  "calibration_final_approval",
  "approval_publish",
];

const label = (stage: PmsStageKey) => STAGE_LABEL[stage] ?? stage;
const fmt = (iso: string) => formatDisplayDate(iso);

/**
 * The business rules of the cycle timeline (screen 1.3). Dates are compared as ISO strings, which sort
 * the same as the dates. A rule is only checked when the dates it needs are filled in.
 *
 * - Every stage starts on or after the performance period start.
 * - Goal setting to mid-year review end within the performance period.
 * - Acknowledgement runs with goal setting: it cannot start before it, or end before it.
 * - HOD approval cannot start or end before acknowledgement does.
 * - Self appraisal opens after goal approval has closed (goals are frozen first).
 * - Self appraisal, L1 rating, L2 rating, HR competency rating, calibration and approval & publish are
 *   strictly one after the other.
 */
export function validateTimeline(
  stages: StageDates[],
  periodStart: string | undefined,
  periodEnd: string | undefined,
): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  const byStage = new Map<string, { row: StageDates; index: number }>();
  stages.forEach((row, index) => byStage.set(row.stage, { row, index }));

  const add = (stage: PmsStageKey, field: TimelineIssue["field"], message: string) => {
    const hit = byStage.get(stage);
    if (!hit) return;
    // One message per field: the first rule broken is the one to fix first.
    if (issues.some((i) => i.index === hit.index && i.field === field)) return;
    issues.push({ index: hit.index, field, message });
  };
  const start = (stage: PmsStageKey) => byStage.get(stage)?.row.start_date || undefined;
  const end = (stage: PmsStageKey) => byStage.get(stage)?.row.end_date || undefined;

  // Inside the performance period.
  for (const { row } of byStage.values()) {
    const key = row.stage as PmsStageKey;
    if (periodStart && row.start_date && row.start_date < periodStart) {
      add(key, "start_date", `Starts before the performance period (${fmt(periodStart)})`);
    }
    if (periodEnd && row.end_date && WITHIN_PERIOD.includes(key) && row.end_date > periodEnd) {
      add(key, "end_date", `Must end within the performance period (${fmt(periodEnd)})`);
    }
  }

  // Goal setting, acknowledgement, HOD approval run in that order, side by side.
  const gsStart = start("goal_setting");
  const gsEnd = end("goal_setting");
  const ackStart = start("employee_acknowledgement");
  const ackEnd = end("employee_acknowledgement");
  if (gsStart && ackStart && ackStart < gsStart) {
    add("employee_acknowledgement", "start_date", `Cannot start before Goal Setting starts (${fmt(gsStart)})`);
  }
  if (gsEnd && ackEnd && ackEnd < gsEnd) {
    add("employee_acknowledgement", "end_date", `Cannot end before Goal Setting ends (${fmt(gsEnd)})`);
  }
  const hodStart = start("hod_approval");
  const hodEnd = end("hod_approval");
  if (ackStart && hodStart && hodStart < ackStart) {
    add("hod_approval", "start_date", `Cannot start before Employee Acknowledgement starts (${fmt(ackStart)})`);
  }
  if (ackEnd && hodEnd && hodEnd < ackEnd) {
    add("hod_approval", "end_date", `Cannot end before Employee Acknowledgement ends (${fmt(ackEnd)})`);
  }

  // The year-end chain opens once goal approval has closed, then runs strictly one stage at a time.
  const selfStart = start("self_appraisal");
  if (hodEnd && selfStart && selfStart <= hodEnd) {
    add("self_appraisal", "start_date", `Overlaps Goal Approval (ends ${fmt(hodEnd)}); start after that`);
  }
  for (let i = 1; i < APPRAISAL_CHAIN.length; i++) {
    const previous = APPRAISAL_CHAIN[i - 1];
    const current = APPRAISAL_CHAIN[i];
    const previousEnd = end(previous);
    const currentStart = start(current);
    if (previousEnd && currentStart && currentStart <= previousEnd) {
      add(current, "start_date", `Overlaps ${label(previous)} (ends ${fmt(previousEnd)}); start after that`);
    }
  }
  return issues;
}
