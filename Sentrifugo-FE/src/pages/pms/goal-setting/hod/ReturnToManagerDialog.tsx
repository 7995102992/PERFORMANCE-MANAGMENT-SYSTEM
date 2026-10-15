import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HOD_REMARKS_MAX } from "./hod.utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeName: string;
  managerName: string;
  /** KRAs being returned; empty when the whole goal sheet goes back. */
  kraNames: string[];
  /** Remarks typed on the review screen, used as the starting text. */
  initialRemarks: string;
  busy: boolean;
  /** Called with trimmed remarks once they pass validation. */
  onConfirm: (remarks: string) => void;
}

/** The form inside the dialog; it mounts each time the dialog opens, so it always starts fresh. */
const ReturnForm = ({
  onOpenChange,
  employeeName,
  managerName,
  kraNames,
  initialRemarks,
  busy,
  onConfirm,
}: Omit<Props, "open">) => {
  const [remarks, setRemarks] = useState(initialRemarks);
  const [touched, setTouched] = useState(false);

  const trimmed = remarks.trim();
  const error = trimmed.length === 0 ? "Remarks are required to return to the manager" : null;
  const manager = managerName || "the manager";
  const kras = kraNames.length;

  /** Confirms only when the remarks are valid. */
  const submit = () => {
    setTouched(true);
    if (error) return;
    onConfirm(trimmed);
  };

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Return to Manager</DialogTitle>
        <DialogDescription>
          {employeeName} · Manager: {manager}
          {kras > 0 ? ` · Returning ${kras} KRA${kras === 1 ? "" : "s"}: ${kraNames.join(", ")}` : ""}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <label htmlFor="return-remarks" className="text-sm font-medium text-foreground">
          HOD remarks for the manager <span className="text-destructive">*</span>
        </label>
        <textarea
          id="return-remarks"
          rows={4}
          maxLength={HOD_REMARKS_MAX}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          aria-invalid={touched && !!error}
        />
        <div className="flex justify-between text-xs">
          <span className="text-destructive">{touched && error ? error : ""}</span>
          <span className="text-muted-foreground">
            {remarks.length} / {HOD_REMARKS_MAX}
          </span>
        </div>
      </div>

      <div className="rounded-md bg-muted/50 p-3 text-sm">
        <p className="font-semibold text-foreground">What happens next</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>{manager} is notified with your remarks. The request shows &ldquo;Returned by HOD&rdquo;.</li>
          <li>
            {kras > 0
              ? "The KRAs you did not select stay waiting for your decision."
              : "The goal sheet stays as it was until a revised sheet is approved."}
          </li>
          <li>The manager revises the targets and sends them to you again.</li>
        </ol>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={submit} disabled={busy}>
          {busy ? "Returning…" : "Return to Manager"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};

/** "Return to Manager": remarks are mandatory and capped at 500 characters. */
const ReturnToManagerDialog = ({ open, ...rest }: Props) => (
  <Dialog open={open} onOpenChange={rest.onOpenChange}>
    {open && <ReturnForm {...rest} />}
  </Dialog>
);

export default ReturnToManagerDialog;
