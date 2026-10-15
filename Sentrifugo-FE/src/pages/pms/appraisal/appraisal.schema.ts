import { z } from "zod";

/** A rating the manager has to give (1-5). `null` means "not rated yet". */
const requiredRating = z.number().nullable().refine((v) => v !== null, "Rate this");

/** Longest comment accepted on a row. */
const COMMENT_MAX = 300;

/** One KRA or competency row. A rating two or more points away from the self rating needs a comment. */
export const appraisalLineSchema = z
  .object({
    id: z.string(),
    self_rating: z.number().nullable(),
    rating: requiredRating,
    comment: z.string().max(COMMENT_MAX, `Keep comments under ${COMMENT_MAX} characters`),
  })
  .superRefine((line, ctx) => {
    if (
      line.rating !== null &&
      line.self_rating !== null &&
      Math.abs(line.rating - line.self_rating) >= 2 &&
      line.comment.trim().length < 5
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "Explain a rating 2 or more points from the self rating",
      });
    }
  });

/** Screen 3.14 - the submit-to-HOD form. Save Draft only checks lengths, not completeness. */
export const managerAppraisalSchema = z.object({
  kras: z.array(appraisalLineSchema),
  competencies: z.array(appraisalLineSchema),
  recommended_rating: z.number().nullable().refine((v) => v !== null, "Choose a recommended rating"),
  comments: z.string().max(500, "Keep comments under 500 characters"),
});

/** Save Draft: only text lengths are checked. */
export const draftAppraisalSchema = z.object({
  kras: z.array(z.object({ comment: z.string().max(COMMENT_MAX) })),
  competencies: z.array(z.object({ comment: z.string().max(COMMENT_MAX) })),
  comments: z.string().max(500),
});

/** One typed KRA or competency row. */
export type AppraisalLine = z.input<typeof appraisalLineSchema>;
