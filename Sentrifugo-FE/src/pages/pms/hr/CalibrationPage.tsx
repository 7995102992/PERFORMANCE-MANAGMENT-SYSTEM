import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsCalibrationQuery,
  usePublishPmsCalibrationMutation,
  useSavePmsCalibrationMutation,
} from "@/store/api/pmsApi";
import type { PmsCalibration, PmsCalibrationSave } from "@/types/pms-hr";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { RatingSelect } from "../shared/RatingSelect";
import { toFieldErrors, type FieldErrors } from "../shared/validation";
import { calibrationSchema, draftCalibrationSchema } from "./hr.schema";

/** Screen 1.9 - Calibration & Publish: compare the distribution with the guideline, adjust, then publish. */
const CalibrationPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const { data, isLoading, isError } = useGetPmsCalibrationQuery(financialYear);

  // Financial-year dropdown in the header; changing it reopens the page for that year.
  const yearTag = (
    <FinancialYearTag fy={fy} onChange={(next) => navigate({ to: "/pms/calibration/$fy", params: { fy: next } })} />
  );

  if (isLoading) return <PageLoader message="Loading calibration…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader
          title="Calibration & Normalization"
          subtitle="Could not load the calibration for this year."
          action={yearTag}
        />
      </div>
    );
  }

  return <CalibrationForm key={financialYear} data={data} financialYear={financialYear} yearTag={yearTag} />;
};

/**
 * The editable part of screen 1.9: set HR normalization targets (must total 100%), adjust each
 * employee calibrated rating with a reason, save, and approve and publish.
 */
