import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppSelector } from "@/store";
import { useBusinessUnits } from "@/hooks/queries/use-business-unit";
import type {
  EmployeeFormValues,
  IdentityField,
} from "@/modules/org-setup/types/employee";

// ─── India detection ─────────────────────────────────────────────────────────
// Match BU country against common India representations
const INDIA_MATCHERS = ["india", "in", "ind"];

function isIndiaCountry(country: string | undefined | null): boolean {
  if (!country) return false;
  return INDIA_MATCHERS.includes(country.trim().toLowerCase());
}

// ─── India: fixed Aadhaar + PAN fields (both mandatory) ──────────────────────
const AADHAAR_LABEL = "Aadhaar Number";
const PAN_LABEL = "PAN Number";
const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

interface Props {
  values: EmployeeFormValues;
  onChange: <K extends keyof EmployeeFormValues>(
    key: K,
    value: EmployeeFormValues[K],
  ) => void;
  errors?: Partial<Record<string, string>>;
}

export function IdentityInfo({ values, onChange, errors = {} }: Props) {
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const { data: remoteBUs = [] } = useBusinessUnits(savedOrg?.id);
  const selectedBU = remoteBUs.find((bu) => bu.id === values.businessUnit);
  const buCountry = selectedBU?.address?.country;
  const isIndia = isIndiaCountry(buCountry);

  const fields = values.identityFields;

  function upsertByLabel(label: string, val: string) {
    const current = [...fields];
    const existIdx = current.findIndex((f) => f.label === label);
    if (existIdx >= 0) {
      current[existIdx] = { ...current[existIdx], value: val };
    } else {
      current.push({ label, value: val });
    }
    onChange("identityFields", current);
  }

  function valueFor(label: string): string {
    return fields.find((f) => f.label === label)?.value ?? "";
  }

  function updateField(idx: number, key: keyof IdentityField, val: string) {
    const updated = fields.map((f, i) =>
      i === idx ? { ...f, [key]: val } : f,
    );
    onChange("identityFields", updated);
  }

  function addField() {
    onChange("identityFields", [...fields, { label: "", value: "" }]);
  }

  function removeField(idx: number) {
    onChange(
      "identityFields",
      fields.filter((_, i) => i !== idx),
    );
  }

  // Generic (non-India): at least one custom field required
  const nonIndiaFields = isIndia
    ? []
    : fields.filter((f) => f.label !== AADHAAR_LABEL && f.label !== PAN_LABEL);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h3 className="text-base font-semibold">Identity Information</h3>
        {!isIndia && (
          <Button type="button" variant="success" size="sm" onClick={addField}>
            <Plus />
            Add Identity Field
          </Button>
        )}
      </div>

      {!values.businessUnit && (
        <p className="text-sm text-muted-foreground">
          Select a Business Unit first to see the appropriate identity fields.
        </p>
      )}

      {values.businessUnit && isIndia && (
        /* ── India: Aadhaar + PAN, both mandatory ──────────────────────────── */
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-3">
            <Label>{AADHAAR_LABEL}</Label>
            <Input
              placeholder="Enter 12-digit Aadhaar"
              value={valueFor(AADHAAR_LABEL)}
              maxLength={12}
              onChange={(e) => upsertByLabel(AADHAAR_LABEL, e.target.value)}
            />
            {errors.aadhaar && (
              <p className="text-sm text-destructive">{errors.aadhaar}</p>
            )}
          </div>
          <div className="space-y-3">
            <Label>{PAN_LABEL}</Label>
            <Input
              placeholder="e.g. ABCDE1234F"
              value={valueFor(PAN_LABEL)}
              maxLength={10}
              onChange={(e) =>
                upsertByLabel(PAN_LABEL, e.target.value.toUpperCase())
              }
            />
            {errors.pan && (
              <p className="text-sm text-destructive">{errors.pan}</p>
            )}
          </div>
        </div>
      )}

      {values.businessUnit && !isIndia && (
        /* ── Non-India: at least one custom identity field required ────────── */
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Optionally add identity fields (e.g. SSN, Passport No., National
            ID).
          </p>
          {nonIndiaFields.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No identity fields added. Click "Add Identity Field" to add one.
            </p>
          ) : (
            fields.map((field, idx) =>
              field.label === AADHAAR_LABEL ||
              field.label === PAN_LABEL ? null : (
                <div
                  key={idx}
                  className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end"
                >
                  <div className="space-y-3">
                    <Label>Field Name</Label>
                    <Input
                      placeholder="e.g. SSN, Passport No."
                      value={field.label}
                      onChange={(e) =>
                        updateField(idx, "label", e.target.value)
                      }
                      maxLength={50}
                    />
                  </div>
                  <div className="space-y-3">
                    <Label>Value</Label>
                    <Input
                      placeholder="Enter value"
                      value={field.value}
                      onChange={(e) =>
                        updateField(idx, "value", e.target.value)
                      }
                      maxLength={50}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => removeField(idx)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ),
            )
          )}
          {errors.identityFields && (
            <p className="text-sm text-destructive">{errors.identityFields}</p>
          )}
        </div>
      )}
    </div>
  );
}
