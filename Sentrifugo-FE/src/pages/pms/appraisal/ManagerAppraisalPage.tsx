import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Eye, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsManagerAppraisalQuery,
  useSavePmsManagerAppraisalMutation,
  useSubmitPmsManagerAppraisalMutation,
} from "@/store/api/pmsApi";
import type { PmsManagerAppraisal, PmsManagerAppraisalSave } from "@/types/pms-manager";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RatingSelect } from "../shared/RatingSelect";
import { formatNumber, toFieldErrors, type FieldErrors } from "../shared/validation";
import { draftAppraisalSchema, managerAppraisalSchema, type AppraisalLine } from "./appraisal.schema";

/** Class string of the section headings (KRAs, competencies). */
const SECTION_TITLE = "text-sm font-semibold text-foreground";

/** Screen 3.14 - Manager Rating: assess KRAs and competencies, recommend a rating and submit to the HOD. */
const ManagerAppraisalPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  /** Back to the team appraisal list. */
  const toList = () => navigate({ to: "/pms/team-appraisal/$fy", params: { fy } });

  const financialYear = fyToApi(Number(fy));
  // The appraisal sheet: KRAs and competencies with self ratings, plus any manager rating saved so far.
  const { data, isLoading, isError, error } = useGetPmsManagerAppraisalQuery({ employeeUserId, financialYear });

  if (isLoading) return <PageLoader message="Loading the appraisal…" />;
  if (isError || !data) {
    const detail = (error as { data?: { detail?: string } } | undefined)?.data?.detail;
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Manager Appraisal" subtitle={detail ?? "Could not load this employee's appraisal."} />
        <Button variant="outline" onClick={toList}>Back to Team Appraisal</Button>
      </div>
    );
  }

  return (
    <ManagerAppraisalForm
      key={employeeUserId}
      data={data}
      employeeUserId={employeeUserId}
      financialYear={financialYear}
      toList={toList}
    />
  );
};

/**
 * The editable part of screen 3.14: rate each KRA and manager competency, recommend an overall rating,
 * then save a draft or submit to the HOD. HR competencies are shown for context only.
 */
