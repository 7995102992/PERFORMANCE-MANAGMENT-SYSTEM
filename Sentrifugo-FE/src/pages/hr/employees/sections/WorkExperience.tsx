import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { DatePicker } from "@/components/shared/DatePicker";
import type { EmployeeFormValues, WorkExperienceRow } from "@/types/employee";

const RELEVANT_OPTIONS = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

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

export function WorkExperience({ values, onChange, errors }: Props) {
  const rows = values.workExperience;

  function updateRow(idx: number, field: keyof WorkExperienceRow, val: string) {
    const updated = rows.map((r, i) =>
      i === idx ? { ...r, [field]: val } : r,
    );
    onChange("workExperience", updated);
  }

  function addRow() {
    onChange("workExperience", [
      ...rows,
      {
        companyName: "",
        jobTitle: "",
        fromDate: "",
        toDate: "",
        jobDescription: "",
        relevant: "",
      },
    ]);
  }

  function removeRow(idx: number) {
    if (rows.length <= 1) return;
    onChange(
      "workExperience",
      rows.filter((_, i) => i !== idx),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h3 className="text-base font-semibold">Work Experience</h3>
        <Button type="button" variant="success" size="sm" onClick={addRow}>
          <Plus />
          Add Row
        </Button>
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 border-b">
              <th className="px-3 py-2 text-left font-medium">Company Name</th>
              <th className="px-3 py-2 text-left font-medium">Job Title</th>
              <th className="px-3 py-2 text-left font-medium">From Date</th>
              <th className="px-3 py-2 text-left font-medium">To Date</th>
              <th className="px-3 py-2 text-left font-medium">
                Job Description
              </th>
              <th className="px-3 py-2 text-left font-medium">Relevant</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  <Input
                    placeholder="Company"
                    value={row.companyName}
                    onChange={(e) =>
                      updateRow(idx, "companyName", e.target.value)
                    }
                    className="h-8 text-sm"
                    maxLength={100}
                  />
                  {errors[`workExperience.${idx}.companyName`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`workExperience.${idx}.companyName`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Input
                    placeholder="Title"
                    value={row.jobTitle}
                    onChange={(e) => updateRow(idx, "jobTitle", e.target.value)}
                    className="h-8 text-sm"
                    maxLength={100}
                  />
                  {errors[`workExperience.${idx}.jobTitle`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`workExperience.${idx}.jobTitle`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[150px]">
                  <DatePicker
                    value={parseLocalDate(row.fromDate)}
                    onChange={(d) =>
                      updateRow(idx, "fromDate", d ? formatDate(d) : "")
                    }
                    maxDate={parseLocalDate(row.toDate) ?? new Date()}
                    placeholder="dd-mm-yyyy"
                  />
                  {errors[`workExperience.${idx}.fromDate`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`workExperience.${idx}.fromDate`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[150px]">
                  <DatePicker
                    value={parseLocalDate(row.toDate)}
                    onChange={(d) =>
                      updateRow(idx, "toDate", d ? formatDate(d) : "")
                    }
                    minDate={parseLocalDate(row.fromDate)}
                    maxDate={new Date()}
                    placeholder="dd-mm-yyyy"
                  />
                  {errors[`workExperience.${idx}.toDate`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`workExperience.${idx}.toDate`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Input
                    placeholder="Description"
                    value={row.jobDescription}
                    onChange={(e) =>
                      updateRow(idx, "jobDescription", e.target.value)
                    }
                    className="h-8 text-sm"
                    maxLength={200}
                  />
                  {errors[`workExperience.${idx}.jobDescription`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`workExperience.${idx}.jobDescription`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[120px]">
                  <SearchableSelect
                    options={RELEVANT_OPTIONS}
                    value={row.relevant}
                    onChange={(v) => updateRow(idx, "relevant", v as string)}
                    placeholder="Select"
                    searchable={false}
                  />
                  {errors[`workExperience.${idx}.relevant`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`workExperience.${idx}.relevant`]}
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
