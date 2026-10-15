import { z } from "zod";

/** Reasons offered for a transferred employee. */
export const TRANSFER_REASONS = [
  "Department transfer",
  "Role change",
  "Manager change",
  "Plant transfer",
  "Other",
] as const;

/** A required, numeric, non-negative text field. */
const numeric = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => Number.isFinite(Number(v)), "Numbers only")
    .refine((v) => Number(v) >= 0, "Cannot be negative");

/** One KRA row (also the Add / Edit KRA dialog), as typed. */
export const transferKraSchema = z.object({
  id: z.string(),
  kra_name: z.string().trim().min(1, "KRA name is required").max(100, "Keep the name under 100 characters"),
  weight: numeric("Weight").refine((v) => Number(v) > 0 && Number(v) <= 100, "Between 1 and 100"),
  target: numeric("Target"),
  unit: z.string().trim().min(1, "Unit is required").max(20, "Keep the unit under 20 characters"),
});

/** Whole period 2 form: at least one KRA, a reason, remarks of 10+ characters, weights totalling 100. */
export const transferSchema = z
  .object({
    kras: z.array(transferKraSchema).min(1, "Add at least one Period 2 KRA"),
    reason: z.string().min(1, "Select a reason for the change"),
    remarks: z
      .string()
      .trim()
      .min(10, "Add at least 10 characters of remarks")
      .max(500, "Keep remarks under 500 characters"),
  })
  .superRefine((form, ctx) => {
    const total = form.kras.reduce((sum, k) => sum + (Number.isFinite(Number(k.weight)) ? Number(k.weight) : 0), 0);
    if (Math.abs(total - 100) > 0.01) {
      ctx.addIssue({
        code: "custom",
        path: ["kras"],
        message: `Period 2 weightage is ${Math.round(total * 100) / 100}% (must be 100%)`,
      });
    }
  });

/** One typed KRA row (also the dialog row). */
export type TransferKraRow = z.input<typeof transferKraSchema>;
