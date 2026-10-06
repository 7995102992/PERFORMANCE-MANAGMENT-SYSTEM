import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useApproveGoalsMutation,
  useGetPmsEmployeeTargetsQuery,
  useReturnGoalsMutation,
} from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";

const GOALS_PATH = "/pms/goal-approvals/$fy";

/** Screen 5.2: the HOD reviews one employee's goal sheet, then approves it or returns it to the manager. */
const GoalReviewPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const back = () => navigate({ to: GOALS_PATH, params: { fy } });

  const { data, isLoading, isError } = useGetPmsEmployeeTargetsQuery({ employeeUserId, financialYear });
  const [approve, { isLoading: approving }] = useApproveGoalsMutation();
  const [returnGoals, { isLoading: returning }] = useReturnGoalsMutation();
  const [remarks, setRemarks] = useState("");

  if (isLoading) return <PageLoader message="Loading goal sheet…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Goal Approval" subtitle="Could not load this goal sheet." />
        <Button variant="outline" onClick={back}>Back to approvals</Button>
      </div>
    );
  }

  const busy = approving || returning;

  const onApprove = async () => {
    try {
      await approve({ employee_user_id: employeeUserId, financial_year: financialYear, remarks: remarks.trim() || undefined }).unwrap();
      toast.success("Goals approved");
      back();
    } catch (e) {
      toast.error(e, "Could not approve the goals");
    }
  };

  const onReturn = async () => {
    if (!remarks.trim()) {
      toast.error("Add a remark so the manager knows what to change");
      return;
    }
    try {
      await returnGoals({ employee_user_id: employeeUserId, financial_year: financialYear, remarks: remarks.trim() }).unwrap();
      toast.success("Goals returned to the manager");
      back();
    } catch (e) {
      toast.error(e, "Could not return the goals");
    }
  };

  const total = data.kpis.reduce((sum, k) => sum + k.weight, 0);

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Goal Approval" subtitle="Review the goal sheet, then approve or return it" />

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

      {data.change_reason && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Employee change request: &ldquo;{data.change_reason}&rdquo;
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
            {data.kpis.map((k) => (
              <tr key={k.kpi_id} className="border-t">
                <td className="px-4 py-3">
                  <p className="text-xs text-muted-foreground">{k.kra_name}</p>
                  <p className="font-medium text-foreground">{k.kpi_name}</p>
                </td>
                <td className="px-4 py-3">{k.weight}</td>
                <td className="px-4 py-3">{k.target ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                <td className="px-4 py-3 text-muted-foreground">{k.expected_outcome || "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{k.evidence_required || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-right text-sm text-muted-foreground">Total weightage: {total}%</p>

        <div className="mt-6 space-y-1.5">
          <label htmlFor="hod-remarks" className="text-sm font-medium text-foreground">
            HOD remarks
          </label>
          <textarea
            id="hod-remarks"
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          />
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" className="border-destructive text-destructive" onClick={onReturn} disabled={busy}>
            {returning ? "Returning…" : "Return"}
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={onApprove} disabled={busy}>
            {approving ? "Approving…" : "Approve"}
          </Button>
        </div>
      </PmsTableCard>
    </div>
  );
};

export default GoalReviewPage;
