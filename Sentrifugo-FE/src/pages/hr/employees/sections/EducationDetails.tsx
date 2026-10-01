import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/shared/DatePicker";
import type { EmployeeFormValues, EducationRow } from "@/types/employee";

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

export function EducationDetails({ values, onChange, errors }: Props) {
  const rows = values.education;

  function updateRow(idx: number, field: keyof EducationRow, val: string) {
    const updated = rows.map((r, i) =>
      i === idx ? { ...r, [field]: val } : r,
    );
    onChange("education", updated);
  }

  function addRow() {
    onChange("education", [
      ...rows,
      {
        instituteName: "",
        degree: "",
        specialization: "",
        dateOfCompletion: "",
      },
    ]);
  }

  function removeRow(idx: number) {
    if (rows.length <= 1) return;
    onChange(
      "education",
      rows.filter((_, i) => i !== idx),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h3 className="text-base font-semibold">Education Details</h3>
        <Button type="button" variant="success" size="sm" onClick={addRow}>
          <Plus />
          Add Row
        </Button>
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 border-b">
              <th className="px-3 py-2 text-left font-medium">
                Institute Name
              </th>
              <th className="px-3 py-2 text-left font-medium">
                Degree / Diploma
              </th>
              <th className="px-3 py-2 text-left font-medium">
                Specialization
              </th>
              <th className="px-3 py-2 text-left font-medium">
                Date of Completion
              </th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  <Input
                    placeholder="Institute name"
                    value={row.instituteName}
                    onChange={(e) =>
                      updateRow(idx, "instituteName", e.target.value)
                    }
                    className="h-8 text-sm"
                    maxLength={150}
                  />
                  {errors[`education.${idx}.instituteName`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`education.${idx}.instituteName`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Input
                    placeholder="e.g. B.Tech, MBA"
                    value={row.degree}
                    onChange={(e) => updateRow(idx, "degree", e.target.value)}
                    className="h-8 text-sm"
                    maxLength={100}
                  />
                  {errors[`education.${idx}.degree`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`education.${idx}.degree`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Input
                    placeholder="e.g. Computer Science"
                    value={row.specialization}
                    onChange={(e) =>
                      updateRow(idx, "specialization", e.target.value)
                    }
                    className="h-8 text-sm"
                    maxLength={100}
                  />
                  {errors[`education.${idx}.specialization`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`education.${idx}.specialization`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[150px]">
                  <DatePicker
                    value={parseLocalDate(row.dateOfCompletion)}
                    onChange={(d) =>
                      updateRow(idx, "dateOfCompletion", d ? formatDate(d) : "")
                    }
                    placeholder="dd-mm-yyyy"
                    maxDate={new Date()}
                  />
                  {errors[`education.${idx}.dateOfCompletion`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`education.${idx}.dateOfCompletion`]}
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
