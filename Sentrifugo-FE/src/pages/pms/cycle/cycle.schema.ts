import { z } from "zod";

const iso = (message: string) => z.string().min(1, message);

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
    }),
});

export const timelineSchema = z.object({
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
});

export const applicabilitySchema = z.object({
  applicability: z
    .object({
      plant_ids: z.array(z.string()).min(1, "Select at least one plant"),
      all_departments: z.boolean(),
      department_ids: z.array(z.string()),
      employment_types: z
        .array(z.enum(["permanent", "contract", "trainee"]))
        .min(1, "Select at least one employment type"),
      min_service_months: z
        .number({ error: "Enter the minimum service in months" })
        .int("Whole months only")
        .min(0, "Cannot be negative")
        .max(600, "Too large"),
      service_as_on: iso("Select the service cut-off date"),
      exclude_probation: z.boolean(),
      exclude_notice_period: z.boolean(),
    })
    .refine((a) => a.all_departments || a.department_ids.length > 0, {
      path: ["department_ids"],
      message: "Select at least one department",
    }),
});

export const finalizeSchema = z.object({
  finalize: z.object({
    rating_scale_id: z.string().min(1, "Select a rating scale"),
    notify_managers: z.boolean(),
    notify_employees: z.boolean(),
    notify_hod: z.boolean(),
    notify_hr: z.boolean(),
  }),
});

/** Index = wizard step id (see WIZARD_STEPS). */
export const STEP_SCHEMAS = [
  basicSchema,
  timelineSchema,
  applicabilitySchema,
  finalizeSchema,
] as const;
