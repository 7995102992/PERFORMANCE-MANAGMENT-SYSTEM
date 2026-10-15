import {
  CheckCircle2,
  Clock,
  FilePen,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { StepperStep } from "@/components/ui/stepper";
import type {
  PmsAppraisalType,
  PmsCycleStage,
  PmsCycleStatus,
  PmsCycleUpsert,
  PmsEmploymentType,
  PmsStageKey,
} from "@/types/pms";
import { isoToDate, relativeDate } from "../shared/pms.utils";

/** Route of the cycle list; every wizard exit goes here. */
export const PMS_CYCLE_LIST_PATH = "/pms/cycle";

/** Appraisal type value to label. */
export const APPRAISAL_TYPE_LABEL: Record<PmsAppraisalType, string> = {
  annual: "Annual",
  mid_year: "Mid-Year",
  custom: "Custom",
};

/** Appraisal type options for the select (built from the label map). */
export const APPRAISAL_TYPE_OPTIONS = (
  Object.keys(APPRAISAL_TYPE_LABEL) as PmsAppraisalType[]
).map((value) => ({ value, label: APPRAISAL_TYPE_LABEL[value] }));

/** What the Applicability step offers. `contract` is still understood by the API but is not chosen here. */
export const EMPLOYMENT_TYPE_OPTIONS: {
  value: PmsEmploymentType;
  label: string;
}[] = [
  { value: "permanent", label: "Permanent" },
  { value: "probationary", label: "Probationary" },
  { value: "trainee", label: "Trainee" },
];

export const EMPLOYMENT_TYPE_LABEL: Record<PmsEmploymentType, string> = {
  permanent: "Permanent",
  contract: "Contract",
  probationary: "Probationary",
  trainee: "Trainee",
};

/** Label, icon and colour per cycle status; used by CycleStatusBadge. */
export const CYCLE_STATUS_META: Record<
  PmsCycleStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  draft: {
    label: "Draft",
    icon: FilePen,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  active: {
    label: "Active",
    icon: Clock,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  closed: {
    label: "Closed",
    icon: CheckCircle2,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  cancelled: {
    label: "Cancelled",
    icon: XCircle,
    className: "bg-muted text-muted-foreground",
  },
};

/** The four wizard steps; `id` is the position and the index into STEP_SCHEMAS. */
export const WIZARD_STEPS: StepperStep[] = [
  { id: 0, label: "Basic Details" },
  { id: 1, label: "Timeline" },
  { id: 2, label: "Applicability" },
  { id: 3, label: "Rating & Publish" },
];

/** Stage key to display name (nine stages, in process order). */
export const STAGE_LABEL: Record<PmsStageKey, string> = {
  goal_setting: "Goal Setting (Section Head sets targets)",
  employee_acknowledgement: "Employee Acknowledgement",
  hod_approval: "Goal Approval (L2)",
  self_appraisal: "Self Appraisal",
  manager_appraisal: "L1 Rating",
  hod_review: "L2 Rating",
  hr_competency_rating: "HR Competency Rating (Plant HR / Corporate HR)",
  calibration_final_approval: "Calibration (Corporate HR)",
  approval_publish: "Approval & Publish (GP)",
};

/** [stage, start (monthOffset, day), end (monthOffset, day)] from period start. */
const STAGE_TEMPLATE: [PmsStageKey, [number, number], [number, number]][] = [
  ["goal_setting", [1, 1], [1, 20]],
  ["employee_acknowledgement", [1, 1], [1, 25]],
  ["hod_approval", [1, 21], [1, 31]],
  ["self_appraisal", [12, 1], [12, 10]],
  ["manager_appraisal", [12, 11], [12, 17]],
  ["hod_review", [12, 18], [12, 23]],
  ["hr_competency_rating", [12, 24], [12, 28]],
  ["calibration_final_approval", [12, 29], [13, 6]],
  ["approval_publish", [13, 7], [13, 12]],
];

/** Suggested stage dates for a cycle starting at `periodStartIso`. */
export function buildDefaultStages(periodStartIso: string): PmsCycleStage[] {
  const start = isoToDate(periodStartIso) ?? new Date();
  return STAGE_TEMPLATE.map(([stage, s, e]) => ({
    stage,
    start_date: relativeDate(start, s[0], s[1]),
    end_date: relativeDate(start, e[0], e[1]),
    notify: true,
  }));
}

/** The nine stages with no dates: the user picks every date. */
export function buildBlankStages(): PmsCycleStage[] {
  return STAGE_TEMPLATE.map(([stage]) => ({ stage, start_date: "", end_date: "", notify: true }));
}

/**
 * Blank wizard form: no dates are pre-filled (period, stage dates and the service cut-off are all picked by
 * the user), with the default applicability / notification rules.
 */
export function buildEmptyCycle(): PmsCycleUpsert {
  return {
    basic: {
      name: "",
      description: "",
      type: "annual",
      period_start: "",
      period_end: "",
    },
    stages: buildBlankStages(),
    applicability: {
      plant_ids: [],
      all_departments: true,
      department_ids: [],
      goal_setting: {
        employment_types: ["permanent", "probationary", "trainee"],
        min_service_months: 0,
      },
      appraisal: {
        employment_types: ["permanent"],
        min_service_months: 12,
        service_as_on: "",
      },
      exclude_notice_period: true,
    },
    finalize: {
      rating_scale_id: "",
      notify_managers: true,
      notify_employees: true,
      notify_hod: true,
      notify_hr: true,
      notify_gp: true,
      approval_workflow_id: "",
    },
  };
}
