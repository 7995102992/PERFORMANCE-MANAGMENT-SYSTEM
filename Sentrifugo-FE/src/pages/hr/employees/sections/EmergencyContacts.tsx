import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { useAppSelector } from "@/store";
import { useMasterOptions } from "@/hooks/use-master-options";
import type { EmployeeFormValues, EmergencyContactRow } from "@/types/employee";

interface Props {
  values: EmployeeFormValues;
  onChange: <K extends keyof EmployeeFormValues>(
    key: K,
    value: EmployeeFormValues[K],
  ) => void;
  errors: Partial<Record<string, string>>;
}

export function EmergencyContacts({ values, onChange, errors }: Props) {
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id) ?? undefined;
  const relationshipOptions = useMasterOptions("RELATIONSHIPS", orgId);
  const rows = values.emergencyContacts;

  function updateRow(
    idx: number,
    field: keyof EmergencyContactRow,
    val: string,
  ) {
    const updated = rows.map((r, i) =>
      i === idx ? { ...r, [field]: val } : r,
    );
    onChange("emergencyContacts", updated);
  }

  function addRow() {
    onChange("emergencyContacts", [
      ...rows,
      { contactName: "", contactNumber: "", relationship: "" },
    ]);
  }

  function removeRow(idx: number) {
    if (rows.length <= 1) return;
    onChange(
      "emergencyContacts",
      rows.filter((_, i) => i !== idx),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <div>
          <h3 className="text-base font-semibold">Emergency Contacts</h3>
          <p className="text-xs text-muted-foreground">
            Optional — if you add one, complete all its fields
          </p>
        </div>
        <Button type="button" variant="success" size="sm" onClick={addRow}>
          <Plus />
          Add Contact
        </Button>
      </div>

      {errors.emergencyContacts && (
        <p className="text-sm text-destructive">{errors.emergencyContacts}</p>
      )}

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 border-b">
              <th className="px-3 py-2 text-left font-medium">
                Contact Name <span className="text-destructive">*</span>
              </th>
              <th className="px-3 py-2 text-left font-medium">
                Contact Number <span className="text-destructive">*</span>
              </th>
              <th className="px-3 py-2 text-left font-medium">
                Relationship <span className="text-destructive">*</span>
              </th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  <Input
                    placeholder="Full name"
                    value={row.contactName}
                    onChange={(e) =>
                      updateRow(idx, "contactName", e.target.value)
                    }
                    className="h-8 text-sm"
                    maxLength={100}
                  />
                  {errors[`emergencyContacts.${idx}.contactName`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`emergencyContacts.${idx}.contactName`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Input
                    placeholder="Phone number"
                    value={row.contactNumber}
                    onChange={(e) =>
                      updateRow(idx, "contactNumber", e.target.value)
                    }
                    className="h-8 text-sm"
                    maxLength={20}
                  />
                  {errors[`emergencyContacts.${idx}.contactNumber`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`emergencyContacts.${idx}.contactNumber`]}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[150px]">
                  <SearchableSelect
                    options={relationshipOptions}
                    value={row.relationship}
                    onChange={(v) => updateRow(idx, "relationship", v as string)}
                    placeholder="Select"
                    searchable={false}
                  />
                  {errors[`emergencyContacts.${idx}.relationship`] && (
                    <p className="text-xs text-destructive mt-0.5">
                      {errors[`emergencyContacts.${idx}.relationship`]}
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
