import { z } from "zod";

/** Longest comment or reason accepted. */
const COMMENT_MAX = 300;

/** One HR competency the submit form needs a rating for. `null` means "not rated yet". */
const hrLineSchema = z.object({
  id: z.string(),
  rating: z.number().nullable().refine((v) => v !== null, "Rate this"),
  comment: z.string().max(COMMENT_MAX, `Keep comments under ${COMMENT_MAX} characters`),
});

/** Screen 1.8 Submit: every HR competency rated. */
export const hrAppraisalSchema = z.object({
  competencies: z.array(hrLineSchema),
  remarks: z.string().max(500, "Keep remarks under 500 characters"),
});

/** Save Draft only checks lengths, not completeness. */
export const draftHrAppraisalSchema = z.object({
  competencies: z.array(z.object({ comment: z.string().max(COMMENT_MAX) })),
  remarks: z.string().max(500, "Keep remarks under 500 characters"),
});

/** Screen 1.9: a rating that moved from where it started needs a reason. */
export const calibrationEmployeeSchema = z
  .object({
    calibrated_rating: z.number().nullable().refine((v) => v !== null, "Choose a rating"),
    current_rating: z.number().nullable(),
    reason: z.string().max(COMMENT_MAX, `Keep reasons under ${COMMENT_MAX} characters`),
  })
  .superRefine((e, ctx) => {
    if (
      e.calibrated_rating !== null &&
      e.current_rating !== null &&
      e.calibrated_rating !== e.current_rating &&
      e.reason.trim().length < 5
    ) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Give a reason for changing the rating" });
    }
  });

/** Whole calibration form: every employee row must pass. */
export const calibrationSchema = z.object({
  employees: z.array(calibrationEmployeeSchema),
});

/** Save: only reason lengths are checked. */
export const draftCalibrationSchema = z.object({
  employees: z.array(z.object({ reason: z.string().max(COMMENT_MAX) })),
});

/** One typed HR competency row. */
export type HrLine = z.input<typeof hrLineSchema>;