const ManagerAppraisalForm = ({
  data,
  employeeUserId,
  financialYear,
  toList,
}: {
  data: PmsManagerAppraisal;
  employeeUserId: string;
  financialYear: string;
  toList: () => void;
}) => {
  // Save-draft and submit mutations.
  const [save, { isLoading: saving }] = useSavePmsManagerAppraisalMutation();
  const [submit, { isLoading: submitting }] = useSubmitPmsManagerAppraisalMutation();

  // KRA and competency rows with the manager rating and comment typed so far.
  const [kras, setKras] = useState<AppraisalLine[]>(() =>
    data.kras.map((k) => ({ id: k.kpi_id, self_rating: k.self_rating, rating: k.manager_rating, comment: k.comment })),
  );
  const [competencies, setCompetencies] = useState<AppraisalLine[]>(() =>
    data.competencies.map((c) => ({ id: c.id, self_rating: c.self_rating, rating: c.manager_rating, comment: c.comment })),
  );
  // Recommended overall rating, general comments and validation messages.
  const [recommended, setRecommended] = useState<number | null>(data.recommended_rating);
  const [comments, setComments] = useState(data.comments);
  const [errors, setErrors] = useState<FieldErrors>({});

  // Average of the manager competency ratings given so far (display only).
  const competencyAverage = useMemo(() => {
    const rated = competencies.filter((c) => c.rating !== null);
    if (rated.length === 0) return null;
    return rated.reduce((s, c) => s + (c.rating ?? 0), 0) / rated.length;
  }, [competencies]);

  // Once submitted to the HOD the sheet is shown, not edited.
  const readOnly = data.status === "submitted_to_hod";

  /** Removes one validation message. */
  const clear = (key: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /** Updates a rating or comment on a KRA / competency row; clears that row errors. */
  const change = (
    list: "kras" | "competencies",
    index: number,
    field: "rating" | "comment",
    value: number | string,
  ) => {
    const set = list === "kras" ? setKras : setCompetencies;
    set((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    clear(`${list}.${index}.${field === "rating" ? "rating" : "comment"}`);
    if (field === "rating") clear(`${list}.${index}.comment`);
  };

  /** Builds the API body from the typed rows. */
  const payload = (): PmsManagerAppraisalSave => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    kras: kras.map((k) => ({ kpi_id: k.id, rating: k.rating, comment: k.comment.trim() })),
    competencies: competencies.map((c) => ({ id: c.id, rating: c.rating, comment: c.comment.trim() })),
    recommended_rating: recommended,
    comments: comments.trim(),
  });

  /** Saves a draft (only text lengths are checked, ratings may be empty). */
  const onSaveDraft = async () => {
    const parsed = draftAppraisalSchema.safeParse({ kras, competencies, comments });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Shorten the highlighted comments before saving");
      return;
    }
    try {
      await save(payload()).unwrap();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  /** Validates every rating, the recommended rating and the comments for wide gaps, then submits to the HOD. */
  const onSubmit = async () => {
    const parsed = managerAppraisalSchema.safeParse({ kras, competencies, recommended_rating: recommended, comments });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Rate every KRA and competency, and choose a recommended rating");
      return;
    }
    try {
      await submit(payload()).unwrap();
      toast.success("Appraisal submitted to the HOD");
      toList();
    } catch (e) {
      toast.error(e, "Could not submit the appraisal");
    }
  };

  /** A comment text box with its error message, for one KRA or competency row. */
  const commentInput = (list: "kras" | "competencies", index: number, value: string, label: string) => {
    const err = errors[`${list}.${index}.comment`];
    return (
      <div>
        <Input
          value={value}
          disabled={readOnly}
          aria-label={label}
          aria-invalid={!!err}
          className={err ? "border-destructive" : ""}
          onChange={(e) => change(list, index, "comment", e.target.value)}
        />
        {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
      </div>
    );
  };

  /** Validation message for the rating of one row. */
  const ratingError = (list: "kras" | "competencies", index: number) => errors[`${list}.${index}.rating`];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`Manager Appraisal – ${data.employee_name}`}
        subtitle={
          data.period_label
            ? `Assess KRAs and competencies for ${data.period_label}, then recommend a rating`
            : "Assess KRAs and competencies, then recommend a rating"
        }
      />

      <PmsTableCard>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA</PmsTh>
              <PmsTh>Target</PmsTh>
              <PmsTh>Units</PmsTh>
              <PmsTh>Actual</PmsTh>
              <PmsTh>Self</PmsTh>
              <PmsTh>Manager rating</PmsTh>
              <PmsTh>Attachment</PmsTh>
              <PmsTh>Comment</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.kras.map((k, i) => (
              <tr key={k.kpi_id} className="border-t align-top">
                <td className="px-4 py-3 font-medium text-foreground">{k.kra_name}</td>
                <td className="px-4 py-3 text-foreground">{formatNumber(k.target)}</td>
                <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                <td className="px-4 py-3 text-foreground">{formatNumber(k.actual)}</td>
                <td className="px-4 py-3 text-foreground">{k.self_rating ?? "—"}</td>
                <td className="px-4 py-3">
                  <RatingSelect
                    label={`${k.kra_name} manager rating`}
                    value={kras[i]?.rating ?? null}
                    invalid={!!ratingError("kras", i)}
                    disabled={readOnly}
                    onChange={(v) => change("kras", i, "rating", v)}
                  />
                  {ratingError("kras", i) && <p className="mt-1 text-xs text-destructive">{ratingError("kras", i)}</p>}
                </td>
                <td className="px-4 py-3">
                  {k.attachment_name ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline"
                      onClick={() => toast.info("Attachment preview opens here once file storage is connected")}
                    >
                      <Eye className="h-4 w-4" /> {k.attachment_name}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">No file</span>
                  )}
                </td>
                <td className="px-4 py-3">{commentInput("kras", i, kras[i]?.comment ?? "", `${k.kra_name} comment`)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className={`${SECTION_TITLE} mt-6 mb-2`}>Manager Competencies – rated by you and the HOD</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Self rating</PmsTh>
              <PmsTh>Manager rating</PmsTh>
              <PmsTh>Comment</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.competencies.map((c, i) => (
              <tr key={c.id} className="border-t align-top">
                <td className="px-4 py-3 text-foreground">{c.name}</td>
                <td className="px-4 py-3 text-foreground">{c.self_rating ?? "—"}</td>
                <td className="px-4 py-3">
                  <RatingSelect
                    label={`${c.name} manager rating`}
                    value={competencies[i]?.rating ?? null}
                    invalid={!!ratingError("competencies", i)}
                    disabled={readOnly}
                    onChange={(v) => change("competencies", i, "rating", v)}
                  />
                  {ratingError("competencies", i) && (
                    <p className="mt-1 text-xs text-destructive">{ratingError("competencies", i)}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  {commentInput("competencies", i, competencies[i]?.comment ?? "", `${c.name} comment`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className={`${SECTION_TITLE} mt-6 mb-2`}>HR Competencies – rated later by Plant HR (view only)</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Self rating</PmsTh>
              <PmsTh>HR rating</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.hr_competencies.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-4 py-3 text-foreground">{c.name}</td>
                <td className="px-4 py-3 text-foreground">{c.self_rating ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">After HOD rating</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 grid gap-4 md:grid-cols-[10rem_18rem_1fr]">
          <div className="space-y-1.5">
            <Label>Competency rating (avg)</Label>
            <Input readOnly value={competencyAverage === null ? "—" : competencyAverage.toFixed(1)} />
          </div>
          <div className="space-y-1.5">
            <Label>
              Recommended rating <span className="text-destructive">*</span>
            </Label>
            <RatingSelect
              withLabel
              label="Recommended rating"
              value={recommended}
              invalid={!!errors.recommended_rating}
              disabled={readOnly}
              className="w-full"
              onChange={(v) => {
                setRecommended(v);
                clear("recommended_rating");
              }}
            />
            {errors.recommended_rating && <p className="text-xs text-destructive">{errors.recommended_rating}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="appraisal-comments">Comments</Label>
            <Input
              id="appraisal-comments"
              value={comments}
              disabled={readOnly}
              aria-invalid={!!errors.comments}
              className={errors.comments ? "border-destructive" : ""}
              onChange={(e) => {
                setComments(e.target.value);
                clear("comments");
              }}
            />
            {errors.comments && <p className="text-xs text-destructive">{errors.comments}</p>}
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          After you submit, the appraisal goes to the HOD. The employee sees the ratings only after Corporate HR publishes
          them.
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={toList}>Back</Button>
          {readOnly ? (
            <p className="text-sm text-muted-foreground">This appraisal is with the HOD.</p>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onSaveDraft} disabled={saving || submitting}>
                {saving ? "Saving…" : "Save Draft"}
              </Button>
              <Button onClick={onSubmit} disabled={saving || submitting}>
                {submitting ? "Submitting…" : "Submit to HOD"}
              </Button>
            </div>
          )}
        </div>
      </PmsTableCard>
    </div>
  );
};

export default ManagerAppraisalPage;
