import { useEffect } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Bell, CalendarRange, MapPin, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useGetPmsPlantsQuery, useGetPmsRatingScalesQuery } from "@/store/api/pmsApi";
import type { PmsCycleUpsert } from "@/types/pms";
import { APPRAISAL_TYPE_LABEL } from "../cycle.constants";
import { formatDisplayDate } from "../../shared/pms.utils";
import { StepSection } from "../../shared/FormRow";

const NOTIFY_FIELDS = [
  { name: "finalize.notify_managers", label: "Notify Managers" },
  { name: "finalize.notify_employees", label: "Notify Employees" },
  { name: "finalize.notify_hod", label: "Notify HOD / Reviewers" },
  { name: "finalize.notify_hr", label: "Notify HR" },
] as const;

// Highest rating reads green, lowest red — value ÷ scale size, not a fixed map,
// so 3- and 4-point scales colour correctly too.
const levelTone = (value: number, max: number) => {
  const ratio = value / max;
  if (ratio >= 0.8) return "bg-emerald-500/10 text-emerald-600";
  if (ratio >= 0.6) return "bg-sky-500/10 text-sky-600";
  if (ratio >= 0.4) return "bg-amber-500/10 text-amber-600";
  return "bg-red-500/10 text-red-600";
};

export function RatingPublishStep() {
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  const { data: scales = [] } = useGetPmsRatingScalesQuery();
  const { data: plants = [] } = useGetPmsPlantsQuery();

  const [scaleId, basic, applicability, stages, finalize] = [
    useWatch({ control, name: "finalize.rating_scale_id" }),
    useWatch({ control, name: "basic" }),
    useWatch({ control, name: "applicability" }),
    useWatch({ control, name: "stages" }),
    useWatch({ control, name: "finalize" }),
  ];

  // Default to the first scale so a first-time user is not blocked on an empty select.
  useEffect(() => {
    if (!scaleId && scales.length > 0) {
      setValue("finalize.rating_scale_id", scales[0].id, { shouldDirty: false });
    }
  }, [scaleId, scales, setValue]);

  const scale = scales.find((s) => s.id === scaleId);
  const maxRating = Math.max(...(scale?.levels.map((l) => l.value) ?? [1]));
  const plantNames =
    plants.length > 0 && applicability.plant_ids.length === plants.length
      ? "All Plants"
      : applicability.plant_ids
          .map((id) => plants.find((p) => p.id === id)?.name)
          .filter(Boolean)
          .join(", ");
  const audienceCount = [
    finalize.notify_managers,
    finalize.notify_employees,
    finalize.notify_hod,
    finalize.notify_hr,
  ].filter(Boolean).length;

  return (
    <section>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <StepSection title="Rating Scale" description="Used by managers and HODs when rating." />
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
                    <th className="w-24 px-4 py-2.5">Rating</th>
                    <th className="px-4 py-2.5">Definition</th>
                  </tr>
                </thead>
                <tbody>
                  {scale.levels.map((l) => (
                    <tr key={l.value} className="border-t">
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            "inline-flex size-7 items-center justify-center rounded-lg text-sm font-semibold",
                            levelTone(l.value, maxRating),
                          )}
                        >
                          {l.value}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-foreground">
                        {l.label}
                        {l.description && (
                          <span className="text-muted-foreground"> – {l.description}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div>
            <StepSection title="Finalize Cycle" />
            <div className="space-y-3">
              {NOTIFY_FIELDS.map((f) => (
                <Controller
                  key={f.name}
                  control={control}
                  name={f.name}
                  render={({ field }) => (
                    <Label className="flex cursor-pointer items-center gap-2.5 font-normal">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(c) => field.onChange(c === true)}
                      />
                      {f.label}
                    </Label>
                  )}
                />
              ))}
            </div>
          </div>

          <div className="rounded-xl border bg-muted/30 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Summary
            </p>
            <p className="mt-1.5 text-sm font-semibold text-foreground">
              {basic.name || "Untitled cycle"}
            </p>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <CalendarRange className="mt-0.5 size-4 shrink-0" />
                <span>
                  {APPRAISAL_TYPE_LABEL[basic.type]} · {formatDisplayDate(basic.period_start)} –{" "}
                  {formatDisplayDate(basic.period_end)}
                </span>
              </li>
              <li className="flex gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                <span>{plantNames || "No plants selected"}</span>
              </li>
              <li className="flex gap-2">
                <Users className="mt-0.5 size-4 shrink-0" />
                <span>
                  {applicability.all_departments
                    ? "All departments"
                    : `${applicability.department_ids.length} departments`}{" "}
                  · min. {applicability.min_service_months} months service
                </span>
              </li>
              <li className="flex gap-2">
                <Bell className="mt-0.5 size-4 shrink-0" />
                <span>
                  {stages.length} stages
                  {audienceCount > 0
                    ? ` · notifies ${audienceCount} group${audienceCount > 1 ? "s" : ""} on publish`
                    : " · no publish notifications"}
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
