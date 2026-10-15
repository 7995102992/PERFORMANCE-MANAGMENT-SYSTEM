import { useEffect } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGetPmsApprovalWorkflowsQuery, useGetPmsRatingScalesQuery } from "@/store/api/pmsApi";
import type { PmsCycleUpsert } from "@/types/pms";

/** The five "notify on publish" checkboxes, in the order of the mockup: form field name + label. */
const NOTIFY_FIELDS = [
  { name: "finalize.notify_employees", label: "Notify Employees" },
  { name: "finalize.notify_managers", label: "Notify Section Heads" },
  { name: "finalize.notify_hod", label: "Notify Functional Heads" },
  { name: "finalize.notify_hr", label: "Notify Plant Heads and Plant HR" },
  { name: "finalize.notify_gp", label: "Notify GP" },
] as const;

/**
 * Wizard step 4 (screen 1.5): the rating scale with its definitions on the left; Finalize Cycle on the right with
 * who is notified on publish and the approval workflow to use.
 */
export function RatingPublishStep() {
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  const { data: scales = [] } = useGetPmsRatingScalesQuery();
  const { data: workflows = [] } = useGetPmsApprovalWorkflowsQuery();
  const scaleId = useWatch({ control, name: "finalize.rating_scale_id" });
  const workflowId = useWatch({ control, name: "finalize.approval_workflow_id" });

  // Default to the first scale and workflow so a first-time user is not blocked on an empty select.
  useEffect(() => {
    if (!scaleId && scales.length > 0) {
      setValue("finalize.rating_scale_id", scales[0].id, { shouldDirty: false });
    }
  }, [scaleId, scales, setValue]);
  useEffect(() => {
    if (!workflowId && workflows.length > 0) {
      setValue("finalize.approval_workflow_id", workflows[0].id, { shouldDirty: false });
    }
  }, [workflowId, workflows, setValue]);

  const scale = scales.find((s) => s.id === scaleId);

  return (
    <section>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h2 className="mb-3 text-base font-semibold text-foreground">Rating Scale</h2>
          <Controller
            control={control}
            name="finalize.rating_scale_id"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full" aria-invalid={!!errors.finalize?.rating_scale_id}>
                  <SelectValue placeholder="Select a rating scale" />
                </SelectTrigger>
                <SelectContent>
                  {scales.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {errors.finalize?.rating_scale_id && (
            <p role="alert" className="mt-1.5 text-xs text-destructive">
              {errors.finalize.rating_scale_id.message}
            </p>
          )}

          {scale && (
            <div className="mt-4 overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-table-header text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-32 px-4 py-3">Rating</th>
                    <th className="px-4 py-3">Definition</th>
                  </tr>
                </thead>
                <tbody>
                  {scale.levels.map((l) => (
                    <tr key={l.value} className="border-t">
                      <td className="px-4 py-3 text-foreground">{l.value}</td>
                      <td className="px-4 py-3 text-foreground">
                        {l.description ? `${l.label} – ${l.description}` : l.label}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-base font-semibold text-foreground">Finalize Cycle</h2>
          <div className="space-y-3">
            {NOTIFY_FIELDS.map((f) => (
              <Controller
                key={f.name}
                control={control}
                name={f.name}
                render={({ field }) => (
                  <Label className="flex cursor-pointer items-center gap-2.5 font-normal">
                    <Checkbox checked={field.value} onCheckedChange={(c) => field.onChange(c === true)} />
                    {f.label}
                  </Label>
                )}
              />
            ))}
          </div>

          <p className="mb-2 mt-5 text-sm font-medium text-foreground">Approval workflow</p>
          <Controller
            control={control}
            name="finalize.approval_workflow_id"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full" aria-label="Approval workflow">
                  <SelectValue placeholder="Select an approval workflow" />
                </SelectTrigger>
                <SelectContent>
                  {workflows.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} (see Approval Workflow master)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>
    </section>
  );
}
