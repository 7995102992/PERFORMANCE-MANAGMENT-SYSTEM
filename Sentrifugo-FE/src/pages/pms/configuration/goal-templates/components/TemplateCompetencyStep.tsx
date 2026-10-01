import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { StepSection } from "../../../shared/FormRow";
import { COMPETENCY_CATEGORY_LABEL } from "../../config.constants";
import type { TemplateFormValues } from "../template.types";
import { distributeEqually, sumWeights, WEIGHT_EPSILON } from "../template.utils";
import { WeightInput } from "./WeightInput";

export function TemplateCompetencyStep() {
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<TemplateFormValues>();
  const rows = useWatch({ control, name: "competencies" });

  const selected = rows.filter((r) => r.selected);
  const total = sumWeights(rows);
  const balanced = Math.abs(total - 100) <= WEIGHT_EPSILON;
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const listError = errors.competencies?.message ?? errors.competencies?.root?.message;

  const setSelected = (i: number, checked: boolean) =>
    setValue(`competencies.${i}.selected`, checked, { shouldDirty: true, shouldValidate: true });

  const distribute = () => {
    const split = distributeEqually(selected.length);
    let n = 0;
    rows.forEach((r, i) => {
      if (r.selected) setValue(`competencies.${i}.weight`, split[n++], { shouldDirty: true, shouldValidate: true });
    });
  };

  return (
    <section>
      <StepSection
        title="Competency Section"
        description="Competencies assessed at year end. Weightage must total 100%."
      />

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="bg-table-header text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th className="w-14 px-4 py-3">
                <Checkbox
                  checked={allSelected ? true : selected.length > 0 ? "indeterminate" : false}
                  onCheckedChange={(c) => rows.forEach((_, i) => setSelected(i, c === true))}
                  aria-label="Select all competencies"
                />
              </th>
              <th className="w-14 px-3 py-3">#</th>
              <th className="px-3 py-3">Competency</th>
              <th className="px-3 py-3">Category</th>
              <th className="px-3 py-3">Weight %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const err = errors.competencies?.[i]?.weight;
              return (
                <tr key={row.competency_id} className="border-t align-top">
                  <td className="px-4 py-3.5">
                    <Checkbox
                      checked={row.selected}
                      onCheckedChange={(c) => setSelected(i, c === true)}
                      aria-label={`Select ${row.name}`}
                    />
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{i + 1}</td>
                  <td
                    className={cn(
                      "px-3 py-3",
                      row.selected ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {row.name}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {COMPETENCY_CATEGORY_LABEL[row.category]}
                  </td>
                  <td className="px-3 py-2">
                    <Controller
                      control={control}
                      name={`competencies.${i}.weight`}
                      render={({ field }) => (
                        <WeightInput
                          value={field.value}
                          onChange={field.onChange}
                          disabled={!row.selected}
                          invalid={!!err}
                          label={`Weight for ${row.name}`}
                        />
                      )}
                    />
                    {err && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {err.message}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {selected.length} of {rows.length} competencies selected · Total weightage{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              balanced ? "text-emerald-600" : "text-destructive",
            )}
          >
            {+total.toFixed(2)}%
          </span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={distribute}
          disabled={selected.length === 0}
        >
          <Scale /> Distribute equally
        </Button>
      </div>
      {listError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {listError}
        </p>
      )}
    </section>
  );
}
