import { z } from "zod";

/** Screen 3.7 - one row of the revision form, as typed (text until it is parsed). */
export const reviseRowSchema = z
  .object({
    kpi_id: z.string(),
    current: z.number(),
    revised: z
      .string()
      .trim()
      .min(1, "Required")
      .refine((v) => Number.isFinite(Number(v)), "Numbers only")
      .refine((v) => Number(v) >= 0, "Cannot be negative"),
    remarks: z.string().max(200, "Keep remarks under 200 characters"),
  })
  .superRefine((row, ctx) => {
    const changed = Number.isFinite(Number(row.revised)) && Number(row.revised) !== row.current;
    if (changed && row.remarks.trim().length < 3) {
      ctx.addIssue({ code: "custom", path: ["remarks"], message: "Explain the change" });
    }
  });

/** Whole form: every row must pass the row rules. */
export const reviseSchema = z.object({
  rows: z.array(reviseRowSchema),
});

/** One typed row of the revision form. */
export type ReviseFormRow = z.input<typeof reviseRowSchema>;
