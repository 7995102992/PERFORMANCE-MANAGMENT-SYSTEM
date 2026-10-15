import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, FilePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsMySelfAppraisalQuery, useSavePmsMySelfAppraisalMutation } from "@/store/api/pmsApi";
import type { PmsMySelfAppraisal, PmsMySelfAppraisalSave } from "@/types/pms-employee";
import { EvidenceUpload } from "../shared/EvidenceUpload";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RatingSelect } from "../shared/RatingSelect";
import { StatusLabel } from "../shared/StatusLabel";
import { formatNumber, parseDecimal } from "../shared/validation";

/** Longest evidence text or comment accepted. */
const COMMENT_MAX = 300;

/** Screen 4.6 - Self Appraisal: rate yourself against your targets and competencies. */
const SelfAppraisalPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  // The self appraisal sheet: KRAs and competencies with the ratings given so far.
  const { data, isLoading, isError } = useGetPmsMySelfAppraisalQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading your self appraisal…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title={`Self Appraisal – FY ${financialYear}`} subtitle="Could not load your self appraisal." />
        <Button variant="outline" onClick={() => navigate({ to: "/pms/my-goals/$fy", params: { fy } })}>
          Back to My Goals
        </Button>
      </div>
    );
  }
  return <SelfAppraisalForm key={`${financialYear}-${data.status}`} data={data} financialYear={financialYear} />;
};

/**
 * The editable part of screen 4.6: actual, self rating, achievement text and attachment per KRA, and
 * a self rating and comment per competency, then save a draft or submit.
 */