const CalibrationForm = ({
  data,
  financialYear,
  yearTag,
}: {
  data: PmsCalibration;
  financialYear: string;
  yearTag: React.ReactNode;
}) => {
  // Save and publish mutations.
  const [save, { isLoading: saving }] = useSavePmsCalibrationMutation();
  const [publish, { isLoading: publishing }] = usePublishPmsCalibrationMutation();

  // HR normalization % per rating level, typed as text.
  const [percents, setPercents] = useState<Record<number, string>>(() =>
    Object.fromEntries(data.distribution.map((l) => [l.rating, String(l.hr_percent)])),
  );
  // Per employee: the rating before calibration, the calibrated rating and the reason typed so far.
  const [employees, setEmployees] = useState(() =>
    data.employees.map((e) => ({
      employee_user_id: e.employee_user_id,
      current_rating: e.current_rating,
      calibrated_rating: e.calibrated_rating,
      reason: e.reason,
    })),
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  // Locked once published.
  const readOnly = data.published;
  /** HR % for a rating level as a whole number (0 when empty or invalid). */
  const parsePercent = (rating: number) => {
    const n = Number(percents[rating]);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  // Totals of the three distributions, and how far HR normalization is from 100.
  const total = data.distribution.reduce((sum, l) => sum + parsePercent(l.rating), 0);
  const currentTotal = data.distribution.reduce((sum, l) => sum + l.current_percent, 0);
  const guidelineTotal = data.distribution.reduce((sum, l) => sum + l.guideline_percent, 0);
  const gap = 100 - total;

  // True when any HR % is not a whole number from 0 to 100.
  const percentError = data.distribution.some((l) => {
    const n = Number(percents[l.rating]);
    return !Number.isInteger(n) || n < 0 || n > 100;
  });

  /** Removes one validation message. */
  const clear = (key: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /** Updates the calibrated rating or reason of one employee. */
  const change = (index: number, field: "calibrated_rating" | "reason", value: number | string) => {
    setEmployees((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
    clear(`employees.${index}.${field}`);
    if (field === "calibrated_rating") clear(`employees.${index}.reason`);
  };

  /** Builds the API body: HR targets and each employee calibrated rating and reason. */
  const payload = (): PmsCalibrationSave => ({
    financial_year: financialYear,
    distribution: data.distribution.map((l) => ({ rating: l.rating, hr_percent: parsePercent(l.rating) })),
    employees: employees.map((e) => ({
      employee_user_id: e.employee_user_id,
      calibrated_rating: e.calibrated_rating,
      reason: e.reason.trim(),
    })),
  });

  /** Saves the targets and ratings without publishing. */
  const onSave = async () => {
    const parsed = draftCalibrationSchema.safeParse({ employees });
    if (!parsed.success || percentError) {
      setErrors(parsed.success ? {} : toFieldErrors(parsed.error));
      toast.error(percentError ? "Normalization % must be a whole number from 0 to 100" : "Shorten the highlighted reasons");
      return;
    }
    try {
      await save(payload()).unwrap();
      toast.success("Calibration saved");
    } catch (e) {
      toast.error(e, "Could not save the calibration");
    }
  };

  /** Validates ratings and reasons, saves, then publishes (the API refuses unless targets total 100%). */
  const onPublish = async () => {
    const parsed = calibrationSchema.safeParse({ employees });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Choose a rating for everyone, and a reason wherever a rating changed");
      return;
    }
    try {
      // Publishing reads what is stored, so the screen's targets and ratings are saved first.
      await save(payload()).unwrap();
      await publish({ financial_year: financialYear }).unwrap();
      toast.success("Ratings published");
    } catch (e) {
      toast.error(e, "Could not publish the ratings");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Calibration & Normalization"
        subtitle="Review ratings across departments for consistency"
        action={yearTag}
      />

      <PmsTableCard>
        {readOnly && (
          <div className="mb-4 flex items-start gap-2 rounded-md bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            These ratings have been approved and published. They can no longer be changed.
          </div>
        )}

        <h2 className="mb-2 text-sm font-semibold text-foreground">Rating Distribution</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>Rating</PmsTh>
              <PmsTh>Label</PmsTh>
              <PmsTh>Current Distribution %</PmsTh>
              <PmsTh>Normalization % (Guideline)</PmsTh>
              <PmsTh>HR Normalization %</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.distribution.map((l) => (
              <tr key={l.rating} className="border-t">
                <td className="px-4 py-3 font-medium text-foreground">{l.rating}</td>
                <td className="px-4 py-3 text-foreground">{l.label}</td>
                <td className="px-4 py-3 text-foreground">{l.current_percent}</td>
                <td className="px-4 py-3 text-foreground">{l.guideline_percent}</td>
                <td className="px-4 py-3">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    className="w-24"
                    disabled={readOnly}
                    aria-label={`HR normalization % for rating ${l.rating}`}
                    value={percents[l.rating] ?? ""}
                    onChange={(e) => setPercents((prev) => ({ ...prev, [l.rating]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
            <tr className="border-t font-semibold">
              <td className="px-4 py-3 text-foreground" colSpan={2}>Total</td>
              <td className="px-4 py-3 text-foreground">{currentTotal}%</td>
              <td className="px-4 py-3 text-foreground">{guidelineTotal}%</td>
              <td className={cn("px-4 py-3", total === 100 ? "text-foreground" : "text-destructive")}>{total}%</td>
            </tr>
          </tbody>
        </table>

        {!readOnly && total !== 100 && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              HR Normalization total is <strong>{total}%</strong> — <strong>{Math.abs(gap)}%</strong>{" "}
              {gap > 0 ? "more required to reach" : "over"} 100%. Ratings cannot be published until the total is 100%.
            </p>
          </div>
        )}

        <h2 className="mt-6 mb-2 text-sm font-semibold text-foreground">Employee Ratings</h2>
        {data.employees.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No employees have been sent to calibration yet. Send rated employees from HR Competency Rating.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh>Employee</PmsTh>
                <PmsTh>Manager</PmsTh>
                <PmsTh>HOD</PmsTh>
                <PmsTh>HR Comp Avg</PmsTh>
                <PmsTh>Calibrated Rating</PmsTh>
                <PmsTh>Reason</PmsTh>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((emp, i) => {
                const ratingError = errors[`employees.${i}.calibrated_rating`];
                const reasonError = errors[`employees.${i}.reason`];
                return (
                  <tr key={emp.employee_user_id} className="border-t align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{emp.employee_name}</p>
                      <p className="text-xs text-muted-foreground">{emp.emp_code}</p>
                    </td>
                    <td className="px-4 py-3 text-foreground">{emp.manager_rating ?? "—"}</td>
                    <td className="px-4 py-3 text-foreground">{emp.hod_rating ?? "—"}</td>
                    <td className="px-4 py-3 text-foreground">
                      {emp.hr_competency_avg === null ? "—" : emp.hr_competency_avg.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <RatingSelect
                        label={`${emp.employee_name} calibrated rating`}
                        value={employees[i]?.calibrated_rating ?? null}
                        invalid={!!ratingError}
                        disabled={readOnly}
                        onChange={(v) => change(i, "calibrated_rating", v)}
                      />
                      {ratingError && <p className="mt-1 text-xs text-destructive">{ratingError}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        value={employees[i]?.reason ?? ""}
                        disabled={readOnly}
                        aria-label={`${emp.employee_name} reason`}
                        aria-invalid={!!reasonError}
                        className={reasonError ? "border-destructive" : ""}
                        onChange={(e) => change(i, "reason", e.target.value)}
                      />
                      {reasonError && <p className="mt-1 text-xs text-destructive">{reasonError}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {!readOnly && (
          <div className="mt-4 flex items-center justify-between border-t pt-4">
            <Button variant="outline" onClick={onSave} disabled={saving || publishing}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              onClick={onPublish}
              disabled={saving || publishing || total !== 100 || percentError || employees.length === 0}
            >
              {publishing ? "Publishing…" : "Approve & Publish Ratings"}
            </Button>
          </div>
        )}
      </PmsTableCard>
    </div>
  );
};

export default CalibrationPage;
