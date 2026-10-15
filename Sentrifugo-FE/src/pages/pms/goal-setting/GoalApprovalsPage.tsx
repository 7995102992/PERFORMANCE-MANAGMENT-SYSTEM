import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCircle2, Clock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsHodQueueQuery, useHodApproveSelectedMutation } from "@/store/api/pmsApi";
import type { PmsHodQueueItem } from "@/types/pms-goals";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { StageWindowBanner } from "../shared/StageWindowBanner";
import { HOD_HISTORY_PATH, HOD_REVIEW_PATH } from "./hod/hod.utils";

/** Row key: one employee can have a goal sheet and a target revision waiting at the same time. */
const keyOf = (i: PmsHodQueueItem) => `${i.employee_user_id}|${i.request_type}`;

/**
 * HOD Goal Approvals: the goal sheets and target revisions the Section Heads sent. The grid lists employee, role,
 * Section Head, request type and status, with a Review button on each row; ticked rows are approved together.
 */
const GoalApprovalsPage = () => {
  // Route param `fy` is the financial-year start (2026); the API wants "2026-27".
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));

  const { data: items = [], isLoading, isError } = useGetPmsHodQueueQuery(financialYear);
  const [approveSelected, { isLoading: approving }] = useHodApproveSelectedMutation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sheets = items.filter((i) => i.request_type === "goal_sheet").length;
  const revisions = items.length - sheets;
  // Only rows still in the list can be selected; a stale key is ignored.
  const picked = items.filter((i) => selected.has(keyOf(i)));
  const allPicked = items.length > 0 && picked.length === items.length;

  if (isLoading) return <PageLoader message="Loading approvals…" />;

  /** Ticks or unticks one row. */
  const toggle = (item: PmsHodQueueItem) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** Ticks or unticks every row. */
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(items.map(keyOf)));

  /** Opens the review screen of one request (goal sheets and target revisions share it). */
  const open = (item: PmsHodQueueItem) =>
    navigate({
      to: HOD_REVIEW_PATH,
      params: { fy, requestType: item.request_type, employeeUserId: item.employee_user_id },
    });

  /** Approves every ticked request; failures are listed and stay in the queue. */
  const onApproveSelected = async () => {
    if (picked.length === 0) return;
    try {
      const result = await approveSelected({
        financial_year: financialYear,
        items: picked.map((i) => ({ employee_user_id: i.employee_user_id, request_type: i.request_type })),
      }).unwrap();
      setSelected(new Set());
      if (result.failed === 0) {
        toast.success(`${result.approved} approved`);
      } else {
        const failures = result.results.filter((r) => !r.success).map((r) => `${r.employee_name}: ${r.message}`);
        toast.error(`${result.approved} approved, ${result.failed} failed. ${failures.join("; ")}`);
      }
    } catch (e) {
      toast.error(e, "Could not approve the selected requests");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Goal Approvals"
        subtitle="Goal sheets and target revisions sent by your Section Heads"
        action={
          <div className="flex items-center gap-3">
            <span className="rounded-md border bg-card px-3 py-2 text-sm font-medium">FY {financialYear}</span>
            <Button variant="outline" onClick={() => navigate({ to: HOD_HISTORY_PATH, params: { fy } })}>
              Approval History
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={picked.length === 0 || approving}
              onClick={onApproveSelected}
            >
              <CheckCircle2 /> {approving ? "Approving…" : "Approve Selected"}
            </Button>
          </div>
        }
      />

      <StageWindowBanner stage="hod_approval" financialYear={financialYear} />

      <PmsTableCard>
        <p className="flex items-start gap-2 rounded-lg bg-primary/10 px-4 py-3 text-sm text-primary">
          <Info className="mt-0.5 size-4 shrink-0" />
          Goal sheets and target revision requests from your Section Heads arrive here. Goal sheets come after the
          employee acknowledges; target revisions come from the Mid-Year Review.
        </p>

        {isError && <p className="px-4 py-6 text-sm text-destructive">Could not load the approval list.</p>}
        {!isError && items.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing is waiting for your approval.</p>
        )}
        {items.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className={PMS_HEADER_ROW}>
                  <PmsTh className="w-12">
                    <Checkbox checked={allPicked} onCheckedChange={toggleAll} aria-label="Select all" />
                  </PmsTh>
                  <PmsTh>Employee</PmsTh>
                  <PmsTh>Role</PmsTh>
                  <PmsTh>Section Head</PmsTh>
                  <PmsTh>Request Type</PmsTh>
                  <PmsTh>Status</PmsTh>
                  <PmsTh>Actions</PmsTh>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const revision = i.request_type === "target_revision";
                  return (
                    <tr key={keyOf(i)} className={`border-t ${selected.has(keyOf(i)) ? "bg-primary/5" : ""}`}>
                      <td className="px-4 py-3.5">
                        <Checkbox
                          checked={selected.has(keyOf(i))}
                          onCheckedChange={() => toggle(i)}
                          aria-label={`Select ${i.employee_name}`}
                        />
                      </td>
                      <td className="px-4 py-3.5 text-foreground">{i.employee_name}</td>
                      <td className="px-4 py-3.5 text-foreground">{i.designation_name || "—"}</td>
                      <td className="px-4 py-3.5 text-foreground">{i.manager_name || "—"}</td>
                      <td className="px-4 py-3.5 text-foreground">{revision ? "Target revision" : "Goal sheet"}</td>
                      <td className="px-4 py-3.5">
                        {revision ? (
                          <span className="inline-flex items-center gap-1.5 text-foreground">
                            <Clock className="size-4 text-amber-500" /> Pending
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-foreground">
                            <CheckCircle2 className="size-4 text-emerald-600" /> Acknowledged
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <Button size="sm" onClick={() => open(i)}>
                          Review
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {items.length > 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            {picked.length} of {items.length} selected · {sheets} goal sheet{sheets === 1 ? "" : "s"}, {revisions}{" "}
            target revision{revisions === 1 ? "" : "s"} · Both open the same review screen.
          </p>
        )}
      </PmsTableCard>
    </div>
  );
};

export default GoalApprovalsPage;
