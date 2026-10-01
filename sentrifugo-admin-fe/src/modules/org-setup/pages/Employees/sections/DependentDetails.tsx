import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { DatePicker } from "@/components/shared/DatePicker";
import { useAppSelector } from "@/store";
import { useMasterData } from "@/hooks/queries/use-master-data";
import type {
  EmployeeFormValues,
  DependentRow,
} from "@/modules/org-setup/types/employee";

const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

function parseLocalDate(iso: string): Date | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

interface Props {
  values: EmployeeFormValues;
  onChange: <K extends keyof EmployeeFormValues>(
    key: K,
    value: EmployeeFormValues[K],
  ) => void;
  errors: Partial<Record<string, string>>;
}

export function DependentDetails({ values, onChange, errors }: Props) {
  const orgId = useAppSelector((s) => s.organisation.savedOrganisation?.id);
  const { data: relationshipOptions = [] } = useMasterData(
    "RELATIONSHIPS",
    orgId,
  );
  const rows = values.dependents;

  function updateRow(idx: number, field: keyof DependentRow, val: string) {
    const updated = rows.map((r, i) =>
      i === idx ? { ...r, [field]: val } : r,
    );
    onChange("dependents", updated);
  }

  function addRow() {
    onChange("dependents", [
      ...rows,
      { name: "", relationship: "", dateOfBirth: "" },
    ]);
  }

  function removeRow(idx: number) {
    if (rows.length <= 1) return;
    onChange(
      "dependents",
      rows.filter((_, i) => i !== idx),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h3 className="text-base font-semibold">Dependent Details</h3>
        <Button type="button" variant="success" size="sm" onClick={addRow}>
          <Plus />
          Add Row
        </Button>
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 border-b">
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Relationship</th>
              <th className="px-3 py-2 text-left font-medium">Date of Birth</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  <Input
                    placeholder="Dependent name"
                    value={row.name}
                    onChange={(e) => updateRow(idx, "name", e.target.value)}
                    className="h-8 text-sm"
                    maxLength={100}
                  />
                  {errors[`dependents.${idx}.name`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`dependents.${idx}.name`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[150px]">
                  <SearchableSelect
                    options={relationshipOptions}
                    value={row.relationship}
                    onChange={(v) => updateRow(idx, "relationship", v)}
                    placeholder="Select"
                    searchable={false}
                  />
                  {errors[`dependents.${idx}.relationship`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`dependents.${idx}.relationship`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[150px]">
                  <DatePicker
                    value={parseLocalDate(row.dateOfBirth)}
                    onChange={(d) =>
                      updateRow(idx, "dateOfBirth", d ? formatDate(d) : "")
                    }
                    placeholder="dd-mm-yyyy"
                    maxDate={new Date()}
                  />
                  {errors[`dependents.${idx}.dateOfBirth`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`dependents.${idx}.dateOfBirth`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2">
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeRow(idx)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
