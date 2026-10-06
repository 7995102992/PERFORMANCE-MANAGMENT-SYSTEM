import { useEffect } from "react";
import { Loader2, UserX, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePreviewEligibleEmployeesMutation } from "@/store/api/pmsApi";
import type { PmsCycleApplicability } from "@/types/pms";
import { EMPLOYMENT_TYPE_OPTIONS } from "../cycle.constants";

interface EligibleEmployeesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicability: PmsCycleApplicability;
}

const TYPE_LABEL = Object.fromEntries(
  EMPLOYMENT_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

export function EligibleEmployeesDialog({
  open,
  onOpenChange,
  applicability,
}: EligibleEmployeesDialogProps) {
  const [preview, { data, isLoading, isError, reset }] =
    usePreviewEligibleEmployeesMutation();

  useEffect(() => {
    if (open) preview(applicability);
    else reset();
    // Re-run only when the dialog opens; edits made while it is open are not
    // reflected until it is reopened, which matches how a preview is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const excluded = data
    ? [
        ["Probation", data.excluded_probation],
        ["Notice period", data.excluded_notice_period],
        ["Below min. service", data.excluded_min_service],
      ].filter(([, n]) => Number(n) > 0)
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Eligible Employees Preview</DialogTitle>
          <DialogDescription>
            Who would be covered by this cycle with the current rules.
          </DialogDescription>
        </DialogHeader>

        {isLoading || (!data && !isError) ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking eligibility…
          </div>
        ) : isError || !data ? (
          <p className="py-10 text-center text-sm text-destructive">
            Couldn&apos;t load the preview. Close this and try again.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 rounded-xl bg-primary/10 px-4 py-2.5">
                <Users className="size-5 text-primary" />
                <div>
                  <p className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                    {data.total_eligible}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">eligible employees</p>
                </div>
              </div>
              {excluded.length > 0 && (
                <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <UserX className="size-4" />
                  Excluded:
                  {excluded.map(([label, n]) => (
                    <span key={label} className="rounded-full bg-muted px-2 py-0.5">
                      {label} · {n}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="max-h-[28rem] overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-table-header text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {["Code", "Name", "Department", "Plant", "Type", "Service"].map((h) => (
                      <th key={h} className="px-3 py-2">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((emp) => (
                    <tr key={emp.employee_id} className="border-t">
                      <td className="px-3 py-2 text-muted-foreground">{emp.employee_code}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{emp.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{emp.department}</td>
                      <td className="px-3 py-2 text-muted-foreground">{emp.plant}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {TYPE_LABEL[emp.employment_type]}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {emp.service_months} mo
                      </td>
                    </tr>
                  ))}
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                        No employees match these rules.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {data.total_eligible > data.items.length && (
              <p className="text-xs text-muted-foreground">
                Showing the first {data.items.length} of {data.total_eligible}.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
