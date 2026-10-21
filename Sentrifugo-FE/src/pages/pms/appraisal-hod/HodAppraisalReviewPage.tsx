import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsAppraisalHodReviewQuery,
  useSavePmsAppraisalHodMutation,
  useSubmitPmsAppraisalHodMutation,
} from "@/store/api/pmsApi";
import type { PmsAppraisalHodReview, PmsAppraisalHodSave } from "@/types/pms-appraisal-hod";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RatingSelect } from "../shared/RatingSelect";
import { formatNumber, toFieldErrors, type FieldErrors } from "../shared/validation";
import { appraisalHodSchema, draftAppraisalHodSchema, type HodLine } from "./appraisal-hod.schema";

/** Class string of the section headings (KRAs, competencies). */
const SECTION_TITLE = "text-sm font-semibold text-foreground";

/** Screen 5.6 - L2 Rating: the Functional Head rates the KRAs and manager competencies a Section Head
 * already submitted, then submits the overall rating to Plant HR. */
const HodAppraisalReviewPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  /** Back to the approval queue. */
  const toList = () => navigate({ to: "/pms/approve-appraisal/$fy", params: { fy } });

  const financialYear = fyToApi(Number(fy));
  const { data, isLoading, isError, error } = useGetPmsAppraisalHodReviewQuery({ employeeUserId, financialYear });

  if (isLoading) return <PageLoader message="Loading the appraisal…" />;
  if (isError || !data) {
    const detail = (error as { data?: { detail?: string } } | undefined)?.data?.detail;
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Approve Appraisal" subtitle={detail ?? "Could not load this employee's appraisal."} />
        <Button variant="outline" onClick={toList}>Back to Approve Appraisal</Button>
      </div>
    );
  }

  return (
    <HodAppraisalForm
      key={employeeUserId}
      data={data}
      employeeUserId={employeeUserId}
      financialYear={financialYear}
      toList={toList}
    />
  );
};

