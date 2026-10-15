import { useEffect } from "react";
import { Loader2, UserX, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEligibilityPreview } from "./useEligibilityPreview";
import { usePmsDepartments, usePmsPlants } from "../../shared/usePmsLookups";
import type { PmsCycleApplicability } from "@/types/pms";
import { EMPLOYMENT_TYPE_LABEL } from "../cycle.constants";

/** Props for the preview dialog. */
interface EligibleEmployeesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rules currently in the form; sent to the preview endpoint when the dialog opens. */
  applicability: PmsCycleApplicability;
}

/** Employment type value to display label. */
const TYPE_LABEL = EMPLOYMENT_TYPE_LABEL;

/**
 * "Show Eligible Employees Preview": asks the API who would get goals and who would be rated with the
 * current rules, and lists them. The call is made once, when the dialog opens.
 */
export function EligibleEmployeesDialog({
  open,
  onOpenChange,
  applicability,
}: EligibleEmployeesDialogProps) {
  // Plant and department names for the ids the API returns.
  const { data: plants } = usePmsPlants();
  const { data: departments } = usePmsDepartments();
  const plantName = (id?: string) => plants.find((p) => p.id === id)?.name ?? "—";
  const departmentName = (id?: string) => departments.find((d) => d.id === id)?.name ?? "—";
  // The employees are read from IAM and the rules applied here: fired on open, cleared on close.
  const { run: preview, reset, data, isLoading, isError } = useEligibilityPreview();

  useEffect(() => {
    if (open) preview(applicability);
    else reset();
    // Re-run only when the dialog opens; edits made while it is open are not
    // reflected until it is reopened, which matches how a preview is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // "Excluded: notice period . N" chips, only for reasons that excluded someone.
  const excluded = data
    ? [
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
                  <p className="mt-1 text-xs text-muted-foreground">get goals</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl bg-muted px-4 py-2.5">
                <div>
                  <p className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                    {data.total_rated}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">are rated</p>
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
                    {["Code", "Name", "Department", "Plant", "Type", "Service", "Rated"].map((h) => (
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
                      <td className="px-3 py-2 text-muted-foreground">
                        {emp.department ?? departmentName(emp.department_id)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {emp.plant ?? plantName(emp.plant_id)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {TYPE_LABEL[emp.employment_type]}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {emp.service_months} mo
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {emp.is_rated ? "Yes" : "Goals only"}
                      </td>
                    </tr>
                  ))}
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
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
