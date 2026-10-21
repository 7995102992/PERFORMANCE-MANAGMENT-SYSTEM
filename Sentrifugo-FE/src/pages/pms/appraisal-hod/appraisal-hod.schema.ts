import { z } from "zod";

/** Longest remark accepted. */
const REMARKS_MAX = 500;

/** One KRA/competency line the submit form needs a rating for. `null` means "not rated yet". */
const hodLineSchema = z.object({
  id: z.string(),
  rating: z.number().nullable().refine((v) => v !== null, "Rate this"),
});

/** Screen 5.6 "Submit to Plant Head": every KRA and manager competency rated, plus an overall rating. */
export const appraisalHodSchema = z.object({
  kras: z.array(hodLineSchema),
  competencies: z.array(hodLineSchema),
  hod_rating: z.number().nullable().refine((v) => v !== null, "Choose an overall rating"),
  remarks: z.string().max(REMARKS_MAX, `Keep remarks under ${REMARKS_MAX} characters`),
});

/** Save Draft only checks lengths, not completeness. */
export const draftAppraisalHodSchema = z.object({
  remarks: z.string().max(REMARKS_MAX, `Keep remarks under ${REMARKS_MAX} characters`),
});

/** One typed KRA/competency row. */
export type HodLine = z.input<typeof hodLineSchema>;
