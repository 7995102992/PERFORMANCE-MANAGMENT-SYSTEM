import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Clock, FilePen, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsHrAppraisalQuery,
  useSavePmsHrAppraisalMutation,
  useSubmitPmsHrAppraisalMutation,
} from "@/store/api/pmsApi";
import type { PmsHrAppraisal, PmsHrAppraisalSave, PmsHrRatingStatus } from "@/types/pms-hr";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RatingSelect } from "../shared/RatingSelect";
import { StatusLabel } from "../shared/StatusLabel";
import { usePmsDepartments } from "../shared/usePmsLookups";
import { toFieldErrors, type FieldErrors } from "../shared/validation";
import { draftHrAppraisalSchema, hrAppraisalSchema, type HrLine } from "./hr.schema";

/** Class string of the section headings. */
const SECTION_TITLE = "text-sm font-semibold text-foreground";

/** Label, icon and colour for each HR rating status. */
const STATUS_META: Record<PmsHrRatingStatus, { label: string; icon: LucideIcon; className: string }> = {
  pending: { label: "Pending", icon: Clock, className: "text-amber-500" },
  draft: { label: "Draft", icon: FilePen, className: "text-amber-500" },
  rated: { label: "Rated", icon: CheckCircle2, className: "text-emerald-600" },
};

/** Screen 1.8 - HR Competency Rating for one employee. */
const HrCompetencyEmployeePage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  /** Back to the HR competency rating list. */
  const toList = () => navigate({ to: "/pms/hr-competency-rating/$fy", params: { fy } });

  const financialYear = fyToApi(Number(fy));
  // The employee sheet: HR competencies to rate and manager competencies for reference.
  const { data, isLoading, isError, error } = useGetPmsHrAppraisalQuery({ employeeUserId, financialYear });

  if (isLoading) return <PageLoader message="Loading the employee's ratings…" />;
  if (isError || !data) {
    const detail = (error as { data?: { detail?: string } } | undefined)?.data?.detail;
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="HR Competency Rating" subtitle={detail ?? "Could not load this employee's ratings."} />
        <Button variant="outline" onClick={toList}>Back to HR Competency Rating</Button>
      </div>
    );
  }

  return (
    <HrCompetencyForm
      key={employeeUserId}
      data={data}
      employeeUserId={employeeUserId}
      financialYear={financialYear}
      toList={toList}
    />
  );
};

/**
 * The editable part of screen 1.8: rate each HR competency, add comments and remarks, then save a draft
 * or submit. View-only once the employee is with calibration.
 */
