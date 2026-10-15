import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, Check, Eye } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsEmployeeTargetsQuery,
  useGetPmsRoleEmployeesQuery,
  useSaveEmployeeTargetsMutation,
  useSendEmployeeTargetsMutation,
  useValidateEmployeeTargetsMutation,
} from "@/store/api/pmsApi";
import type {
  PmsEmployeeTargets,
  PmsTargetRow,
  PmsTargetsRequest,
} from "@/types/pms-goals";
import { isoToDate } from "../shared/pms.utils";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatNumber, type FieldErrors } from "../shared/validation";
import { checkTargetRows, type TargetFormRow } from "./target.schema";

/** Statuses after which the manager can no longer edit the sheet. */
const LOCKED = ["sent_to_employee", "acknowledged", "with_hod", "approved"];

/** Target type value to display label. */
const TARGET_TYPE_LABEL: Record<string, string> = {
  common: "Common",
  individual: "Individual",
};

/** Screens 3.3 - 3.5: enter, validate and send one employee's targets. */
const TargetAssignmentPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as {
    fy?: string;
    employeeUserId?: string;
  };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  /** Back to My Team. */
  const toTeam = () =>
    navigate({ to: "/pms/team-goal-setting/$fy", params: { fy } });

  // The employee sheet from the API (template KPIs with weights and targets).
  const { data, isLoading, isError } = useGetPmsEmployeeTargetsQuery({
    employeeUserId,
    financialYear,
  });
  // Only used as a fallback for the header card when the API does not send the employee's details.
  const { data: roster = [] } = useGetPmsRoleEmployeesQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading targets…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader
          title="Target Assignment"
          subtitle="Could not load this employee's goal template."
        />
        <Button variant="outline" onClick={toTeam}>
          Back to My Team
        </Button>
      </div>
    );
  }

  // Header details for the employee, used only when `data` lacks them.
  const person = roster.find((m) => m.user_id === employeeUserId);
  return (
    <TargetForm
      key={employeeUserId}
      data={data}
      employeeUserId={employeeUserId}
      financialYear={financialYear}
      fallbackName={person?.name}
      fallbackCode={person?.emp_code}
      fallbackRole={person?.designation_name}
      onSent={() =>
        navigate({ to: "/pms/team-goal-setting/$fy/role", params: { fy } })
      }
      onBack={toTeam}
    />
  );
};

/** Props for TargetForm. */
interface FormProps {
  data: PmsEmployeeTargets;
  employeeUserId: string;
  financialYear: string;
  fallbackName?: string;
  fallbackCode?: string;
  fallbackRole?: string;
  onSent: () => void;
  onBack: () => void;
}

/**
 * The editable form of screens 3.3 - 3.5: enter weight and target per KPI, save a draft, validate,
 * then send to the employee. Rows are kept as text until they are turned into numbers for the API.
 */
