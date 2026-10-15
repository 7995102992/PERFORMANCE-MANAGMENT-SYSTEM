import { z } from "zod";

/** A required, numeric, non-negative text field. */
const numeric = z
  .string()
  .trim()
  .min(1, "Required")
  .refine((v) => Number.isFinite(Number(v)), "Numbers only")
  .refine((v) => Number(v) >= 0, "Cannot be negative");

/** Screen 3.11 - the review decision. Notes are required when a revision is requested. */
export const midYearReviewSchema = z
  .object({
    discussion_notes: z.string().max(1000, "Keep the notes under 1000 characters"),
    revision_required: z.enum(["yes", "no"], { message: "Choose whether a target revision is required" }),
  })
  .superRefine((form, ctx) => {
    if (form.revision_required === "yes" && form.discussion_notes.trim().length < 10) {
      ctx.addIssue({
        code: "custom",
        path: ["discussion_notes"],
        message: "Add at least 10 characters of notes to justify the revision",
      });
    }
  });

/** Largest attachment accepted on the revision request (5 MB). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** MIME types accepted as an attachment: PDF, Excel, PNG, JPEG. */
export const ATTACHMENT_TYPES = [
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
];

/** Screen 3.12 - one KRA row of the revision request, as typed. */
export const revisionRowSchema = z
  .object({
    kpi_id: z.string(),
    current: z.number(),
    revised: numeric,
    reason: z.string().max(200, "Keep the reason under 200 characters"),
  })
  .superRefine((row, ctx) => {
    const changed = Number.isFinite(Number(row.revised)) && Number(row.revised) !== row.current;
    if (changed && row.reason.trim().length < 5) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Give a reason (at least 5 characters)" });
    }
  });

/** Whole revision form: at least one target must actually change. */
export const revisionSchema = z
  .object({ rows: z.array(revisionRowSchema) })
  .superRefine((form, ctx) => {
    const changed = form.rows.some((r) => Number.isFinite(Number(r.revised)) && Number(r.revised) !== r.current);
    if (!changed) {
      ctx.addIssue({ code: "custom", path: ["rows"], message: "Revise at least one target before sending to the HOD" });
    }
  });

/** One typed row of the revision form. */
export type RevisionFormRow = z.input<typeof revisionRowSchema>;
