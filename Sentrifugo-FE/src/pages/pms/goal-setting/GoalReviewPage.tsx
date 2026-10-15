import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { PmsHodRequestType } from "@/types/pms-goals";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatDisplayDate } from "../shared/pms.utils";
import ReturnToManagerDialog from "./hod/ReturnToManagerDialog";
import { GoalSheetReview } from "./hod/GoalSheetReview";
import { RequestBadge, RoleLabel } from "./hod/hod.components";
import {
  HOD_LIST_PATH,
  HOD_REMARKS_MAX,
  HOD_REVIEW_PATH,
  HOD_TRAIL_PATH,
  hodDelta,
  hodNumber,
} from "./hod/hod.utils";

/**
 * HOD review of one request. A target revision is acted on KRA by KRA (tick the KRAs, then approve or return
 * them); a goal sheet is approved or returned as a whole.
 */
const TargetRevisionReview = () => {
  const { fy = "", employeeUserId = "", requestType = "target_revision" } = useParams({ strict: false }) as {
    fy?: string;
    employeeUserId?: string;
    requestType?: PmsHodRequestType;
  };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  /** Back to the approvals list. */
  const back = () => navigate({ to: HOD_LIST_PATH, params: { fy } });

  const { data, isLoading, isError } = useGetPmsHodReviewQuery({ employeeUserId, financialYear, requestType });
  const { data: queue = [] } = useGetPmsHodQueueQuery(financialYear);
  const [approve, { isLoading: approving }] = useHodApproveMutation();
  const [returnGoals, { isLoading: returning }] = useHodReturnMutation();

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [remarks, setRemarks] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);

  const isRevision = requestType === "target_revision";
  // Only KRAs that changed and are still waiting can be ticked.
  const waiting = useMemo(
    () => (data?.rows ?? []).filter((r) => r.changed && r.decision === "pending"),
    [data],
  );

  // Previous / Next walk the list the HOD came from.
  const position = queue.findIndex((q) => q.employee_user_id === employeeUserId && q.request_type === requestType);
  const goTo = (index: number) => {
    const item = queue[index];
    if (!item) return;
    setPicked(new Set());
    setRemarks("");
    navigate({
      to: HOD_REVIEW_PATH,
      params: { fy, requestType: item.request_type, employeeUserId: item.employee_user_id },
    });
  };

  if (isLoading) return <PageLoader message="Loading request…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Goal Approval" subtitle="Could not load this request." />
        <Button variant="outline" onClick={back}>Back to approvals</Button>
      </div>
    );
  }

  const busy = approving || returning;
  const decided = isRevision ? waiting.length === 0 : data.goal_status !== "with_hod";
  // For a revision the action covers the ticked KRAs; a goal sheet is acted on as a whole.
  const targets = isRevision ? waiting.filter((r) => picked.has(r.kpi_id)) : [];
  const canAct = !decided && (isRevision ? targets.length > 0 : true);
  const remarksTooLong = remarks.length > HOD_REMARKS_MAX;

  /** Ticks or unticks one KRA. */
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setPicked(picked.size === waiting.length ? new Set() : new Set(waiting.map((r) => r.kpi_id)));

  /** Body shared by approve and return. */
  const body = (text?: string) => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    request_type: requestType,
    ...(isRevision ? { kpi_ids: targets.map((r) => r.kpi_id) } : {}),
    ...(text ? { remarks: text } : {}),
  });

  /** After a decision: stay on a revision that still has KRAs waiting, otherwise return to the list. */
  const afterDecision = (stillWaiting: boolean) => {
    setPicked(new Set());
    setRemarks("");
    if (!stillWaiting) back();
  };

  /** Approves the whole sheet, or the ticked KRAs of a revision. */
  const onApprove = async () => {
    if (!canAct) return;
    if (remarksTooLong) {
      toast.error(`Remarks can be at most ${HOD_REMARKS_MAX} characters`);
      return;
    }
    try {
      const result = await approve(body(remarks.trim() || undefined)).unwrap();
      toast.success(isRevision ? `${targets.length} KRA${targets.length === 1 ? "" : "s"} approved` : "Goals approved");
      afterDecision(result.rows.some((r) => r.changed && r.decision === "pending"));
    } catch (e) {
      toast.error(e, "Could not approve");
    }
  };

  /** Returns to the manager with the remarks confirmed in the dialog. */
  const onReturn = async (text: string) => {
    try {
      const result = await returnGoals(body(text)).unwrap();
      setReturnOpen(false);
      toast.success(isRevision ? "Selected KRAs returned to the manager" : "Goals returned to the manager");
      afterDecision(result.rows.some((r) => r.changed && r.decision === "pending"));
    } catch (e) {
      toast.error(e, "Could not return");
    }
  };

  const changedCount = data.rows.filter((r) => r.changed).length;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={isRevision ? "Review Target Revision" : "Review & Approve Goals"}
        subtitle={
          isRevision
            ? "Tick the KRAs you want to act on, then approve them or return them to the manager"
            : "Review the goal sheet, then approve it or return it to the manager"
        }
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={back}>Goal Approvals</Button>
            <Button variant="outline" disabled={position <= 0} onClick={() => goTo(position - 1)}>
              ← Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              {position >= 0 ? `${position + 1} of ${queue.length}` : "—"}
            </span>
            <Button variant="outline" disabled={position < 0 || position >= queue.length - 1} onClick={() => goTo(position + 1)}>
              Next →
            </Button>
          </div>
        }
      />

      <PmsTableCard>
        <div className="grid gap-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Employee</p>
            <p className="font-semibold text-foreground">{data.employee_name} ({data.emp_code})</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Role</p>
            <p className="font-semibold text-foreground">{data.designation_name || "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Manager</p>
            <p className="font-semibold text-foreground">{data.manager_name || "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Request</p>
            <p className="flex items-center gap-2 font-semibold text-foreground">
              <RequestBadge type={requestType} /> FY {data.financial_year}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-x-8 gap-y-1">
            <p>
              <span className="text-xs text-amber-800">Asked by</span>
              <br />
              <strong>{data.asked_by_name || "—"}</strong> (<RoleLabel role={data.asked_by_role} />){data.asked_on ? ` · ${formatDisplayDate(data.asked_on)}` : ""}
            </p>
            <p>
              <span className="text-xs text-amber-800">Changes asked</span>
              <br />
              {changedCount === 0
                ? "No KRA changed after the employee review."
                : `${changedCount} KRA${changedCount === 1 ? "" : "s"}. The reason for each is in the table.`}
            </p>
            {data.revision_rounds > 0 && (
              <p>
                <span className="text-xs text-amber-800">Revision</span>
                <br />
                {data.revision_rounds} round{data.revision_rounds === 1 ? "" : "s"} so far
              </p>
            )}
          </div>
          <button
            type="button"
            className="text-sm font-medium text-primary hover:underline"
            onClick={() => navigate({ to: HOD_TRAIL_PATH, params: { fy, employeeUserId } })}
          >
            View full history →
          </button>
        </div>

        {(data.employee_request || data.manager_reply) && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {data.employee_request && (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Employee&apos;s change request
                </p>
                <p className="mt-1 text-foreground">&ldquo;{data.employee_request}&rdquo;</p>
              </div>
            )}
            {data.manager_reply && (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Manager&apos;s reply
                </p>
                <p className="mt-1 text-foreground">&ldquo;{data.manager_reply}&rdquo;</p>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex items-end justify-between">
          <h2 className="text-base font-semibold text-foreground">
            {isRevision ? "Changed KRAs / KPIs" : "Goals and targets"}
          </h2>
          <span className="text-xs text-amber-700">
            {changedCount} of {data.rows.length} KRAs changed
            {isRevision ? ` · ${targets.length} selected` : ""}
          </span>
        </div>

        <div className="mt-2 overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className={PMS_HEADER_ROW}>
                {isRevision && (
                  <PmsTh className="w-10">
                    <Checkbox
                      checked={waiting.length > 0 && picked.size === waiting.length}
                      onCheckedChange={toggleAll}
                      disabled={waiting.length === 0}
                      aria-label="Select all changed KRAs"
                    />
                  </PmsTh>
                )}
                <PmsTh>KRA / KPI</PmsTh>
                <PmsTh>Weight %</PmsTh>
                <PmsTh>Unit</PmsTh>
                <PmsTh>{isRevision ? "Approved now" : "Original"}</PmsTh>
                <PmsTh>{isRevision ? "Requested" : "Final target"}</PmsTh>
                <PmsTh>Change</PmsTh>
                <PmsTh>Reason</PmsTh>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const tickable = isRevision && r.changed && r.decision === "pending";
                return (
                  <tr
                    key={r.kpi_id}
                    className={`border-t ${picked.has(r.kpi_id) ? "bg-primary/5" : r.changed ? "bg-amber-50" : ""}`}
                  >
                    {isRevision && (
                      <td className="px-4 py-3">
                        <Checkbox
                          checked={picked.has(r.kpi_id)}
                          disabled={!tickable}
                          onCheckedChange={() => toggle(r.kpi_id)}
                          aria-label={`Select ${r.kpi_name}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <p className="text-xs text-muted-foreground">{r.kra_name}</p>
                      <p className={r.changed ? "font-semibold text-foreground" : "text-muted-foreground"}>
                        {r.kpi_name}
                      </p>
                    </td>
                    <td className="px-4 py-3">{hodNumber(r.weight)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.unit || "—"}</td>
                    <td className={`px-4 py-3 ${r.changed ? "text-muted-foreground line-through" : ""}`}>
                      {hodNumber(r.approved_now)}
                    </td>
                    <td className="px-4 py-3 font-semibold text-foreground">{hodNumber(r.requested)}</td>
                    <td className="px-4 py-3">
                      {r.changed ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                          {hodDelta(r.change, r.change_percent)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No change</span>
                      )}
                      {r.decision === "approved" && <p className="mt-1 text-xs text-emerald-700">Approved</p>}
                      {r.decision === "returned" && <p className="mt-1 text-xs text-destructive">Returned</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.reason || "—"}</td>
                  </tr>
                );
              })}
              <tr className="border-t bg-muted/40 font-semibold">
                <td className="px-4 py-3" colSpan={isRevision ? 2 : 1}>Total weight</td>
                <td className="px-4 py-3">{hodNumber(data.total_weight)}</td>
                <td colSpan={5} />
              </tr>
            </tbody>
          </table>
        </div>
        {isRevision && (
          <p className="mt-2 text-xs text-muted-foreground">
            Approve and Return apply only to the ticked KRAs. KRAs you leave unticked stay waiting for your decision.
            KRAs with no change cannot be ticked.
          </p>
        )}

        <div className="mt-6 space-y-1.5 border-t pt-4">
          <label htmlFor="hod-remarks" className="text-sm font-medium text-foreground">
            HOD remarks {isRevision ? "for the selected KRAs " : ""}
            <span className="font-normal text-muted-foreground">(optional to approve, required to return)</span>
          </label>
          <textarea
            id="hod-remarks"
            rows={3}
            maxLength={HOD_REMARKS_MAX + 50}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={remarks}
            disabled={decided}
            onChange={(e) => setRemarks(e.target.value)}
          />
          <p className={`text-right text-xs ${remarksTooLong ? "text-destructive" : "text-muted-foreground"}`}>
            {remarks.length} / {HOD_REMARKS_MAX}
          </p>
        </div>

        {decided ? (
          <p className="mt-4 rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            This request is not waiting for your decision.
          </p>
        ) : (
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-red-200 bg-red-50/40 p-4">
              <p className="font-semibold text-red-700">
                {isRevision ? `Return selected to Manager (${targets.length})` : "Return to Manager"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.manager_name || "The manager"} gets your remarks, changes the targets and sends them to you
                again. They stay at the approved numbers until then.
              </p>
              <Button
                variant="outline"
                className="mt-3 border-destructive text-destructive"
                disabled={!canAct || busy}
                onClick={() => setReturnOpen(true)}
              >
                {isRevision ? `Return selected (${targets.length})` : "Return to Manager"}
              </Button>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
              <p className="font-semibold text-emerald-700">
                {isRevision ? `Approve selected (${targets.length})` : "Approve"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.employee_name} acknowledges the new targets for {isRevision ? "these KRAs" : "this sheet"}.
                {isRevision ? "" : " Approving freezes the goals and opens progress tracking."}
              </p>
              <Button
                className="mt-3 bg-emerald-600 hover:bg-emerald-700"
                disabled={!canAct || busy}
                onClick={onApprove}
              >
                {approving ? "Approving…" : isRevision ? `Approve selected (${targets.length})` : "Approve"}
              </Button>
            </div>
          </div>
        )}
      </PmsTableCard>

      <ReturnToManagerDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        employeeName={data.employee_name}
        managerName={data.manager_name ?? ""}
        kraNames={targets.map((r) => r.kpi_name)}
        initialRemarks={remarks}
        busy={returning}
        onConfirm={onReturn}
      />
    </div>
  );
};

/** Screen 5.3: a goal sheet is reviewed whole; a target revision is approved or returned KRA by KRA. */
const GoalReviewPage = () => {
  const { requestType = "goal_sheet" } = useParams({ strict: false }) as { requestType?: PmsHodRequestType };
  return requestType === "target_revision" ? <TargetRevisionReview /> : <GoalSheetReview />;
};

export default GoalReviewPage;
