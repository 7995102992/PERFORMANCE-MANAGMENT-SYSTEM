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
import { dateToIso, isoToDate, relativeDate } from "../shared/pms.utils";

export const PMS_CYCLE_LIST_PATH = "/pms/cycle";

export const APPRAISAL_TYPE_LABEL: Record<PmsAppraisalType, string> = {
  annual: "Annual",
  mid_year: "Mid-Year",
  custom: "Custom",
};

export const APPRAISAL_TYPE_OPTIONS = (
  Object.keys(APPRAISAL_TYPE_LABEL) as PmsAppraisalType[]
).map((value) => ({ value, label: APPRAISAL_TYPE_LABEL[value] }));

export const EMPLOYMENT_TYPE_OPTIONS: {
  value: PmsEmploymentType;
  label: string;
}[] = [
  { value: "permanent", label: "Permanent" },
  { value: "contract", label: "Contract" },
  { value: "trainee", label: "Trainee" },
];

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

export const WIZARD_STEPS: StepperStep[] = [
  { id: 0, label: "Basic Details" },
  { id: 1, label: "Timeline" },
  { id: 2, label: "Applicability" },
  { id: 3, label: "Rating & Publish" },
];

export const STAGE_LABEL: Record<PmsStageKey, string> = {
  goal_setting: "Goal Setting",
  employee_acknowledgement: "Employee Acknowledgement",
  hod_approval: "HOD Approval",
  progress_tracking: "Progress Tracking",
  mid_year_review: "Mid-Year Review",
  self_appraisal: "Self Appraisal",
  manager_appraisal: "Manager Appraisal",
  hod_review: "HOD Review",
  calibration_final_approval: "Calibration & Final Approval",
};

/** [stage, start (monthOffset, day), end (monthOffset, day)] from period start. */
const STAGE_TEMPLATE: [PmsStageKey, [number, number], [number, number]][] = [
  ["goal_setting", [1, 1], [1, 20]],
  ["employee_acknowledgement", [1, 1], [1, 25]],
  ["hod_approval", [1, 21], [1, 31]],
  ["progress_tracking", [2, 1], [11, 31]],
  ["mid_year_review", [6, 1], [6, 31]],
  ["self_appraisal", [12, 1], [12, 10]],
  ["manager_appraisal", [12, 11], [12, 20]],
  ["hod_review", [12, 21], [12, 27]],
  ["calibration_final_approval", [12, 28], [13, 15]],
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

export function buildEmptyCycle(): PmsCycleUpsert {
  const now = new Date();
  const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const start = dateToIso(new Date(fy, 3, 1));
  return {
    basic: {
      name: "",
      description: "",
      type: "annual",
      period_start: start,
      period_end: dateToIso(new Date(fy + 1, 2, 31)),
    },
    stages: buildDefaultStages(start),
    applicability: {
      plant_ids: [],
      all_departments: true,
      department_ids: [],
      employment_types: ["permanent"],
      min_service_months: 12,
      service_as_on: start,
      exclude_probation: true,
      exclude_notice_period: true,
    },
    finalize: {
      rating_scale_id: "",
      notify_managers: true,
      notify_employees: true,
      notify_hod: true,
      notify_hr: true,
    },
  };
}
