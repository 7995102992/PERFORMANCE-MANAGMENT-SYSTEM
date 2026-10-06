import { useEffect, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsEmployeeTargetsQuery,
  useSaveEmployeeTargetsMutation,
  useSendEmployeeTargetsMutation,
  useValidateEmployeeTargetsMutation,
} from "@/store/api/pmsApi";
import type { PmsTargetRow, PmsTargetsRequest, PmsTargetValidation } from "@/types/pms-goals";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";

/** A row as the user types it: text until it is turned into numbers for the API. */
type Draft = { kpi_id: string; weight: string; target: string };

const toNumber = (text: string): number | null => {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/** Screens 3.3 - 3.5: enter, validate and send one employee's targets. */
const TargetAssignmentPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const back = () => navigate({ to: "/pms/team-goal-setting/$fy", params: { fy } });

  const { data, isLoading, isError } = useGetPmsEmployeeTargetsQuery({ employeeUserId, financialYear });
  const [saveDraft, { isLoading: saving }] = useSaveEmployeeTargetsMutation();
  const [validate, { isLoading: validating }] = useValidateEmployeeTargetsMutation();
  const [send, { isLoading: sending }] = useSendEmployeeTargetsMutation();

  const [rows, setRows] = useState<Draft[]>([]);
  const [result, setResult] = useState<PmsTargetValidation | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Load the saved values (or the template defaults) into the form once per employee.
  useEffect(() => {
    if (!data) return;
    setRows(
      data.kpis.map((k) => ({
        kpi_id: k.kpi_id,
        weight: String(k.weight),
        target: k.target === null ? "" : String(k.target),
      })),
    );
  }, [data]);

  if (isLoading) return <PageLoader message="Loading targets…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Target Assignment" subtitle="Could not load this employee's goal template." />
        <Button variant="outline" onClick={back}>Back to My Team</Button>
      </div>
    );
  }

  const payload = (): PmsTargetsRequest => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    targets: rows.map<PmsTargetRow>((r) => ({
      kpi_id: r.kpi_id,
      weight: toNumber(r.weight) ?? 0,
      target: toNumber(r.target),
    })),
  });

  const total = rows.reduce((sum, r) => sum + (toNumber(r.weight) ?? 0), 0);
  const invalidKpis = new Set(result?.errors.length ? rows.filter((r) => toNumber(r.target) === null).map((r) => r.kpi_id) : []);

  const update = (kpiId: string, field: "weight" | "target", value: string) =>
    setRows((prev) => prev.map((r) => (r.kpi_id === kpiId ? { ...r, [field]: value } : r)));

  const onSaveDraft = async () => {
    try {
      await saveDraft(payload()).unwrap();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  const onValidate = async () => {
    try {
      const res = await validate(payload()).unwrap();
      setResult(res);
      if (res.valid) setConfirmOpen(true);
    } catch (e) {
      toast.error(e, "Could not validate the targets");
    }
  };

  const onSend = async () => {
    try {
      await send(payload()).unwrap();
      toast.success("Goals sent to the employee for acknowledgement");
      back();
    } catch (e) {
      toast.error(e, "Could not send the goals");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Employee Target Assignment"
        subtitle={result && !result.valid ? "Fix the highlighted fields and validate again" : "Enter targets for each KPI and validate"}
      />

      <div className="grid gap-4 rounded-lg border bg-card p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground">Template</p>
          <p className="font-medium text-foreground">{data.template_name}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Financial year</p>
          <p className="font-medium text-foreground">{data.financial_year}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Goal status</p>
          <p className="font-medium text-foreground">{data.goal_status.replace(/_/g, " ")}</p>
        </div>
      </div>

      {result && !result.valid && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <strong>Validation failed:</strong> {result.errors.join(" · ")}
        </div>
      )}

      <PmsTableCard>
        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA / KPI</PmsTh>
              <PmsTh>Weight %</PmsTh>
              <PmsTh>Target</PmsTh>
              <PmsTh>Unit</PmsTh>
              <PmsTh>Expected outcome</PmsTh>
              <PmsTh>Evidence</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.kpis.map((k) => {
              const row = rows.find((r) => r.kpi_id === k.kpi_id) ?? { weight: "", target: "" };
              const bad = invalidKpis.has(k.kpi_id);
              return (
                <tr key={k.kpi_id} className="border-t">
                  <td className="px-4 py-3">
                    <p className="text-xs text-muted-foreground">{k.kra_name}</p>
                    <p className="font-medium text-foreground">{k.kpi_name}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      inputMode="decimal"
                      className="w-24"
                      aria-label={`${k.kpi_name} weight`}
                      value={row.weight}
                      onChange={(e) => update(k.kpi_id, "weight", e.target.value)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      inputMode="decimal"
                      className={`w-28 ${bad ? "border-destructive" : ""}`}
                      aria-label={`${k.kpi_name} target`}
                      aria-invalid={bad}
                      value={row.target}
                      onChange={(e) => update(k.kpi_id, "target", e.target.value)}
                    />
                    {bad && <p className="mt-1 text-xs text-destructive">Required</p>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                  <td className="px-4 py-3 text-muted-foreground">{k.expected_outcome || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{k.evidence_required || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </PmsTableCard>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Total weightage:{" "}
          <span className={Math.abs(total - 100) < 0.01 ? "font-semibold text-emerald-600" : "font-semibold text-destructive"}>
            {total.toFixed(2).replace(/\.?0+$/, "")}%
          </span>
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={back}>Back</Button>
          <Button variant="outline" onClick={onSaveDraft} disabled={saving}>
            {saving ? "Saving…" : "Save Draft"}
          </Button>
          <Button onClick={onValidate} disabled={validating}>
            {validating ? "Validating…" : result && !result.valid ? "Validate Again" : "Validate"}
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save and Send to Employee</DialogTitle>
            <DialogDescription>
              Validation passed. The goals will be sent to the employee for acknowledgement.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>
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
