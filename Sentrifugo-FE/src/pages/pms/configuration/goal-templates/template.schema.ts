import { z } from "zod";
import { sumWeights, WEIGHT_EPSILON } from "./template.utils";

const weightField = z
  .number({ error: "Enter a number" })
  .min(0, "Cannot be negative")
  .max(100, "Max 100");

export const templateBasicSchema = z.object({
  basic: z.object({
    financial_year: z.number({ error: "Select a financial year" }),
    name: z.string().trim().min(1, "Template name is required").max(100, "Keep it under 100 characters"),
    description: z.string().max(500, "Keep it under 500 characters"),
    department_id: z.string().min(1, "Select a department"),
    designation_id: z.string().min(1, "Select a role / designation"),
    effective_from: z.string().min(1, "Select the effective date"),
    status: z.enum(["active", "inactive"]),
  }),
});

export const templateKraKpiSchema = z.object({
  kras: z
    .array(
      z.object({
        kra_id: z.string(),
        name: z.string(),
        selected: z.boolean(),
        kpis: z.array(
          z.object({
            kpi_id: z.string(),
            name: z.string(),
            unit: z.string(),
            selected: z.boolean(),
            weight: weightField,
            target_type: z.enum(["individual", "common"]),
            expected_outcome: z.string().max(200, "Max 200 characters"),
            evidence_required: z.string().max(200, "Max 200 characters"),
          }),
        ),
      }),
    )
    .superRefine((kras, ctx) => {
      const selected = kras.filter((k) => k.selected);
      if (selected.length === 0) {
        ctx.addIssue({ code: "custom", path: [], message: "Select at least one KRA" });
        return;
      }
      kras.forEach((kra, i) => {
        if (!kra.selected) return;
        const picked = kra.kpis.filter((p) => p.selected);
        if (picked.length === 0) {
          ctx.addIssue({ code: "custom", path: [i, "kpis"], message: "Select at least one KPI for this KRA" });
        }
        kra.kpis.forEach((kpi, j) => {
          if (kpi.selected && !(kpi.weight > 0)) {
            ctx.addIssue({ code: "custom", path: [i, "kpis", j, "weight"], message: "Enter a weight" });
          }
        });
      });
      const total = sumWeights(selected.flatMap((k) => k.kpis));
      if (Math.abs(total - 100) > WEIGHT_EPSILON) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: `KPI weightage must total 100% (currently ${+total.toFixed(2)}%)`,
        });
      }
    }),
});

export const templateCompetencySchema = z.object({
  competencies: z
    .array(
      z.object({
        competency_id: z.string(),
        name: z.string(),
        category: z.string(),
        selected: z.boolean(),
        weight: weightField,
      }),
    )
    .superRefine((rows, ctx) => {
      const selected = rows.filter((r) => r.selected);
      if (selected.length === 0) {
        ctx.addIssue({ code: "custom", path: [], message: "Select at least one competency" });
        return;
      }
      rows.forEach((row, i) => {
        if (row.selected && !(row.weight > 0)) {
          ctx.addIssue({ code: "custom", path: [i, "weight"], message: "Enter a weight" });
        }
      });
      const total = sumWeights(selected);
      if (Math.abs(total - 100) > WEIGHT_EPSILON) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: `Competency weightage must total 100% (currently ${+total.toFixed(2)}%)`,
        });
      }
    }),
});

/** Index = wizard step id. */
export const TEMPLATE_STEP_SCHEMAS = [
  templateBasicSchema,
  templateKraKpiSchema,
  templateCompetencySchema,
] as const;
