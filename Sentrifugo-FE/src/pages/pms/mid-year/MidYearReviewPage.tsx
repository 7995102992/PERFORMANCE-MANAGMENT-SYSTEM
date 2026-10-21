import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsMidYearReviewQuery, useSubmitPmsMidYearReviewMutation } from "@/store/api/pmsApi";
import type { PmsMidYearReview } from "@/types/pms-manager";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RagDot } from "../shared/RagDot";
import { formatDisplayDate } from "../shared/pms.utils";
import { formatNumber, toFieldErrors, type FieldErrors } from "../shared/validation";
import { midYearReviewSchema } from "./midYear.schema";

/** The "target revision required?" radio: yes, no, or not chosen yet. */
type Choice = "yes" | "no" | "";

/** Screen 3.11 - Mid-Year Review: review H1 progress and decide whether targets need revising. */
const MidYearReviewPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  /** Back to the mid-year team list. */
  const toList = () => navigate({ to: "/pms/mid-year-review/$fy", params: { fy } });

  // The review sheet for this employee: KRAs with H1 actuals and RAG, notes and the decision so far.
  const { data, isLoading, isError } = useGetPmsMidYearReviewQuery({
    employeeUserId,
    financialYear: fyToApi(Number(fy)),
  });

  if (isLoading) return <PageLoader message="Loading the mid-year review…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Mid-Year Review" subtitle="Could not load this employee's mid-year review." />
        <Button variant="outline" onClick={toList}>Back to My Team</Button>
      </div>
    );
  }

  return <MidYearReviewForm key={employeeUserId} data={data} fy={fy} employeeUserId={employeeUserId} toList={toList} />;
};

/**
 * The editable part of screen 3.11: discussion notes and the revision decision.
 * "No" completes the review; "Yes" saves it and opens the target revision request (3.12).
 */
const MidYearReviewForm = ({
  data,
  fy,
  employeeUserId,
  toList,
}: {
  data: PmsMidYearReview;
  fy: string;
  employeeUserId: string;
  toList: () => void;
}) => {
  const navigate = useNavigate();
  // Submit mutation for the review.
  const [submit, { isLoading: submitting }] = useSubmitPmsMidYearReviewMutation();

  // Notes typed by the manager, the yes/no choice (empty until chosen) and validation messages.
  const [notes, setNotes] = useState(data.discussion_notes);
  const [choice, setChoice] = useState<Choice>(
    data.revision_required === null ? "" : data.revision_required ? "yes" : "no",
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  // Once the review is closed it is shown, not edited.
  const readOnly = data.status !== "not_started";

  /** Validates the decision, saves the review, then either finishes (no revision) or goes to the revision request (3.12). */
  const onContinue = async () => {
    const parsed = midYearReviewSchema.safeParse({ discussion_notes: notes, revision_required: choice || undefined });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    const revise = parsed.data.revision_required === "yes";
    try {
      await submit({
        employee_user_id: employeeUserId,
        financial_year: fyToApi(Number(fy)),
        discussion_notes: notes.trim(),
        revision_required: revise,
      }).unwrap();
      if (revise) {
        navigate({
          to: "/pms/mid-year-review/$fy/employee/$employeeUserId/revision",
          params: { fy, employeeUserId },
        });
      } else {
        toast.success("Mid-year review completed with no target revision");
        toList();
      }
    } catch (e) {
      toast.error(e, "Could not save the mid-year review");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`Mid-Year Review – ${data.employee_name}`}
        subtitle="Review H1 progress and decide on target revision"
      />

      <PmsTableCard>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA</PmsTh>
              <PmsTh>Target</PmsTh>
              <PmsTh>Units</PmsTh>
              <PmsTh>Latest actual</PmsTh>
              <PmsTh>Achieved</PmsTh>
              <PmsTh>RAG</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.kras.map((k) => (
              <tr key={k.kpi_id} className="border-t">
                <td className="px-4 py-3 font-medium text-foreground">{k.kra_name}</td>
                <td className="px-4 py-3 text-foreground">{formatNumber(k.target)}</td>
                <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                <td className="px-4 py-3 text-foreground">{formatNumber(k.h1_actual)}</td>
                <td className="px-4 py-3 text-foreground">
                  {k.achievement == null ? "—" : `${k.achievement.toFixed(1)}%`}
                </td>
                <td className="px-4 py-3">
                  {k.rag ? <RagDot rag={k.rag} /> : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border px-4 py-3 text-sm">
          <span>
            <span className="text-muted-foreground">Overall achievement </span>
            <strong className="text-foreground">
              {data.overall_achievement == null ? "—" : `${data.overall_achievement.toFixed(1)}%`}
            </strong>
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-muted-foreground">Overall RAG</span>
            {data.overall_rag ? <RagDot rag={data.overall_rag} showLabel /> : <span>—</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            Calculated from the actuals the employee reported in Update Progress
            {data.progress_updated_on ? ` (last submitted ${formatDisplayDate(data.progress_updated_on)})` : ""}.
          </span>
        </div>

        {data.employee_comment && (
          <p className="mt-3 rounded-lg bg-muted/40 px-4 py-3 text-sm">
            <span className="font-medium text-foreground">Employee comment: </span>
            <span className="text-muted-foreground">{data.employee_comment}</span>
          </p>
        )}

        <div className="mt-5 space-y-1.5">
          <Label htmlFor="discussion-notes">Discussion notes</Label>
          <Textarea
            id="discussion-notes"
            rows={3}
            value={notes}
            disabled={readOnly}
            aria-invalid={!!errors.discussion_notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setErrors((p) => ({ ...p, discussion_notes: "" }));
            }}
          />
          <div className="flex justify-between text-xs">
            <span className="text-destructive">{errors.discussion_notes}</span>
            <span className="text-muted-foreground">{notes.length}/1000</span>
          </div>
        </div>

        <fieldset className="mt-3 space-y-2" disabled={readOnly}>
          <legend className="text-sm font-medium text-foreground">
            Is target revision required? <span className="text-destructive">*</span>
          </legend>
          <RadioGroup
            value={choice}
            className="flex w-auto gap-6"
            onValueChange={(v) => {
              setChoice(v as Choice);
              setErrors((p) => ({ ...p, revision_required: "" }));
            }}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="revision-yes" value="yes" aria-invalid={!!errors.revision_required} />
              <Label htmlFor="revision-yes">Yes</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="revision-no" value="no" aria-invalid={!!errors.revision_required} />
              <Label htmlFor="revision-no">No</Label>
            </div>
          </RadioGroup>
          {errors.revision_required && <p className="text-xs text-destructive">{errors.revision_required}</p>}
        </fieldset>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={toList}>Back</Button>
          {readOnly ? (
            data.status === "revision_requested" && (
              <p className="text-sm text-muted-foreground">A target revision is with the HOD for approval.</p>
            )
          ) : (
            <Button onClick={onContinue} disabled={submitting}>
              {submitting ? "Saving…" : "Continue"}
            </Button>
          )}
        </div>
      </PmsTableCard>
    </div>
  );
};

export default MidYearReviewPage;
