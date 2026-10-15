import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsMyProgressQuery, useSavePmsMyProgressMutation } from "@/store/api/pmsApi";
import type { PmsMyProgress, PmsMyProgressKra, PmsMyProgressSave } from "@/types/pms-employee";
import type { PmsRag } from "@/types/pms-manager";
import { EvidenceUpload } from "../shared/EvidenceUpload";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatNumber, parseDecimal } from "../shared/validation";

/** Display name of each progress status. */
const STATUS_LABEL: Record<PmsRag, string> = {
  on_track: "On Track",
  at_risk: "At Risk",
  off_track: "Off Track",
};

/** Screen 4.4 - My Goals, Update Progress: actuals, status and evidence for the period. */
const MyProgressPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  // The employee progress sheet for the year: KRAs with target, actual, status and evidence.
  const { data, isLoading, isError } = useGetPmsMyProgressQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading your progress…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="My Goals – Update Progress" subtitle="Could not load your progress." />
      </div>
    );
  }
  return (
    <ProgressForm
      key={`${financialYear}-${data.state}`}
      data={data}
      financialYear={financialYear}
      onYearChange={(next) => navigate({ to: "/pms/my-progress/$fy", params: { fy: next } })}
      fy={fy}
    />
  );
};

/** One KRA row as typed (actual is text until it is parsed). */
interface Row {
  kra: PmsMyProgressKra;
  actual: string;
  status: PmsRag | null;
  evidence: string | null;
}

/**
 * The editable part of screen 4.4: actuals, status and evidence per KRA, comments, then save a draft
 * or submit to the manager (which freezes the period).
 */
const ProgressForm = ({
  data,
  financialYear,
  fy,
  onYearChange,
}: {
  data: PmsMyProgress;
  financialYear: string;
  fy: string;
  onYearChange: (fy: string) => void;
}) => {
  // Save / submit mutation.
  const [save, { isLoading: saving }] = useSavePmsMyProgressMutation();
  // One row per KRA as typed.
  const [rows, setRows] = useState<Row[]>(() =>
    data.kras.map((k) => ({
      kra: k,
      actual: k.actual === null ? "" : String(k.actual),
      status: k.status,
      evidence: k.evidence_name,
    })),
  );
  // Comments, per-row validation messages, and whether the period is frozen (view only).
  const [comment, setComment] = useState(data.comment);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const frozen = data.state === "frozen";
  // The Revised target column appears once any KPI has a final revised target; Target always stays the original.
  const hasRevised = rows.some((r) => r.kra.revised_target != null);

  /** Updates one row and clears that row error. */
  const patch = (index: number, change: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...change } : r)));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  /** Validates (numeric actuals; actual and status required when submitting), then saves a draft or submits. */
  const run = async (submit: boolean) => {
    const bad: Record<number, string> = {};
    rows.forEach((r, i) => {
      const n = parseDecimal(r.actual);
      if (n !== null && !Number.isFinite(n)) bad[i] = "Enter a number";
      else if (n !== null && n < 0) bad[i] = "Cannot be negative";
      else if (submit && n === null) bad[i] = "Enter the actual";
      else if (submit && r.status === null) bad[i] = "Choose a status";
    });
    if (comment.length > 500) {
      toast.error("Keep comments under 500 characters");
      return;
    }
    if (Object.keys(bad).length > 0) {
      setErrors(bad);
      toast.error(submit ? "Enter the actual and status for every KRA" : "Fix the highlighted actuals");
      return;
    }
    const body: PmsMyProgressSave = {
      financial_year: financialYear,
      period: "current",
      comment: comment.trim(),
      submit,
      // A draft may leave an actual empty; those rows are simply not sent.
      entries: rows.flatMap((r) => {
        const actual = parseDecimal(r.actual);
        return actual === null
          ? []
          : [{ kpi_id: r.kra.kpi_id, actual, status: r.status, attachment_name: r.evidence }];
      }),
    };
    try {
      await save(body).unwrap();
      toast.success(submit ? "Progress submitted to your manager" : "Draft saved");
    } catch (e) {
      toast.error(e, submit ? "Could not submit the progress" : "Could not save the draft");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="My Goals – Update Progress"
        subtitle="Enter actuals, status and evidence for this month"
        action={
          <div className="flex items-center gap-3">
            {frozen && (
              <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600">
                <CheckCircle2 className="h-4 w-4" /> Frozen
              </span>
            )}
            <FinancialYearTag fy={fy} onChange={onYearChange} />
          </div>
        }
      />

      <PmsTableCard>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA</PmsTh>
              <PmsTh>Target</PmsTh>
              {hasRevised && <PmsTh>Revised target</PmsTh>}
              <PmsTh>Actual (YTD)</PmsTh>
              <PmsTh>Status</PmsTh>
              <PmsTh>Evidence</PmsTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.kra.kpi_id} className="border-t align-top">
                <td className="px-4 py-3 font-medium text-foreground">{r.kra.kpi_name}</td>
                <td className="px-4 py-3 text-foreground">
                  {formatNumber(r.kra.target)}
                  <span className="ml-1 text-xs text-muted-foreground">{r.kra.unit}</span>
                </td>
                {hasRevised && (
                  <td className="px-4 py-3">
                    {r.kra.revised_target != null ? (
                      <span className="font-semibold text-primary">{formatNumber(r.kra.revised_target)}</span>
                    ) : (
                      <span className="text-muted-foreground">No change</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-3">
                  <Input
                    inputMode="decimal"
                    className={`w-28 ${errors[i] ? "border-destructive" : ""}`}
                    disabled={frozen}
                    aria-label={`${r.kra.kpi_name} actual`}
                    aria-invalid={!!errors[i]}
                    value={r.actual}
                    onChange={(e) => patch(i, { actual: e.target.value })}
                  />
                  {errors[i] && <p className="mt-1 text-xs text-destructive">{errors[i]}</p>}
                </td>
                <td className="px-4 py-3">
                  <Select
                    value={r.status ?? ""}
                    disabled={frozen}
                    onValueChange={(v) => patch(i, { status: v as PmsRag })}
                  >
                    <SelectTrigger className="w-36" aria-label={`${r.kra.kpi_name} status`}>
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STATUS_LABEL) as PmsRag[]).map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-4 py-3">
                  <EvidenceUpload
                    value={r.evidence}
                    disabled={frozen}
                    label={`${r.kra.kpi_name} evidence`}
                    onChange={(name) => patch(i, { evidence: name })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 space-y-1.5">
          <Label htmlFor="progress-comments">Comments</Label>
          <textarea
            id="progress-comments"
            rows={2}
            disabled={frozen}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={() => run(false)} disabled={frozen || saving}>
            Save Draft
          </Button>
          <Button onClick={() => run(true)} disabled={frozen || saving}>
            {saving ? "Saving…" : "Submit to Manager"}
          </Button>
        </div>
      </PmsTableCard>
    </div>
  );
};

export default MyProgressPage;
