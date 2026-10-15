import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsEmployeeTargetsQuery,
  useGetPmsTeamQuery,
  useSaveEmployeeTargetsMutation,
  useSendEmployeeTargetsMutation,
} from "@/store/api/pmsApi";
import type { PmsEmployeeTargets, PmsTargetsRequest } from "@/types/pms-goals";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatNumber, toFieldErrors, type FieldErrors } from "../shared/validation";
import { reviseSchema, type ReviseFormRow } from "./revise.schema";

/** Screen 3.7 - Revise Returned Goals: the employee (or HOD) sent the sheet back; the manager adjusts targets and resends. */
const ReviseReturnedGoalsPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  /** Back to My Team. */
  const back = () => navigate({ to: "/pms/team-goal-setting/$fy", params: { fy } });

  const { data, isLoading, isError } = useGetPmsEmployeeTargetsQuery({ employeeUserId, financialYear });
  const { data: team = [] } = useGetPmsTeamQuery(financialYear);

  if (isLoading) return <PageLoader message="Loading the returned goals…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Revise Returned Goals" subtitle="Could not load this employee's goal sheet." />
        <Button variant="outline" onClick={back}>Back to My Team</Button>
      </div>
    );
  }

  return (
    <ReviseForm
      key={employeeUserId}
      data={data}
      employeeName={data.employee_name ?? team.find((m) => m.user_id === employeeUserId)?.name ?? "Employee"}
      employeeUserId={employeeUserId}
      financialYear={financialYear}
      back={back}
    />
  );
};

/**
 * The editable part of screen 3.7: change targets (weights are locked), explain each change, then save
 * a draft or send the revised sheet to the employee again.
 */
const ReviseForm = ({
  data,
  employeeName,
  employeeUserId,
  financialYear,
  back,
}: {
  data: PmsEmployeeTargets;
  employeeName: string;
  employeeUserId: string;
  financialYear: string;
  back: () => void;
}) => {
  // Save-draft and send mutations (the same calls as the target assignment page).
  const [saveDraft, { isLoading: saving }] = useSaveEmployeeTargetsMutation();
  const [send, { isLoading: sending }] = useSendEmployeeTargetsMutation();

  // One row per KPI: current target, revised target (text) and the remark for the change.
  const [rows, setRows] = useState<ReviseFormRow[]>(() =>
    data.kpis.map((k) => ({
      kpi_id: k.kpi_id,
      current: k.target ?? 0,
      revised: k.target === null ? "" : String(k.target),
      remarks: "",
    })),
  );
  // Validation messages keyed `rows.<index>.<field>`.
  const [errors, setErrors] = useState<FieldErrors>({});

  // The note that caused the return: the employee change request, else the HOD remarks.
  const comment = data.change_reason
    ? { who: "Employee comment", text: data.change_reason }
    : data.hod_remarks
      ? { who: "HOD remarks", text: data.hod_remarks }
      : null;

  // When the employee asked for a change to one KPI, only that KPI can be revised; every other KPI is locked
  // at its current target. A sheet returned by the HOD (no specific KPI) has every KPI open.
  const requestedKpi = data.change_kpi_id ?? null;
  const isEditable = (kpiId: string) => requestedKpi === null || kpiId === requestedKpi;

  /** Updates one field of one row and clears that field error. */
  const update = (index: number, field: "revised" | "remarks", value: string) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[`rows.${index}.${field}`];
      return next;
    });
  };

  /** Builds the API body; an empty revised target keeps the current one. Weights are sent unchanged. */
  const payload = (): PmsTargetsRequest => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    targets: data.kpis.map((k, i) => {
      const text = isEditable(k.kpi_id) ? (rows[i]?.revised.trim() ?? "") : "";
      const n = text === "" ? k.target : Number(text);
      const remarks = rows[i]?.remarks.trim() ?? "";
      return {
        kpi_id: k.kpi_id,
        weight: k.weight,
        target: Number.isFinite(n) ? n : k.target,
        ...(remarks ? { remarks } : {}),
      };
    }),
  });

  /** Saves the revised targets as a draft. */
  const onSaveDraft = async () => {
    try {
      await saveDraft(payload()).unwrap();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  /** Validates (a changed target needs a remark), then sends the revised sheet to the employee. */
  const onSend = async () => {
    const parsed = reviseSchema.safeParse({
      rows: rows.map((r) =>
        isEditable(r.kpi_id) ? r : { kpi_id: r.kpi_id, current: r.current, revised: String(r.current), remarks: "" },
      ),
    });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Fix the highlighted fields before sending");
      return;
    }
    try {
      await send(payload()).unwrap();
      toast.success("Revised goals sent to the employee");
      back();
    } catch (e) {
      toast.error(e, "Could not send the revised goals");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader title={`Revise Goals – ${employeeName}`} subtitle="Update targets based on the employee's comments" />

      <PmsTableCard>
        {comment && (
          <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>{comment.who}:</strong> <em>“{comment.text}”</em>
            </p>
          </div>
        )}

        {requestedKpi && (
          <p className="mb-3 text-xs text-muted-foreground">
            Only the target the employee asked to change can be revised. The other KPIs stay as they are.
          </p>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA</PmsTh>
              <PmsTh>Current target</PmsTh>
              <PmsTh>Proposed by employee</PmsTh>
              <PmsTh>Revised target</PmsTh>
              <PmsTh>Remarks</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.kpis.map((k, i) => {
              const row = rows[i];
              if (!row) return null;
              const proposed = k.kpi_id === data.change_kpi_id ? data.change_proposed_target : null;
              const editable = isEditable(k.kpi_id);
              const targetError = errors[`rows.${i}.revised`];
              const remarksError = errors[`rows.${i}.remarks`];
              return (
                <tr key={k.kpi_id} className={`border-t align-top ${editable ? "" : "bg-muted/30"}`}>
                  <td className="px-4 py-3">
                    <p className="text-xs text-muted-foreground">{k.kra_name}</p>
                    <p className="font-medium text-foreground">{k.kpi_name}</p>
                    {(k.revision_count ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Changed {k.revision_count} time{k.revision_count === 1 ? "" : "s"} on request
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {formatNumber(k.target)} <span className="text-muted-foreground">{k.unit}</span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{proposed === null ? "—" : formatNumber(proposed)}</td>
                  <td className="px-4 py-3">
                    <Input
                      inputMode="decimal"
                      className={`w-28 ${targetError ? "border-destructive" : ""}`}
                      aria-label={`${k.kpi_name} revised target`}
                      aria-invalid={!!targetError}
                      value={editable ? row.revised : formatNumber(k.target)}
                      disabled={!editable}
                      onChange={(e) => update(i, "revised", e.target.value)}
                    />
                    {editable && targetError && <p className="mt-1 text-xs text-destructive">{targetError}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      className={remarksError ? "border-destructive" : ""}
                      aria-label={`${k.kpi_name} remarks`}
                      aria-invalid={!!remarksError}
                      value={editable ? row.remarks : ""}
                      disabled={!editable}
                      placeholder={editable ? undefined : "Not revised"}
                      onChange={(e) => update(i, "remarks", e.target.value)}
                    />
                    {editable && remarksError && <p className="mt-1 text-xs text-destructive">{remarksError}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={back}>Back</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onSaveDraft} disabled={saving || sending}>
              {saving ? "Saving…" : "Save Draft"}
            </Button>
            <Button onClick={onSend} disabled={saving || sending}>
              {sending ? "Sending…" : "Send to Employee"}
            </Button>
          </div>
        </div>
      </PmsTableCard>
    </div>
  );
};

export default ReviseReturnedGoalsPage;