const HodAppraisalForm = ({
  data,
  employeeUserId,
  financialYear,
  toList,
}: {
  data: PmsAppraisalHodReview;
  employeeUserId: string;
  financialYear: string;
  toList: () => void;
}) => {
  const [save, { isLoading: saving }] = useSavePmsAppraisalHodMutation();
  const [submit, { isLoading: submitting }] = useSubmitPmsAppraisalHodMutation();

  const [kras, setKras] = useState<HodLine[]>(() => data.kras.map((k) => ({ id: k.kpi_id, rating: k.hod_rating })));
  const [competencies, setCompetencies] = useState<HodLine[]>(() =>
    data.competencies.map((c) => ({ id: c.id, rating: c.hod_rating })),
  );
  const [hodRating, setHodRating] = useState<number | null>(data.hod_rating);
  const [remarks, setRemarks] = useState(data.hod_remarks);
  const [errors, setErrors] = useState<FieldErrors>({});

  // Average of the competency ratings given so far (display only, matching the manager screen's layout).
  const competencyAverage = useMemo(() => {
    const rated = competencies.filter((c) => c.rating !== null);
    if (rated.length === 0) return null;
    return rated.reduce((s, c) => s + (c.rating ?? 0), 0) / rated.length;
  }, [competencies]);

  // Once submitted to Plant HR the sheet is shown, not edited.
  const readOnly = data.status === "rated";

  const clear = (key: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const change = (list: "kras" | "competencies", index: number, rating: number) => {
    const setter = list === "kras" ? setKras : setCompetencies;
    setter((prev) => prev.map((l, i) => (i === index ? { ...l, rating } : l)));
    clear(`${list}.${index}.rating`);
  };

  const payload = (): PmsAppraisalHodSave => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    kras: kras.map((k) => ({ id: k.id, rating: k.rating })),
    competencies: competencies.map((c) => ({ id: c.id, rating: c.rating })),
    hod_rating: hodRating,
    remarks: remarks.trim(),
  });

  const onSaveDraft = async () => {
    const parsed = draftAppraisalHodSchema.safeParse({ remarks });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Shorten the highlighted text before saving");
      return;
    }
    try {
      await save(payload()).unwrap();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  const onSubmit = async () => {
    const parsed = appraisalHodSchema.safeParse({ kras, competencies, hod_rating: hodRating, remarks });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Rate every KRA and competency, and choose an overall rating, before submitting");
      return;
    }
    try {
      await submit(payload()).unwrap();
      toast.success("Rating submitted to Plant HR");
      toList();
    } catch (e) {
      toast.error(e, "Could not submit the rating");
    }
  };

  const ratingError = (list: "kras" | "competencies", index: number) => errors[`${list}.${index}.rating`];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`L2 Rating – ${data.employee_name}`}
        subtitle="Rate the KRAs and manager competencies; Plant HR rates the HR competencies later"
      />

      <PmsTableCard>
        <dl className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Info label="Employee" value={`${data.employee_name} (${data.emp_code})`} />
          <Info label="Role" value={data.designation_name} />
          <Info label="Section Head" value={data.section_head} />
          <Info
            label="L1 recommended rating"
            value={data.l1_recommended_rating == null ? null : String(data.l1_recommended_rating)}
          />
        </dl>
        {data.l1_comments && (
          <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Section Head's comments:</span> {data.l1_comments}
          </p>
        )}

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA / KPI</PmsTh>
              <PmsTh>Target</PmsTh>
              <PmsTh>Units</PmsTh>
              <PmsTh>Actual</PmsTh>
              <PmsTh>Self</PmsTh>
              <PmsTh>Manager rating</PmsTh>
              <PmsTh>Your rating</PmsTh>
              <PmsTh>Attachment</PmsTh>
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
                <td className="px-4 py-3 text-foreground">{k.manager_rating ?? "—"}</td>
                <td className="px-4 py-3">
                  <RatingSelect
                    label={`${k.kra_name} your rating`}
                    value={kras[i]?.rating ?? null}
                    invalid={!!ratingError("kras", i)}
                    disabled={readOnly}
                    onChange={(v) => change("kras", i, v)}
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
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className={`${SECTION_TITLE} mt-6 mb-2`}>Manager Competencies – rated by the Section Head and you</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Self rating</PmsTh>
              <PmsTh>Manager rating</PmsTh>
              <PmsTh>Your rating</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.competencies.map((c, i) => (
              <tr key={c.id} className="border-t align-top">
                <td className="px-4 py-3 text-foreground">{c.name}</td>
                <td className="px-4 py-3 text-foreground">{c.self_rating ?? "—"}</td>
                <td className="px-4 py-3 text-foreground">{c.manager_rating ?? "—"}</td>
                <td className="px-4 py-3">
                  <RatingSelect
                    label={`${c.name} your rating`}
                    value={competencies[i]?.rating ?? null}
                    invalid={!!ratingError("competencies", i)}
                    disabled={readOnly}
                    onChange={(v) => change("competencies", i, v)}
                  />
                  {ratingError("competencies", i) && (
                    <p className="mt-1 text-xs text-destructive">{ratingError("competencies", i)}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className={`${SECTION_TITLE} mt-6 mb-2`}>HR Competencies – rated by Plant HR (view only)</h2>
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
                <td className="px-4 py-3 text-muted-foreground">Rated by Plant HR after the Plant Head</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 grid gap-4 md:grid-cols-[10rem_18rem_1fr]">
          <div className="space-y-1.5">
            <Label>Competency Rating (avg)</Label>
            <Input readOnly value={competencyAverage === null ? "—" : competencyAverage.toFixed(2)} />
          </div>
          <div className="space-y-1.5">
            <Label>
              Recommended Rating <span className="text-destructive">*</span>
            </Label>
            <RatingSelect
              withLabel
              label="Overall rating"
              value={hodRating}
              invalid={!!errors.hod_rating}
              disabled={readOnly}
              className="w-full"
              onChange={(v) => {
                setHodRating(v);
                clear("hod_rating");
              }}
            />
            {errors.hod_rating && <p className="text-xs text-destructive">{errors.hod_rating}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hod-remarks">Comments</Label>
            <Input
              id="hod-remarks"
              value={remarks}
              disabled={readOnly}
              aria-invalid={!!errors.remarks}
              className={errors.remarks ? "border-destructive" : ""}
              onChange={(e) => {
                setRemarks(e.target.value);
                clear("remarks");
              }}
            />
            {errors.remarks && <p className="text-xs text-destructive">{errors.remarks}</p>}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={toList}>Back</Button>
          {readOnly ? (
            <p className="text-sm text-muted-foreground">Submitted to Plant HR.</p>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onSaveDraft} disabled={saving || submitting}>
                {saving ? "Saving…" : "Save Draft"}
              </Button>
              <Button onClick={onSubmit} disabled={saving || submitting}>
                {submitting ? "Submitting…" : "Submit to Plant Head"}
              </Button>
            </div>
          )}
        </div>
      </PmsTableCard>
    </div>
  );
};

/** One label / value pair in the employee details strip. */
function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium text-foreground">{value || "—"}</dd>
    </div>
  );
}

export default HodAppraisalReviewPage;
