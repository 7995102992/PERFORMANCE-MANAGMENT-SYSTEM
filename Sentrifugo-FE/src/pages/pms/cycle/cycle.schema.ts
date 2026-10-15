import { z } from "zod";
import { validateTimeline } from "./cycle.rules";

/** A required ISO date string; `message` is shown when empty. */
const iso = (message: string) => z.string().min(1, message);

/** Step 1: name, type and period (end must be after start). */
export const basicSchema = z.object({
  basic: z
    .object({
      name: z
        .string()
        .trim()
        .min(1, "Cycle name is required")
        .max(120, "Keep the name under 120 characters"),
      description: z.string().max(500, "Keep the description under 500 characters"),
      type: z.enum(["annual", "mid_year", "custom"]),
      period_start: iso("Select the start date"),
      period_end: iso("Select the end date"),
    })
    .refine((b) => !b.period_start || !b.period_end || b.period_end > b.period_start, {
      path: ["period_end"],
      message: "End date must be after the start date",
    })
    // A performance period is at most a year: the end may not be after the day before the next anniversary.
    .refine((b) => !b.period_start || !b.period_end || b.period_end <= oneYearAfter(b.period_start), {
      path: ["period_end"],
      message: "A performance period cannot be longer than 12 months",
    }),
});

/** The last day of a 12-month period that starts on `iso` (`2026-04-01` gives `2027-03-31`). */
function oneYearAfter(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  // Day 0 of the same month next year is the day before the anniversary.
  const last = new Date(Date.UTC(y + 1, m - 1, d - 1));
  return last.toISOString().slice(0, 10);
}

/**
 * Step 2: every stage has a start and end date, ends on or after it starts, and the stages follow the
 * business order without overlapping where they must not (see `validateTimeline`).
 */
export const timelineSchema = z
  .object({
    // Only the period is read, to check the stage dates against it.
    basic: z.object({ period_start: z.string().optional(), period_end: z.string().optional() }).optional(),
    stages: z.array(
    z
      .object({
        stage: z.string(),
        start_date: iso("Required"),
        end_date: iso("Required"),
        notify: z.boolean(),
      })
      .refine((s) => !s.start_date || !s.end_date || s.end_date >= s.start_date, {
        path: ["end_date"],
        message: "Ends before it starts",
      }),
  ),
  })
  .superRefine((value, ctx) => {
    for (const issue of validateTimeline(value.stages, value.basic?.period_start, value.basic?.period_end)) {
      ctx.addIssue({ code: "custom", path: ["stages", issue.index, issue.field], message: issue.message });
    }
  });

/** At least one employment type from the four the API knows. */
const employmentTypes = z
  .array(z.enum(["permanent", "contract", "probationary", "trainee"]))
  .min(1, "Select at least one employment type");

/** Whole months, 0 to 600. */
const serviceMonths = z
  .number({ error: "Enter the minimum service in months" })
  .int("Whole months only")
  .min(0, "Cannot be negative")
  .max(600, "Too large");

/** Step 3: plants, departments, and the goal-setting / appraisal rule halves. */
export const applicabilitySchema = z.object({
  applicability: z
    .object({
      plant_ids: z.array(z.string()).min(1, "Select at least one plant"),
      all_departments: z.boolean(),
      department_ids: z.array(z.string()),
      goal_setting: z.object({
        employment_types: employmentTypes,
        min_service_months: serviceMonths,
      }),
      appraisal: z.object({
        employment_types: employmentTypes,
        min_service_months: serviceMonths,
        service_as_on: iso("Select the service cut-off date"),
      }),
      exclude_notice_period: z.boolean(),
    })
    .refine((a) => a.all_departments || a.department_ids.length > 0, {
      path: ["department_ids"],
      message: "Select at least one department",
    }),
});

/** Step 4: a rating scale and the notification switches. */
export const finalizeSchema = z.object({
  finalize: z.object({
    rating_scale_id: z.string().min(1, "Select a rating scale"),
    notify_managers: z.boolean(),
    notify_employees: z.boolean(),
    notify_hod: z.boolean(),
    notify_hr: z.boolean(),
    notify_gp: z.boolean(),
    approval_workflow_id: z.string(),
  }),
});

/** Index = wizard step id (see WIZARD_STEPS). */
export const STEP_SCHEMAS = [
  basicSchema,
  timelineSchema,
  applicabilitySchema,
  finalizeSchema,
] as const;
