import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Clock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsHodQueueQuery,
  useGetPmsHodReviewQuery,
  useHodApproveMutation,
  useHodReturnMutation,
} from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../../shared/PmsTableCard";
import { formatDisplayDate } from "../../shared/pms.utils";
import ReturnToManagerDialog from "./ReturnToManagerDialog";
import type { PmsHodRequestType } from "@/types/pms-goals";
import { HOD_LIST_PATH, hodNumber } from "./hod.utils";

/**
 * Screen 5.3 "Review & Approve Goals": the whole goal sheet of one employee, used for both a goal sheet and a
 * mid-year target revision. Every KPI is listed with its final target; a target that changed carries an info
 * mark that shows its history on hover. For a goal sheet the history is (manager target, employee request,
 * L1 revised target); for a mid-year revision it is (current target, revised target). Approve or return it.
 */
export function GoalSheetReview() {
  const {
    fy = "",
    employeeUserId = "",
    requestType = "goal_sheet",
  } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string; requestType?: PmsHodRequestType };
  const isRevision = requestType === "target_revision";
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const back = () => navigate({ to: HOD_LIST_PATH, params: { fy } });

  const { data, isLoading, isError } = useGetPmsHodReviewQuery({
    employeeUserId,
    financialYear,
    requestType,
  });
  const { data: queue = [] } = useGetPmsHodQueueQuery(financialYear);
  const [approve, { isLoading: approving }] = useHodApproveMutation();
  const [returnGoals, { isLoading: returning }] = useHodReturnMutation();
  const [returnOpen, setReturnOpen] = useState(false);

  if (isLoading) return <PageLoader message="Loading goal sheet…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader
          title={isRevision ? "Target Revision Approval" : "Goal Approval"}
          subtitle="Could not load this request."
        />
        <Button variant="outline" onClick={back}>
          Back
        </Button>
      </div>
    );
  }

  const busy = approving || returning;
  // A goal sheet is decided while it is with the HOD; a revision while any of its KRAs is still pending.
  const decided = isRevision
    ? !data.rows.some((r) => r.changed && r.decision === "pending")
    : data.goal_status !== "with_hod";
  const body = (remarks?: string) => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    request_type: requestType,
    ...(remarks ? { remarks } : {}),
  });

  /** Approves the sheet and goes back to the list. */
  const onApprove = async () => {
    try {
      await approve(body()).unwrap();
      toast.success(isRevision ? "Target revision approved" : "Goals approved");
      back();
    } catch (e) {
      toast.error(e, isRevision ? "Could not approve the target revision" : "Could not approve the goals");
    }
  };

  /** Returns the sheet to the Section Head with the remarks confirmed in the dialog. */
  const onReturn = async (remarks: string) => {
    try {
      await returnGoals(body(remarks)).unwrap();
      setReturnOpen(false);
      toast.success(isRevision ? "Target revision returned to the Section Head" : "Goals returned to the Section Head");
      back();
    } catch (e) {
      toast.error(e, isRevision ? "Could not return the target revision" : "Could not return the goals");
    }
  };

  const summary = (label: string, value: string) => (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold text-foreground">{value}</p>
    </div>
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={isRevision ? "Target Revision Approval" : "Goal Approval"}
        subtitle={
          isRevision
            ? "Review the revised targets, then approve or return the revision"
            : "Review the goal sheet, then approve or return it"
        }
        action={
          <div className="flex items-center gap-3">
            <span className="rounded-md border bg-card px-3 py-2 text-sm font-medium">FY {financialYear}</span>
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="size-4 text-amber-500" /> Pending: {queue.length}
            </span>
          </div>
        }
      />

      <PmsTableCard>
        <div className="flex flex-wrap gap-x-10 gap-y-3 rounded-xl border px-5 py-3">
          {summary("Employee", `${data.employee_name} (${data.emp_code})`)}
          {summary("Role", data.designation_name || "—")}
          {summary("Manager", data.manager_name || "—")}
          {summary("Template", data.template_name || "—")}
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
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
              {data.rows.map((r) => (
                <tr key={r.kpi_id} className="border-t">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{r.kpi_name}</p>
                    <p className="text-xs text-muted-foreground">{r.kra_name}</p>
                  </td>
                  <td className="px-4 py-3.5 text-foreground">{hodNumber(r.weight)}</td>
                  <td className="px-4 py-3.5 text-foreground">
                    <span className={r.changed ? "font-semibold" : ""}>{hodNumber(r.requested)}</span>
                    {r.changed && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`History of ${r.kpi_name}`}
                            className="ml-1.5 inline-flex align-middle text-primary"
                          >
                            <Info className="size-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="bg-slate-900 p-3 text-slate-50">
                          {/* One line per step, stacked: label on the left, value on the right. */}
                          <div className="flex w-60 flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-6">
                              <span>{isRevision ? "Current target" : "Manager (L1) target"}</span>
                              <strong>{hodNumber(r.approved_now)}</strong>
                            </div>
                            {r.employee_requested != null && (
                              <div className="flex items-center justify-between gap-6">
                                <span>Employee requested</span>
                                <strong>{hodNumber(r.employee_requested)}</strong>
                              </div>
                            )}
                            <div className="flex items-center justify-between gap-6">
                              <span>{isRevision ? "Revised target" : "L1 revised target"}</span>
                              <strong>{hodNumber(r.requested)}</strong>
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-foreground">{r.unit || "—"}</td>
                  <td className="px-4 py-3.5 text-foreground">{r.expected_outcome || "—"}</td>
                  <td className="px-4 py-3.5 text-foreground">{r.evidence_required || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          {isRevision ? (
            <>
              {`Mid-year revision requested by ${data.asked_by_name ?? data.manager_name ?? "the manager"}`}
              {data.asked_on ? ` on ${formatDisplayDate(data.asked_on)}` : ""}
              {" · "}
              <Info className="inline size-3.5 align-text-bottom text-primary" /> = target revised at mid-year; hover
              to see the current and revised target.
            </>
          ) : (
            <>
              {data.acknowledged_on
                ? `Acknowledged by employee on ${formatDisplayDate(data.acknowledged_on)} · `
                : "Not acknowledged yet · "}
              {data.sent_for_approval_on
                ? `Sent for approval by ${data.sent_for_approval_by ?? data.manager_name ?? "the manager"} on ${formatDisplayDate(data.sent_for_approval_on)} · `
                : ""}
              <Info className="inline size-3.5 align-text-bottom text-primary" /> = target changed after the first
              draft; hover to see its history.
            </>
          )}
        </p>

        {decided && (
          <p className="mt-3 flex items-center gap-2 rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" /> This goal sheet is not waiting for your decision.
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <Button variant="outline" onClick={back} disabled={busy}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={decided || busy}
              onClick={() => setReturnOpen(true)}
            >
              Return to Section Head
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={decided || busy}
              onClick={onApprove}
            >
              {approving ? "Approving…" : "Approve"}
            </Button>
          </div>
        </div>
      </PmsTableCard>

      <ReturnToManagerDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        employeeName={data.employee_name}
        managerName={data.manager_name ?? ""}
        kraNames={[]}
        initialRemarks=""
        busy={returning}
        onConfirm={onReturn}
      />
    </div>
  );
}
