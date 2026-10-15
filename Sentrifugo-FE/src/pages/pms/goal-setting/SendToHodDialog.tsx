import { useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { useGetPmsEmployeeTargetsQuery, useSendGoalsToHodMutation } from "@/store/api/pmsApi";
import { formatNumber } from "../shared/validation";
import { HOD_NOTE_MAX, movedKras, sendToHodSchema, sheetProblems } from "./sendToHod.schema";

interface SendToHodDialogProps {
  /** The acknowledged employee whose sheet goes to the HOD; null keeps the dialog closed. */
  employee: { user_id: string; name: string; designation_name?: string | null } | null;
  /** Financial year in the API form, e.g. "2026-27". */
  financialYear: string;
  onClose: () => void;
}

/**
 * "Send to HOD" on My Team: shows the manager which KRAs moved since the targets were first assigned (what the
 * HOD will be asked to approve), takes an optional note, and sends the acknowledged sheet.
 */
export const SendToHodDialog = ({ employee, financialYear, onClose }: SendToHodDialogProps) => {
  const open = employee !== null;
  const { data, isFetching, isError } = useGetPmsEmployeeTargetsQuery(
    { employeeUserId: employee?.user_id ?? "", financialYear },
    { skip: !open },
  );
  const [send, { isLoading: sending }] = useSendGoalsToHodMutation();
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");

  const moved = data ? movedKras(data.kpis) : [];
  const problems = data ? sheetProblems(data.kpis) : [];
  // Only revised KRAs go to the HOD; a sheet with none has nothing for the HOD to decide and is approved.
  const noRevisions = !!data && moved.length === 0;

  const close = () => {
    setRemarks("");
    setError("");
    onClose();
  };

  /** Validates the note, then sends the sheet to the HOD. */
  const onSend = async () => {
    if (!employee) return;
    const parsed = sendToHodSchema.safeParse({ remarks });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    try {
      await send({
        financial_year: financialYear,
        employee_user_ids: [employee.user_id],
        ...(parsed.data.remarks ? { remarks: parsed.data.remarks } : {}),
      }).unwrap();
      toast.success(
        noRevisions ? `${employee.name}'s goals are approved` : `${employee.name}'s revised KRAs were sent to the HOD`,
      );
      close();
    } catch (e) {
      toast.error(e, "Could not send the goal sheet to the HOD");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !sending && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{noRevisions ? "Approve goals" : "Send to HOD"}</DialogTitle>
          <DialogDescription>
            {employee?.name}
            {employee?.designation_name ? ` · ${employee.designation_name}` : ""} acknowledged the goals.{" "}
            {noRevisions
              ? "No KRA was revised, so nothing needs the HOD."
              : "Only the revised KRAs below go to the HOD, who will approve them or return them to you with remarks."}
          </DialogDescription>
        </DialogHeader>

        {isFetching && <p className="text-sm text-muted-foreground">Loading the goal sheet…</p>}
        {isError && !isFetching && (
          <p className="text-sm text-destructive">Could not load the goal sheet. Close and try again.</p>
        )}

        {data && !isFetching && (
          <div className="space-y-4">
            {problems.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">This sheet is not ready for the HOD</p>
                  <ul className="list-disc pl-4">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-medium text-foreground">
                {moved.length > 0
                  ? `${moved.length} revised KRA${moved.length === 1 ? "" : "s"} will go to the HOD`
                  : "No KRA was revised after the targets were first assigned"}
              </p>
              {moved.length > 0 ? (
                <ul className="divide-y rounded-md border text-sm">
                  {moved.map((m) => (
                    <li key={m.kpi_id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-foreground">
                        {m.kpi_name}
                        {m.requests > 0 && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {m.requests} change request{m.requests === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                        {formatNumber(m.from)}
                        <ArrowRight className="h-3.5 w-3.5" />
                        <strong className="text-foreground">{formatNumber(m.to)}</strong> {m.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The targets stay as you assigned them and the goals are approved without the HOD.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hod-note">{noRevisions ? "Note (optional)" : "Note to the HOD (optional)"}</Label>
              <Textarea
                id="hod-note"
                rows={3}
                value={remarks}
                aria-invalid={!!error}
                placeholder="Anything the HOD should know before deciding"
                onChange={(e) => {
                  setRemarks(e.target.value);
                  setError("");
                }}
              />
              <div className="flex justify-between text-xs">
                <span className="text-destructive">{error}</span>
                <span className={remarks.length > HOD_NOTE_MAX ? "text-destructive" : "text-muted-foreground"}>
                  {remarks.length}/{HOD_NOTE_MAX}
                </span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={onSend} disabled={sending || isFetching || isError || !data || problems.length > 0}>
            {sending ? "Sending…" : noRevisions ? "Approve goals" : "Send to HOD"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