const SelfAppraisalForm = ({ data, financialYear }: { data: PmsMySelfAppraisal; financialYear: string }) => {
  // Save / submit mutation.
  const [save, { isLoading: saving }] = useSavePmsMySelfAppraisalMutation();
  // KRA rows (actual kept as text) and competency rows as typed.
  const [kras, setKras] = useState(() =>
    data.kras.map((k) => ({
      ...k,
      actualText: k.actual === null ? "" : String(k.actual),
    })),
  );
  const [competencies, setCompetencies] = useState(() => data.competencies.map((c) => ({ ...c })));
  // Validation messages keyed `kra.<i>`, `kra.<i>.actual`, `comp.<i>` ... and whether the sheet is submitted.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submitted = data.status === "submitted";
  // The Revised target column appears once any KRA has a final revised target; Target always stays the original.
  const hasRevised = kras.some((k) => k.revised_target != null);

  /** Removes one validation message. */
  const clear = (key: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /** Updates one KRA row and clears its error. */
  const patchKra = (i: number, change: Partial<(typeof kras)[number]>) => {
    setKras((prev) => prev.map((k, idx) => (idx === i ? { ...k, ...change } : k)));
    clear(`kra.${i}`);
  };
  /** Updates one competency row and clears its error. */
  const patchComp = (i: number, change: Partial<(typeof competencies)[number]>) => {
    setCompetencies((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...change } : c)));
    clear(`comp.${i}`);
  };

  /** Validates lengths (and, on submit, that everything is rated), then saves a draft or submits. */
  const run = async (submit: boolean) => {
    const bad: Record<string, string> = {};
    kras.forEach((k, i) => {
      const n = parseDecimal(k.actualText);
      if (n !== null && (!Number.isFinite(n) || n < 0)) bad[`kra.${i}.actual`] = "Enter a number";
      else if (submit && n === null) bad[`kra.${i}.actual`] = "Enter the actual";
      if (k.evidence.length > COMMENT_MAX) bad[`kra.${i}.evidence`] = `Keep under ${COMMENT_MAX} characters`;
      if (submit && k.self_rating === null) bad[`kra.${i}`] = "Rate this";
    });
    competencies.forEach((c, i) => {
      if (c.comment.length > COMMENT_MAX) bad[`comp.${i}.comment`] = `Keep under ${COMMENT_MAX} characters`;
      if (submit && c.self_rating === null) bad[`comp.${i}`] = "Rate this";
    });
    if (Object.keys(bad).length > 0) {
      setErrors(bad);
      toast.error(submit ? "Rate every KRA and competency before submitting" : "Fix the highlighted fields");
      return;
    }
    const body: PmsMySelfAppraisalSave = {
      financial_year: financialYear,
      submit,
      kras: kras.map((k) => ({
        kpi_id: k.kpi_id,
        actual: parseDecimal(k.actualText),
        rating: k.self_rating,
        evidence: k.evidence.trim(),
        attachment_name: k.attachment_name,
      })),
      competencies: competencies.map((c) => ({
        competency_id: c.id,
        rating: c.self_rating,
        comment: c.comment.trim(),
      })),
    };
    try {
      await save(body).unwrap();
      toast.success(submit ? "Self appraisal submitted" : "Draft saved");
    } catch (e) {
      toast.error(e, submit ? "Could not submit the self appraisal" : "Could not save the draft");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`Self Appraisal – FY ${financialYear}`}
        subtitle="Rate yourself against your targets and competencies"
        action={
          submitted ? (
            <StatusLabel icon={CheckCircle2} label="Submitted" className="text-emerald-600" />
          ) : (
            <StatusLabel icon={FilePen} label="Draft" className="text-amber-500" />
          )
        }
      />

      <PmsTableCard>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA</PmsTh>
              <PmsTh>Target</PmsTh>
              {hasRevised && <PmsTh>Revised target</PmsTh>}
              <PmsTh>Units</PmsTh>
              <PmsTh>Actual</PmsTh>
              <PmsTh>Self rating</PmsTh>
              <PmsTh>Achievement / Evidence</PmsTh>
              <PmsTh>Upload attachment</PmsTh>
            </tr>
          </thead>
          <tbody>
            {kras.map((k, i) => (
              <tr key={k.kpi_id} className="border-t align-top">
                <td className="px-4 py-3 font-medium text-foreground">{k.kpi_name}</td>
                <td className="px-4 py-3 text-foreground">{formatNumber(k.target)}</td>
                {hasRevised && (
                  <td className="px-4 py-3">
                    {k.revised_target != null ? (
                      <span className="font-semibold text-primary">{formatNumber(k.revised_target)}</span>
                    ) : (
                      <span className="text-muted-foreground">No change</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                <td className="px-4 py-3">
                  <Input
                    inputMode="decimal"
                    className={`w-24 ${errors[`kra.${i}.actual`] ? "border-destructive" : ""}`}
                    disabled={submitted}
                    aria-label={`${k.kpi_name} actual`}
                    value={k.actualText}
                    onChange={(e) => patchKra(i, { actualText: e.target.value })}
                  />
                  {errors[`kra.${i}.actual`] && (
                    <p className="mt-1 text-xs text-destructive">{errors[`kra.${i}.actual`]}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <RatingSelect
                    label={`${k.kpi_name} self rating`}
                    value={k.self_rating}
                    invalid={!!errors[`kra.${i}`]}
                    disabled={submitted}
                    onChange={(v) => patchKra(i, { self_rating: v })}
                  />
                  {errors[`kra.${i}`] && <p className="mt-1 text-xs text-destructive">{errors[`kra.${i}`]}</p>}
                </td>
                <td className="px-4 py-3">
                  <Input
                    value={k.evidence}
                    disabled={submitted}
                    aria-label={`${k.kpi_name} achievement`}
                    className={errors[`kra.${i}.evidence`] ? "border-destructive" : ""}
                    onChange={(e) => patchKra(i, { evidence: e.target.value })}
                  />
                  {errors[`kra.${i}.evidence`] && (
                    <p className="mt-1 text-xs text-destructive">{errors[`kra.${i}.evidence`]}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <EvidenceUpload
                    value={k.attachment_name}
                    disabled={submitted}
                    label={`${k.kpi_name} attachment`}
                    onChange={(name) => patchKra(i, { attachment_name: name })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-6 mb-2 text-sm font-semibold text-foreground">Competencies</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Competency type</PmsTh>
              <PmsTh>Self rating</PmsTh>
              <PmsTh>Comment</PmsTh>
            </tr>
          </thead>
          <tbody>
            {competencies.map((c, i) => (
              <tr key={c.id} className="border-t align-top">
                <td className="px-4 py-3 text-foreground">{c.name}</td>
                <td className="px-4 py-3">
                  {c.type === "hr" ? (
                    <span className="rounded-md bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-600">HR</span>
                  ) : (
                    <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Manager</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <RatingSelect
                    label={`${c.name} self rating`}
                    value={c.self_rating}
                    invalid={!!errors[`comp.${i}`]}
                    disabled={submitted}
                    onChange={(v) => patchComp(i, { self_rating: v })}
                  />
                  {errors[`comp.${i}`] && <p className="mt-1 text-xs text-destructive">{errors[`comp.${i}`]}</p>}
                </td>
                <td className="px-4 py-3">
                  <Input
                    value={c.comment}
                    disabled={submitted}
                    aria-label={`${c.name} comment`}
                    className={errors[`comp.${i}.comment`] ? "border-destructive" : ""}
                    onChange={(e) => patchComp(i, { comment: e.target.value })}
                  />
                  {errors[`comp.${i}.comment`] && (
                    <p className="mt-1 text-xs text-destructive">{errors[`comp.${i}.comment`]}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={() => run(false)} disabled={submitted || saving}>
            Save Draft
          </Button>
          {submitted ? (
            <p className="text-sm text-muted-foreground">Submitted to your manager.</p>
          ) : (
            <Button onClick={() => run(true)} disabled={saving}>
              {saving ? "Saving…" : "Submit Self Appraisal"}
            </Button>
          )}
        </div>
      </PmsTableCard>
    </div>
  );
};

export default SelfAppraisalPage;