const HrCompetencyForm = ({
  data,
  employeeUserId,
  financialYear,
  toList,
}: {
  data: PmsHrAppraisal;
  employeeUserId: string;
  financialYear: string;
  toList: () => void;
}) => {
  // Save-draft and submit mutations.
  const [save, { isLoading: saving }] = useSavePmsHrAppraisalMutation();
  const [submit, { isLoading: submitting }] = useSubmitPmsHrAppraisalMutation();
  const { data: departments } = usePmsDepartments();

  // HR rating and comment typed per HR competency, the HR remarks, and validation messages.
  const [lines, setLines] = useState<HrLine[]>(() =>
    data.hr_competencies.map((c) => ({ id: c.id, rating: c.hr_rating, comment: c.comment })),
  );
  const [remarks, setRemarks] = useState(data.remarks);
  const [errors, setErrors] = useState<FieldErrors>({});

  // Locked once the employee has been sent to calibration. `meta` is the status label shown at the top.
  const readOnly = data.locked;
  const meta = STATUS_META[data.status];
  const departmentName = departments.find((d) => d.id === data.department_id)?.name ?? data.department_name;

  /** Removes one validation message. */
  const clear = (key: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /** Updates a rating or comment on one competency row. */
  const change = (index: number, field: "rating" | "comment", value: number | string) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
    clear(`competencies.${index}.${field}`);
  };

  /** Builds the API body from the typed rows. */
  const payload = (): PmsHrAppraisalSave => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    competencies: lines.map((l) => ({ id: l.id, rating: l.rating, comment: l.comment.trim() })),
    remarks: remarks.trim(),
  });

  /** Saves a draft (ratings may be empty). */
  const onSaveDraft = async () => {
    const parsed = draftHrAppraisalSchema.safeParse({ competencies: lines, remarks });
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

  /** Requires every HR competency to be rated, then submits the HR ratings and returns to the list. */
  const onSubmit = async () => {
    const parsed = hrAppraisalSchema.safeParse({ competencies: lines, remarks });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Rate every HR competency before submitting");
      return;
    }
    try {
      await submit(payload()).unwrap();
      toast.success("HR ratings submitted");
      toList();
    } catch (e) {
      toast.error(e, "Could not submit the HR ratings");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`HR Competency Rating – ${data.employee_name}`}
        subtitle="Rate the HR competencies for one employee"
        action={<StatusLabel icon={meta.icon} label={meta.label} className={meta.className} />}
      />

      <PmsTableCard>
        <dl className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Info label="Employee" value={`${data.employee_name} (${data.emp_code})`} />
          <Info label="Role" value={data.role} />
          <Info label="Department" value={departmentName ?? null} />
          <Info label="Reporting Manager" value={data.reporting_manager} />
        </dl>

        <h2 className={`${SECTION_TITLE} mt-6 mb-2`}>HR Competencies – rate now</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Competency type</PmsTh>
              <PmsTh>Employee self rating</PmsTh>
              <PmsTh>HR rating</PmsTh>
              <PmsTh>Comment</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.hr_competencies.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-muted-foreground">
                  This employee's goal template has no HR competencies.
                </td>
              </tr>
            )}
            {data.hr_competencies.map((c, i) => {
              const ratingError = errors[`competencies.${i}.rating`];
              const commentError = errors[`competencies.${i}.comment`];
              return (
                <tr key={c.id} className="border-t align-top">
                  <td className="px-4 py-3 font-medium text-foreground">{c.name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-600">
                      HR
                    </span>
                  </td>
                  <td className="px-4 py-3 text-foreground">{c.self_rating ?? "—"}</td>
                  <td className="px-4 py-3">
                    <RatingSelect
                      label={`${c.name} HR rating`}
                      value={lines[i]?.rating ?? null}
                      invalid={!!ratingError}
                      disabled={readOnly}
                      onChange={(v) => change(i, "rating", v)}
                    />
                    {ratingError && <p className="mt-1 text-xs text-destructive">{ratingError}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      value={lines[i]?.comment ?? ""}
                      disabled={readOnly}
                      aria-label={`${c.name} comment`}
                      aria-invalid={!!commentError}
                      className={commentError ? "border-destructive" : ""}
                      onChange={(e) => change(i, "comment", e.target.value)}
                    />
                    {commentError && <p className="mt-1 text-xs text-destructive">{commentError}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2 className={`${SECTION_TITLE} mt-6 mb-2`}>Manager Competencies – rated by Manager and HOD (view only)</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Competency type</PmsTh>
              <PmsTh>Self</PmsTh>
              <PmsTh>Manager</PmsTh>
              <PmsTh>HOD</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.manager_competencies.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-4 py-3 text-foreground">{c.name}</td>
                <td className="px-4 py-3">
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    Manager
                  </span>
                </td>
                <td className="px-4 py-3 text-foreground">{c.self_rating ?? "—"}</td>
                <td className="px-4 py-3 text-foreground">{c.manager_rating ?? "—"}</td>
                <td className="px-4 py-3 text-foreground">{c.hod_rating ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 space-y-1.5">
          <Label htmlFor="hr-remarks">HR Remarks</Label>
          <Input
            id="hr-remarks"
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

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={toList}>Back</Button>
          {readOnly ? (
            <p className="text-sm text-muted-foreground">This employee is with calibration.</p>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onSaveDraft} disabled={saving || submitting}>
                {saving ? "Saving…" : "Save Draft"}
              </Button>
              <Button onClick={onSubmit} disabled={saving || submitting}>
                {submitting ? "Submitting…" : "Submit HR Ratings"}
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

export default HrCompetencyEmployeePage;
