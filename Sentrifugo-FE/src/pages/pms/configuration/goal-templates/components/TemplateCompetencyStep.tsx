import { useFormContext, useWatch } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { StepSection } from "../../../shared/FormRow";
import { COMPETENCY_CATEGORY_LABEL } from "../../config.constants";
import { CompetencyTypeBadge } from "../../CompetencyTypeBadge";
import type { TemplateFormValues } from "../template.types";

/**
 * Goal template step 3 (screen 2.5): tick the competencies assessed at year end. There are no weights; the
 * competencies share the weightage equally when the template is saved.
 */
export function TemplateCompetencyStep() {
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<TemplateFormValues>();
  // Live list of competency rows from the form.
  const rows = useWatch({ control, name: "competencies" });

  const selected = rows.filter((r) => r.selected);
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const listError = errors.competencies?.message ?? errors.competencies?.root?.message;

  /** Ticks or unticks one competency. */
  const setSelected = (i: number, checked: boolean) =>
    setValue(`competencies.${i}.selected`, checked, { shouldDirty: true, shouldValidate: true });

  return (
    <section>
      <StepSection title="Competency Section" />

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
              <th className="px-3 py-3">Competency type</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.competency_id} className="border-t">
                <td className="px-4 py-3.5">
                  <Checkbox
                    checked={row.selected}
                    onCheckedChange={(c) => setSelected(i, c === true)}
                    aria-label={`Select ${row.name}`}
                  />
                </td>
                <td className="px-3 py-3 text-muted-foreground">{i + 1}</td>
                <td className={cn("px-3 py-3", row.selected ? "text-foreground" : "text-muted-foreground")}>
                  {row.name}
                </td>
                <td className="px-3 py-3 text-muted-foreground">{COMPETENCY_CATEGORY_LABEL[row.category]}</td>
                <td className="px-3 py-3">
                  <CompetencyTypeBadge type={row.type} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        {selected.length} of {rows.length} competencies selected · Manager = rated by L1 and L2 · HR = rated by
        Plant HR (Corporate Office: Corporate HR)
      </p>
      {listError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {listError}
        </p>
      )}
    </section>
  );
}
