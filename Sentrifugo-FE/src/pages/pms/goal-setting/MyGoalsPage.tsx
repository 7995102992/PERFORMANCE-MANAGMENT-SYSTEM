import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  useGetPmsMyGoalsQuery,
  useRequestGoalChangeMutation,
} from "@/store/api/pmsApi";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";

/** Screens 4.1 - 4.3: the employee reviews their goals, then acknowledges them or asks for a change. */
const MyGoalsPage = () => {
  const { fy = "" } = useParams({ strict: false }) as { fy?: string };
  const financialYear = fyToApi(Number(fy));
  const { data, isLoading, isError, error } = useGetPmsMyGoalsQuery(financialYear);
  const [acknowledge, { isLoading: acking }] = useAcknowledgeMyGoalsMutation();
  const [requestChange, { isLoading: requesting }] = useRequestGoalChangeMutation();

  const [changeOpen, setChangeOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [kpiId, setKpiId] = useState("");
  const [proposed, setProposed] = useState("");
  const [reason, setReason] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [comment, setComment] = useState("");

  if (isLoading) return <PageLoader message="Loading your goals…" />;
  if (isError || !data) {
    const notSet = (error as { data?: { code?: string } } | undefined)?.data?.code === "PMS_GOALS_NOT_FOUND";
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="My Goals" subtitle="Review the targets assigned by your manager" />
        <p className="text-sm text-muted-foreground">
          {notSet ? "Your manager has not set goals for this year yet." : "Could not load your goals."}
        </p>
      </div>
    );
  }

  const canRespond = data.goal_status === "sent_to_employee";
  const sentOn = data.goal_status !== "not_started" ? "Goals are with you for review" : "";

  const submitChange = async () => {
    if (!kpiId || !reason.trim()) {
      toast.error("Choose a target and give a reason");
      return;
    }
    try {
      await requestChange({
        financial_year: financialYear,
        kpi_id: kpiId,
        proposed_target: proposed.trim() === "" ? null : Number(proposed),
        reason: reason.trim(),
      }).unwrap();
      setChangeOpen(false);
      toast.success("Change request sent to your manager");
    } catch (e) {
      toast.error(e, "Could not send the request");
    }
  };

  const submitAck = async () => {
    try {
      await acknowledge({ financial_year: financialYear, comment: comment.trim() || undefined }).unwrap();
      setAckOpen(false);
      toast.success("Goals acknowledged");
    } catch (e) {
      toast.error(e, "Could not acknowledge the goals");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="My Goals" subtitle="Review the targets assigned by your manager" />

      {sentOn && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-foreground">
          {data.goal_status === "acknowledged" && "You have acknowledged these goals. Waiting for HOD approval."}
          {data.goal_status === "approved" && "Your goals are approved by the HOD."}
          {data.goal_status === "change_requested" && "Your change request is with your manager."}
          {data.goal_status === "sent_to_employee" && "Goals sent by your manager. Please review and respond."}
          {data.goal_status === "draft" && "Your manager is still preparing these goals."}
        </div>
      )}

      {data.hod_remarks && data.goal_status === "draft" && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          HOD remarks: {data.hod_remarks}
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
                <td className="px-4 py-3 text-muted-foreground">{k.evidence_required || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {canRespond && (
          <div className="mt-6 flex justify-end gap-2 border-t pt-4">
            <Button variant="outline" className="border-destructive text-destructive" onClick={() => setChangeOpen(true)}>
              Request Change
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
              <Label htmlFor="chg-kpi">Target</Label>
              <select
                id="chg-kpi"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={kpiId}
                onChange={(e) => setKpiId(e.target.value)}
              >
                <option value="">Choose a KPI</option>
                {data.kpis.map((k) => (
                  <option key={k.kpi_id} value={k.kpi_id}>
                    {k.kpi_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chg-target">Proposed target</Label>
              <Input id="chg-target" inputMode="decimal" value={proposed} onChange={(e) => setProposed(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chg-reason">Reason</Label>
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
              <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} aria-label="Acknowledge" />
              I have reviewed and acknowledge my goals for FY {financialYear}.
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAckOpen(false)} disabled={acking}>
              Cancel
            </Button>
            <Button onClick={submitAck} disabled={acking || !agreed}>
              {acking ? "Submitting…" : "Acknowledge & Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MyGoalsPage;