const TargetForm = ({
  data,
  employeeUserId,
  financialYear,
  fallbackName,
  fallbackCode,
  fallbackRole,
  onSent,
  onBack,
}: FormProps) => {
  // Save-draft, validate and send mutations.
  const [saveDraft, { isLoading: saving }] = useSaveEmployeeTargetsMutation();
  const [validate, { isLoading: validating }] =
    useValidateEmployeeTargetsMutation();
  const [send, { isLoading: sending }] = useSendEmployeeTargetsMutation();

  // One row per KPI as typed.
  const [rows, setRows] = useState<TargetFormRow[]>(() =>
    data.kpis.map((k) => ({
      kpi_id: k.kpi_id,
      kpi_name: k.kpi_name,
      weight: String(k.weight),
      target: k.target === null ? "" : String(k.target),
    })),
  );
  // `null` until the manager has pressed Validate; the history column and panel only show before that.
  const [result, setResult] = useState<{
    valid: boolean;
    errors: string[];
  } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [historyKpiId, setHistoryKpiId] = useState(data.kpis[0]?.kpi_id ?? "");

  // Read-only once the sheet is with the employee or beyond. Name and code come from the API or the fallback.
  const locked = LOCKED.includes(data.goal_status);
  const name = data.employee_name ?? fallbackName ?? "Employee";
  const code = data.emp_code ?? fallbackCode;
  // Running weight total (must reach 100 to validate).
  const total = useMemo(
    () =>
      rows.reduce(
        (sum, r) =>
          sum +
          (Number.isFinite(Number(r.weight)) && r.weight.trim() !== ""
            ? Number(r.weight)
            : 0),
        0,
      ),
    [rows],
  );
  // KPI whose previous-year history is shown in the side panel, and the acknowledge deadline.
  const showHistory = result === null;
  const historyKpi = data.kpis.find((k) => k.kpi_id === historyKpiId);

  // KPI row indexes grouped by KRA (in template order), with each KRA weight total and whether any of its
  // fields has a validation error.
  const kraGroups = useMemo(() => {
    const byKra = new Map<string, number[]>();
    data.kpis.forEach((k, i) => {
      const key = k.kra_name || "Other";
      byKra.set(key, [...(byKra.get(key) ?? []), i]);
    });
    return [...byKra.entries()].map(([name, indexes]) => {
      const weight = indexes.reduce((sum, i) => {
        const w = rows[i]?.weight ?? "";
        return sum + (w.trim() !== "" && Number.isFinite(Number(w)) ? Number(w) : 0);
      }, 0);
      const hasError = indexes.some(
        (i) => fieldErrors[`rows.${i}.weight`] !== undefined || fieldErrors[`rows.${i}.target`] !== undefined,
      );
      return { name, indexes, weight: Math.round(weight * 100) / 100, hasError };
    });
  }, [data.kpis, rows, fieldErrors]);

  /** Sets a KRA weight and splits it across its KPIs in proportion to their current weights (equally if none). */
  const updateKraWeight = (indexes: number[], value: string) => {
    const w = Number(value);
    const valid = value.trim() !== "" && Number.isFinite(w);
    setRows((prev) => {
      const old = indexes.map((i) => Number(prev[i].weight) || 0);
      const sum = old.reduce((x, y) => x + y, 0);
      return prev.map((r, i) => {
        const pos = indexes.indexOf(i);
        if (pos < 0) return r;
        if (!valid) return { ...r, weight: value };
        const share = sum > 0 ? old[pos] / sum : 1 / indexes.length;
        return { ...r, weight: String(Math.round(w * share * 100) / 100) };
      });
    });
    setFieldErrors((prev) => {
      const next = { ...prev };
      indexes.forEach((i) => delete next[`rows.${i}.weight`]);
      return next;
    });
  };

  const dueBy = isoToDate(data.acknowledge_by);

  /** Updates one weight or target and clears that field error. */
  const update = (index: number, field: "weight" | "target", value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    );
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`rows.${index}.${field}`];
      return next;
    });
  };

  /** Builds the API body: empty weights become 0, empty targets become null. */
  const payload = (): PmsTargetsRequest => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    targets: rows.map<PmsTargetRow>((r) => ({
      kpi_id: r.kpi_id,
      weight:
        r.weight.trim() !== "" && Number.isFinite(Number(r.weight))
          ? Number(r.weight)
          : 0,
      target:
        r.target.trim() !== "" && Number.isFinite(Number(r.target))
          ? Number(r.target)
          : null,
    })),
  });

  /** Saves the entered targets as a draft (incomplete sheets are allowed). */
  const onSaveDraft = async () => {
    try {
      await saveDraft(payload()).unwrap();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  /** Runs the local checks, then asks the API to validate; opens the confirmation when valid. */
  const onValidate = async () => {
    const check = checkTargetRows(rows);
    setFieldErrors(check.fieldErrors);
    if (check.summary.length > 0) {
      setResult({ valid: false, errors: check.summary });
      return;
    }
    try {
      const res = await validate(payload()).unwrap();
      setResult({ valid: res.valid, errors: res.errors });
      if (res.valid) setConfirmOpen(true);
    } catch (e) {
      toast.error(e, "Could not validate the targets");
    }
  };

  /** Sends the sheet to the employee for acknowledgement, then leaves the form. */
  const onSend = async () => {
    try {
      await send(payload()).unwrap();
      setConfirmOpen(false);
      toast.success("Goals sent to the employee for acknowledgement");
      onSent();
    } catch (e) {
      toast.error(e, "Could not send the goals");
    }
  };

  // Page subtitle that follows the validation state.
  const subtitle = result?.valid
    ? "Validation passed — send the goals to the employee"
    : result
      ? "Fix the highlighted fields and validate again"
      : "Enter this employee's targets for each KRA and validate";

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Employee Target Assignment" subtitle={subtitle} />

      <PmsTableCard>
        <div className="grid gap-4 rounded-lg border p-3 text-sm md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
          <div>
            <p className="text-xs text-muted-foreground">Employee</p>
            <p className="font-semibold text-foreground">{name}</p>
            {code && <p className="text-xs text-foreground">({code})</p>}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Role</p>
            <p className="font-semibold text-foreground">
              {data.role_name ?? fallbackRole ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Manager</p>
            <p className="font-semibold text-foreground">
              {data.manager_name ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Template</p>
            <p className="font-semibold text-foreground">
              {data.template_name}
            </p>
          </div>
          <div className="text-xs text-muted-foreground md:text-right">
            <p>
              <strong className="text-foreground">Common</strong>: the same
              target value for the same KPI across employees.
            </p>
            <p>
              <strong className="text-foreground">Individual</strong>: this
              employee&apos;s own target value.
            </p>
          </div>
        </div>

        {data.acknowledge_comment && (
          <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
            <span className="font-medium text-foreground">Employee comment on acknowledging: </span>
            <span className="text-muted-foreground">{data.acknowledge_comment}</span>
          </div>
        )}

        {result && !result.valid && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>Validation failed:</strong> {result.errors.join(" · ")}.
            </p>
          </div>
        )}

        {/* One row per KRA. A KRA's weight is split across its KPIs and its target applies to each of them. */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                <PmsTh>KRA</PmsTh>
                <PmsTh>Weight %</PmsTh>
                <PmsTh>Target type</PmsTh>
                <PmsTh>Target</PmsTh>
                <PmsTh>Unit</PmsTh>
                <PmsTh>Expected outcome</PmsTh>
                <PmsTh>Evidence</PmsTh>
                {showHistory && <PmsTh>History</PmsTh>}
              </tr>
            </thead>
            <tbody>
              {kraGroups.map((g) => {
                const first = data.kpis[g.indexes[0]];
                const weightError = g.indexes.map((i) => fieldErrors[`rows.${i}.weight`]).find(Boolean);
                const targetError = g.indexes.map((i) => fieldErrors[`rows.${i}.target`]).find(Boolean);
                const selected = showHistory && g.indexes.some((i) => data.kpis[i].kpi_id === historyKpiId);
                const targetValue = rows[g.indexes[0]]?.target ?? "";
                return (
                  <tr key={g.name} className={cn("border-t align-top", selected && "bg-primary/5")}>
                    <td className="px-4 py-3 font-medium text-foreground">{g.name}</td>
                    <td className="px-4 py-3">
                      <Input
                        inputMode="decimal"
                        className={cn("w-20", weightError && "border-destructive")}
                        aria-label={`${g.name} weight`}
                        aria-invalid={weightError !== undefined}
                        readOnly={locked}
                        defaultValue={g.weight}
                        key={`${g.name}-${g.weight}`}
                        onBlur={(e) => updateKraWeight(g.indexes, e.target.value)}
                      />
                      {weightError && <p className="mt-1 text-xs text-destructive">{weightError}</p>}
                    </td>
                    <td className="px-4 py-3 text-foreground">
                      {first.target_type ? TARGET_TYPE_LABEL[first.target_type] : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        inputMode="decimal"
                        className={cn("w-28", targetError && "border-destructive")}
                        aria-label={`${g.name} target`}
                        aria-invalid={targetError !== undefined}
                        readOnly={locked}
                        value={targetValue}
                        onChange={(e) => g.indexes.forEach((i) => update(i, "target", e.target.value))}
                      />
                      {targetError && <p className="mt-1 text-xs text-destructive">{targetError}</p>}
                    </td>
                    <td className="px-4 py-3 text-foreground">{first.unit}</td>
                    <td className="px-4 py-3">
                      <Input readOnly tabIndex={-1} aria-label={`${g.name} expected outcome`} value={first.expected_outcome || "—"} />
                    </td>
                    <td className="px-4 py-3">
                      <Input readOnly tabIndex={-1} aria-label={`${g.name} evidence`} value={first.evidence_required || "—"} />
                    </td>
                    {showHistory && (
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Show previous-year targets for ${g.name}`}
                          aria-pressed={selected}
                          onClick={() => setHistoryKpiId(first.kpi_id)}
                        >
                          <Eye className="h-4 w-4 text-primary" />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {showHistory && historyKpi && (
          <div className="mt-4 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">
                Previous-year targets · {historyKpi.kra_name || historyKpi.kpi_name} ({historyKpi.unit})
              </p>
              <p className="text-xs text-muted-foreground">
                {data.role_name ?? fallbackRole}
              </p>
            </div>
            {historyKpi.history && historyKpi.history.length > 0 ? (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className={PMS_HEADER_ROW}>
                    <PmsTh>Financial year</PmsTh>
                    <PmsTh>Target</PmsTh>
                    <PmsTh>Actual</PmsTh>
                    <PmsTh>Achievement</PmsTh>
                  </tr>
                </thead>
                <tbody>
                  {historyKpi.history.map((h) => (
                    <tr key={h.financial_year} className="border-t">
                      <td className="px-4 py-2.5 text-foreground">
                        FY {h.financial_year}
                      </td>
                      <td className="px-4 py-2.5 text-foreground">
                        {formatNumber(h.target)}
                      </td>
                      <td className="px-4 py-2.5 text-foreground">
                        {formatNumber(h.actual)}
                      </td>
                      <td className="px-4 py-2.5 text-foreground">
                        {h.actual !== null && h.target > 0
                          ? `${((h.actual / h.target) * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No previous-year data for this KPI.
              </p>
            )}
          </div>
        )}

        <p className="mt-4 text-right text-sm text-muted-foreground">
          Total weightage:{" "}
          <span
            className={
              Math.abs(total - 100) < 0.01
                ? "font-semibold text-emerald-600"
                : "font-semibold text-destructive"
            }
          >
            {Math.round(total * 100) / 100}%
          </span>
        </p>

        <div className="mt-3 flex items-center justify-between border-t pt-4">
          {locked ? (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={onSaveDraft}
                disabled={saving || validating || sending}
              >
                {saving ? "Saving…" : "Save Draft"}
              </Button>
              <Button
                onClick={onValidate}
                disabled={saving || validating || sending}
              >
                {validating
                  ? "Validating…"
                  : result && !result.valid
                    ? "Validate Again"
                    : "Validate"}
              </Button>
            </>
          )}
        </div>
      </PmsTableCard>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save and Send to Employee</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            <Check className="h-4 w-4" /> Validation passed
          </div>
          <p className="text-sm text-foreground">
            The goal sheet will be sent to <strong>{name}</strong> for
            acknowledgement.
            {dueBy && (
              <>
                {" "}
                Due by <strong>{format(dueBy, "dd MMM yyyy")}</strong>.
              </>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            Next, set targets for the remaining employees one by one.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button onClick={onSend} disabled={sending}>
              {sending ? "Sending…" : "Save & Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TargetAssignmentPage;
