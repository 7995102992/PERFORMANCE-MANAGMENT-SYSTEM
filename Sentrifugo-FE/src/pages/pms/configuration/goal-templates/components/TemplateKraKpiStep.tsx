import { useState } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { StepSection } from "../../../shared/FormRow";
import { TARGET_TYPE_LABEL } from "../../config.constants";
import type { TemplateFormValues } from "../template.types";
import { sumWeights, WEIGHT_EPSILON } from "../template.utils";
import { WeightInput } from "./WeightInput";

/**
 * Goal template step 2 (screen 2.3): choose KRAs, then KPIs under each KRA, with a weightage and target
 * type per KPI. The KPI weightages must total 100 before the template can be saved as active; a draft
 * may be saved with any total.
 */
export function TemplateKraKpiStep() {
  const {
    control,
    register,
    setValue,
    formState: { errors },
  } = useFormContext<TemplateFormValues>();
  const kras = useWatch({ control, name: "kras" });

  // Open the first ticked KRA so the KPI grid is visible on arrival.
  const [open, setOpen] = useState<Set<string>>(() => {
    const first = kras.find((k) => k.selected) ?? kras[0];
    return new Set(first ? [first.kra_id] : []);
  });

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const setKraSelected = (i: number, checked: boolean) => {
    setValue(`kras.${i}.selected`, checked, { shouldDirty: true, shouldValidate: true });
    // Ticking a KRA takes all its KPIs along; unticking clears them.
    kras[i].kpis.forEach((_, j) =>
      setValue(`kras.${i}.kpis.${j}.selected`, checked, { shouldDirty: true }),
    );
    if (checked) setOpen((prev) => new Set(prev).add(kras[i].kra_id));
  };

  const setKpiSelected = (i: number, j: number, checked: boolean) => {
    setValue(`kras.${i}.kpis.${j}.selected`, checked, { shouldDirty: true, shouldValidate: true });
    if (checked && !kras[i].selected) setValue(`kras.${i}.selected`, true, { shouldDirty: true });
  };

  const allSelected = kras.length > 0 && kras.every((k) => k.selected);
  const someSelected = kras.some((k) => k.selected);
  const total = sumWeights(kras.filter((k) => k.selected).flatMap((k) => k.kpis));
  const balanced = Math.abs(total - 100) <= WEIGHT_EPSILON;
  const listError = errors.kras?.message ?? errors.kras?.root?.message;

  return (
    <section>
      <StepSection
        title="KRA & KPI"
        description="Tick the KRAs this role is measured on, then set the weightage of each KPI."
      />

      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-center gap-3 border-b bg-table-header px-4 py-3">
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(c) => kras.forEach((_, i) => setKraSelected(i, c === true))}
            aria-label="Select all KRAs"
          />
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            KRA
          </span>
        </div>

        {kras.map((kra, i) => {
          const isOpen = open.has(kra.kra_id);
          const kraErr = errors.kras?.[i]?.kpis;
          const kraMsg = kraErr?.message ?? kraErr?.root?.message;
          return (
            <div key={kra.kra_id} className="border-b last:border-b-0">
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-3 transition-colors",
                  isOpen ? "bg-primary/5" : "hover:bg-muted/40",
                )}
              >
                <Checkbox
                  checked={kra.selected}
                  onCheckedChange={(c) => setKraSelected(i, c === true)}
                  aria-label={`Select ${kra.name}`}
                />
                <button
                  type="button"
                  onClick={() => toggleOpen(kra.kra_id)}
                  aria-expanded={isOpen}
                  className="flex flex-1 items-center justify-between gap-3 text-left"
                >
                  <span className="font-medium text-foreground">
                    {kra.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {kra.kpis.filter((p) => p.selected).length}/{kra.kpis.length} KPIs
                    </span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>
              </div>

              {kraMsg && (
                <p role="alert" className="px-4 pb-2 pl-11 text-xs text-destructive">
                  {kraMsg}
                </p>
              )}

              {isOpen && (
                <div className="overflow-x-auto px-4 pb-4 pl-11">
                  {kra.kpis.length === 0 ? (
                    <p className="rounded-lg bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                      No KPIs are mapped to this KRA yet. Add them in the KPI Master.
                    </p>
                  ) : (
                    <table className="w-full min-w-[56rem] text-sm">
                      <thead>
                        <tr className="bg-table-header text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          <th className="w-10 rounded-l-lg px-3 py-2.5" />
                          <th className="px-3 py-2.5">KPI</th>
                          <th className="px-3 py-2.5">Weight %</th>
                          <th className="px-3 py-2.5">Target Type</th>
                          <th className="px-3 py-2.5">Units</th>
                          <th className="px-3 py-2.5">Expected Outcome</th>
                          <th className="rounded-r-lg px-3 py-2.5">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kra.kpis.map((kpi, j) => {
                          const ke = errors.kras?.[i]?.kpis?.[j];
                          return (
                            <tr key={kpi.kpi_id} className="border-b last:border-b-0 align-top">
                              <td className="px-3 py-3">
                                <Checkbox
                                  checked={kpi.selected}
                                  onCheckedChange={(c) => setKpiSelected(i, j, c === true)}
                                  aria-label={`Select ${kpi.name}`}
                                />
                              </td>
                              <td
                                className={cn(
                                  "px-3 py-3",
                                  kpi.selected ? "text-foreground" : "text-muted-foreground",
                                )}
                              >
                                {kpi.name}
                              </td>
                              <td className="px-3 py-2">
                                <Controller
                                  control={control}
                                  name={`kras.${i}.kpis.${j}.weight`}
                                  render={({ field }) => (
                                    <WeightInput
                                      value={field.value}
                                      onChange={field.onChange}
                                      disabled={!kpi.selected}
                                      invalid={!!ke?.weight}
                                      label={`Weight for ${kpi.name}`}
                                    />
                                  )}
                                />
                                {ke?.weight && (
                                  <p role="alert" className="mt-1 text-xs text-destructive">
                                    {ke.weight.message}
                                  </p>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <Controller
                                  control={control}
                                  name={`kras.${i}.kpis.${j}.target_type`}
                                  render={({ field }) => (
                                    <Select
                                      value={field.value}
                                      onValueChange={field.onChange}
                                      disabled={!kpi.selected}
                                    >
                                      <SelectTrigger className="w-32" aria-label={`Target type for ${kpi.name}`}>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {Object.entries(TARGET_TYPE_LABEL).map(([v, l]) => (
                                          <SelectItem key={v} value={v}>
                                            {l}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                />
                              </td>
                              <td className="px-3 py-3 text-muted-foreground">{kpi.unit}</td>
                              <td className="px-3 py-2">
                                <Input
                                  disabled={!kpi.selected}
                                  aria-label={`Expected outcome for ${kpi.name}`}
                                  aria-invalid={!!ke?.expected_outcome}
                                  {...register(`kras.${i}.kpis.${j}.expected_outcome`)}
                                />
                                {ke?.expected_outcome && (
                                  <p className="mt-1 text-xs text-destructive">
                                    {ke.expected_outcome.message}
                                  </p>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <Input
                                  disabled={!kpi.selected}
                                  aria-label={`Evidence for ${kpi.name}`}
                                  aria-invalid={!!ke?.evidence_required}
                                  {...register(`kras.${i}.kpis.${j}.evidence_required`)}
                                />
                                {ke?.evidence_required && (
                                  <p className="mt-1 text-xs text-destructive">
                                    {ke.evidence_required.message}
                                  </p>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p role="alert" className="text-xs text-destructive">
          {listError}
        </p>
        <p className="text-sm text-foreground">
          Total weightage:{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              balanced ? "text-emerald-600" : "text-destructive",
            )}
          >
            {+total.toFixed(2)}%
          </span>
        </p>
      </div>
    </section>
  );
}
