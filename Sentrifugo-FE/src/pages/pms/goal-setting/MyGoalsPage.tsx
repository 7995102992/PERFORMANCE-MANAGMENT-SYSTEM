import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Bell, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  useAcknowledgeMyGoalsMutation,
  useGetPmsMyChangeRequestsQuery,
  useGetPmsMyGoalsQuery,
  useRequestGoalChangeMutation,
} from "@/store/api/pmsApi";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatDisplayDate } from "../shared/pms.utils";
import { StageWindowBanner } from "../shared/StageWindowBanner";
import { formatNumber } from "../shared/validation";

/** Goal statuses in which the manager has not sent the goals to the employee yet. */
const NOT_SENT = ["not_started", "draft"];

/** Banner text for goal statuses where the employee has nothing to do. */
const STATUS_NOTE: Record<string, string> = {
  acknowledged: "You have acknowledged these goals. Waiting for HOD approval.",
  approved: "Your goals are approved by the HOD.",
  change_requested: "Your change request is with your manager.",
  draft: "Your manager is still preparing these goals.",
};

/**
 * Screens 4.1 - 4.3 and 4.5: the employee reviews their goals, then acknowledges them or asks for a change.
 * When the HOD has approved a target revision, the same page shows the revised target to acknowledge.
 */
const MyGoalsPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const navigate = useNavigate();
  const financialYear = fyToApi(Number(fy));
  const { data, isLoading, isError, error } = useGetPmsMyGoalsQuery(financialYear);
  // Every change request the employee has made, with the manager's answer (kept permanently).
  const { data: requests = [] } = useGetPmsMyChangeRequestsQuery(financialYear);
  const [acknowledge, { isLoading: acking }] = useAcknowledgeMyGoalsMutation();
  const [requestChange, { isLoading: requesting }] = useRequestGoalChangeMutation();

  // Dialog visibility and the Request Change / Acknowledge form values.
  const [changeOpen, setChangeOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [kpiId, setKpiId] = useState("");
  const [proposed, setProposed] = useState("");
  const [reason, setReason] = useState("");
  const [agreed, setAgreed] = useState(true);
  const [comment, setComment] = useState("");

  // Financial-year dropdown shown in the header; changing it opens the same page for that year.
  const yearTag = (
    <FinancialYearTag fy={fy} onChange={(next) => navigate({ to: "/pms/my-goals/$fy", params: { fy: next } })} />
  );

  if (isLoading) return <PageLoader message="Loading your goals…" />;
  if (isError || !data) {
    const notSet = (error as { data?: { code?: string } } | undefined)?.data?.code === "PMS_GOALS_NOT_FOUND";
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="My Goals" subtitle="Review the targets assigned by your manager" action={yearTag} />
        <StageWindowBanner stage="employee_acknowledgement" financialYear={financialYear} />
        <p className="text-sm text-muted-foreground">
          {notSet ? "Your manager has not set goals for this year yet." : "Could not load your goals."}
        </p>
      </div>
    );
  }

  // The manager has not sent the goals yet: nothing to review.
  if (NOT_SENT.includes(data.goal_status)) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="My Goals" subtitle="Review the targets assigned by your manager" action={yearTag} />
        <StageWindowBanner stage="employee_acknowledgement" financialYear={financialYear} />
        <p className="text-sm text-muted-foreground">Your manager has not sent your goals for this year yet.</p>
      </div>
    );
  }

  // Target revision awaiting acknowledgement (4.5), its KPI, whether the buttons show, and the revised count.
  const revision = data.revision ?? null;
  const revisedKpi = revision ? data.kpis.find((k) => k.kpi_id === revision.kpi_id) : null;
  const canRespond = data.goal_status === "sent_to_employee" || !!revision;
  const revisedCount = data.kpis.filter((k) => k.revised_target != null).length;
  // The Revised target column stays once a KPI has been revised (the original target never changes).
  const showRevisedColumn = !!revision || revisedCount > 0;
  // The Revisions column (how many change requests per KPI) shows once any KPI has been questioned.
  const showCountColumn = showRevisedColumn || data.kpis.some((k) => (k.revision_count ?? 0) > 0);
  // What the employee reported in Update Progress: its own column, never mixed into Target / Revised target.
  const showUpdatedColumn = data.kpis.some((k) => k.employee_actual != null);
  // A manager revising after the employee's change request, as opposed to an HOD-approved mid-year revision.
  const managerRevised = revision?.source === "manager_revised";
  const revisedNames = data.kpis.filter((k) => k.revised_target != null).map((k) => k.kpi_name).join(", ");
  const acknowledgeNote = revision?.acknowledge_by
    ? ` Review the revised target and acknowledge by ${formatDisplayDate(revision.acknowledge_by)}.`
    : " Review the revised target and acknowledge it.";

  /** Opens Request Change with the revised KRA pre-selected when there is one. */
  const openChange = () => {
    setKpiId(revision?.kpi_id ?? data.kpis[0]?.kpi_id ?? "");
    setProposed("");
    setReason("");
    setChangeOpen(true);
  };

  /** Validates a KRA and reason, then sends the change request to the manager. */
  const submitChange = async () => {
    const n = proposed.trim() === "" ? null : Number(proposed);
    if (!kpiId || !reason.trim()) {
      toast.error("Choose a KRA and give a reason");
      return;
    }
    if (n !== null && (!Number.isFinite(n) || n < 0)) {
      toast.error("Proposed target must be a number");
      return;
    }
    try {
      await requestChange({ financial_year: financialYear, kpi_id: kpiId, proposed_target: n, reason: reason.trim() })
        .unwrap();
      setChangeOpen(false);
      toast.success("Change request sent to your manager");
    } catch (e) {
      toast.error(e, "Could not send the request");
    }
  };

  /** Acknowledges the goals (or the revised target) with an optional comment. */
  const submitAck = async () => {
    try {
      await acknowledge({ financial_year: financialYear, comment: comment.trim() || undefined }).unwrap();
      setAckOpen(false);
      setComment("");
      toast.success(revision ? "Revised target acknowledged" : "Goals acknowledged");
    } catch (e) {
      toast.error(e, "Could not acknowledge the goals");
    }
  };

  // Blue banner text: who sent the goals and the respond-by date, or a status note.
  const sentBanner =
    data.goal_status === "sent_to_employee" && data.manager_name
      ? `Goals sent by ${data.manager_name}${data.sent_on ? ` on ${formatDisplayDate(data.sent_on)}` : ""}${
          data.acknowledge_by ? ` · Respond by ${formatDisplayDate(data.acknowledge_by)}` : ""
        }`
      : (STATUS_NOTE[data.goal_status] ?? "");

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="My Goals"
        subtitle={
          revision
            ? managerRevised
              ? "Your manager has revised your targets after your change request"
              : "Your manager's target revision has been approved by the HOD"
            : canRespond
              ? "Review the targets assigned by your manager"
              : "The targets assigned by your manager"
        }
        action={
          <div className="flex items-center gap-3">
            {revision && (
              <span className="inline-flex items-center gap-1.5 text-sm text-primary">
                <RefreshCw className="h-4 w-4" /> Target revised
              </span>
            )}
            {yearTag}
          </div>
        }
      />

      <StageWindowBanner stage="employee_acknowledgement" financialYear={financialYear} />

      <PmsTableCard>
        {revision && revisedKpi ? (
          <div className="mb-4 flex items-start gap-2 rounded-md bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-300">
            <Bell className="mt-0.5 h-4 w-4 shrink-0" />
            {managerRevised ? (
              <p>
                <strong>Target revised:</strong> {revision.approved_by} revised <strong>{revisedNames}</strong> after
                your change request on {formatDisplayDate(revision.approved_on)}. Reason: {revision.reason}.
                {acknowledgeNote}
              </p>
            ) : (
              <p>
                <strong>Target revised:</strong> your manager&apos;s revision request for{" "}
                <strong>{revisedKpi.kpi_name}</strong> was approved by {revision.approved_by} on{" "}
                {formatDisplayDate(revision.approved_on)}. Reason: {revision.reason}.{acknowledgeNote}
              </p>
            )}
          </div>
        ) : (
          sentBanner && (
            <div className="mb-4 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{sentBanner}</p>
            </div>
          )
        )}

        {data.hod_remarks && data.goal_status === "draft" && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            HOD remarks: {data.hod_remarks}
          </div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA / KPI</PmsTh>
              <PmsTh>Weight %</PmsTh>
              <PmsTh>Target</PmsTh>
              {showRevisedColumn && <PmsTh>Revised target</PmsTh>}
              {showCountColumn && <PmsTh>Revisions</PmsTh>}
              {showUpdatedColumn && <PmsTh>Updated by employee</PmsTh>}
              <PmsTh>Unit</PmsTh>
              <PmsTh>Evidence</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.kpis.map((k) => {
              const revised = k.revised_target != null;
              return (
                <tr key={k.kpi_id} className={`border-t ${revised ? "bg-primary/5" : ""}`}>
                  <td className="px-4 py-3 text-foreground">{k.kpi_name}</td>
                  <td className="px-4 py-3">{k.weight}</td>
                  <td className="px-4 py-3">
                    {formatNumber(k.original_target ?? k.previous_target ?? k.target)}
                  </td>
                  {showRevisedColumn && (
                    <td className="px-4 py-3">
                      {revised ? (
                        <span className="font-semibold text-primary">
                          {formatNumber(k.revised_target)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No change</span>
                      )}
                    </td>
                  )}
                  {showCountColumn && (
                    <td className="px-4 py-3 text-foreground">{(k.revision_count ?? 0) > 0 ? k.revision_count : "—"}</td>
                  )}
                  {showUpdatedColumn && (
                    <td className="px-4 py-3">
                      {k.employee_actual != null ? (
                        <span className="font-semibold text-foreground">
                          {formatNumber(k.employee_actual)}
                          {k.progress_status && (
                            <span
                              className={`ml-2 text-xs font-normal ${
                                k.progress_status === "on_track" ? "text-emerald-600" : "text-amber-600"
                              }`}
                            >
                              {k.progress_status.replace(/_/g, " ")}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                  <td className="px-4 py-3 text-muted-foreground">{k.evidence_required || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {showRevisedColumn && (
          <p className="mt-3 text-xs text-muted-foreground">
            {revisedCount} of {data.kpis.length} targets revised · Year-end appraisal will be measured against the
            revised target.
          </p>
        )}

        {requests.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-sm font-semibold text-foreground">Your change requests</p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="bg-table-header text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2.5">KPI</th>
                    <th className="px-3 py-2.5">#</th>
                    <th className="px-3 py-2.5">Requested</th>
                    <th className="px-3 py-2.5">Reason</th>
                    <th className="px-3 py-2.5">Proposed</th>
                    <th className="px-3 py-2.5">Manager&apos;s answer</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={`${r.kpi_id}-${r.revision_no}`} className="border-t align-top">
                      <td className="px-3 py-2.5 font-medium text-foreground">{r.kpi_name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.revision_no}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{formatDisplayDate(r.requested_on.slice(0, 10))}</td>
                      <td className="px-3 py-2.5 text-foreground">{r.reason}</td>
                      <td className="px-3 py-2.5 text-foreground">{formatNumber(r.proposed_target)}</td>
                      <td className="px-3 py-2.5">
                        {r.status === "requested" ? (
                          <span className="text-amber-600">Waiting for your manager</span>
                        ) : r.decision === "revised" ? (
                          <span className="text-foreground">
                            Revised to <strong>{formatNumber(r.final_target)}</strong>
                            {r.manager_remarks ? ` · ${r.manager_remarks}` : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Target kept{r.manager_remarks ? ` · ${r.manager_remarks}` : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {canRespond && (
          <div className="mt-4 flex justify-end gap-2 border-t pt-4">
            <Button variant="outline" className="border-destructive text-destructive" onClick={openChange}>
              {revision ? "Request for Change" : "Request Change"}
            </Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setAckOpen(true)}>
              Acknowledge
            </Button>
          </div>
        )}
      </PmsTableCard>

      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Change</DialogTitle>
            <DialogDescription>Ask your manager to revise one target.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>KRA</Label>
              <Select value={kpiId} onValueChange={setKpiId}>
                <SelectTrigger aria-label="KRA">
                  <SelectValue placeholder="Choose a KRA" />
                </SelectTrigger>
                <SelectContent>
                  {data.kpis.map((k) => (
                    <SelectItem key={k.kpi_id} value={k.kpi_id}>
                      {k.kpi_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chg-target">Proposed Target</Label>
              <Input id="chg-target" inputMode="decimal" value={proposed} onChange={(e) => setProposed(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chg-reason">
                Reason <span className="text-destructive">*</span>
              </Label>
              <textarea
                id="chg-reason"
                rows={3}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangeOpen(false)} disabled={requesting}>
              Cancel
            </Button>
            <Button onClick={submitChange} disabled={requesting}>
              {requesting ? "Sending…" : "Submit Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ackOpen} onOpenChange={setAckOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge Goals</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} aria-label="Acknowledge" />I
              have reviewed and acknowledge my goals for FY {financialYear}.
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="ack-comment">Comments (optional)</Label>
              <textarea
                id="ack-comment"
                rows={3}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Once you acknowledge, your goals go back to your manager, who sends them to the HOD for approval.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAckOpen(false)} disabled={acking}>
              Cancel
            </Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={submitAck} disabled={acking || !agreed}>
              {acking ? "Submitting…" : "Acknowledge & Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MyGoalsPage;
