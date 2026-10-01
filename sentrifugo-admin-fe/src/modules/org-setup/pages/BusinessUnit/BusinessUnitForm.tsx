/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react";
import { useEffect, useState } from "react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { CircleHelp, Info, Lock, Pencil } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DatePicker } from "@/components/shared/DatePicker";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  SectionCustomFields,
  type SectionCustomFieldsRef,
} from "@/modules/org-setup/pages/Employees/SectionCustomFields";
import { businessUnitSchema } from "@/modules/org-setup/types/business-unit";
import type { BusinessUnitFormValues } from "@/modules/org-setup/types/business-unit";
import { useAppSelector } from "@/store";
import {
  useCountries,
  useStates,
  useCities,
  useCurrencies,
  useTimezones,
  useMasterData,
} from "@/hooks/queries/use-master-data";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";

const FINANCIAL_YEARS = [
  { label: "Calendar Year (Jan - Dec)", value: "calendar" },
  { label: "Financial Year (Apr - Mar)", value: "financial" },
];

const s = businessUnitSchema.shape;

// Employee-code "Start From" values are digit strings — the first employee code
// IS this value (leading zeros set the width, e.g. "006" → SIL-006 full-time,
// SIL-C-006 contract). Mandatory:
// the user must type a value (blank is invalid).
function validateStartFrom({ value }: { value: string | undefined }) {
  if (value === undefined || value === null || value === "")
    return {
      message: "Required — enter a number (leading zeros allowed, e.g. 006)",
    };
  if (!/^\d{1,7}$/.test(value))
    return { message: "Only 1–7 digits; leading zeros allowed" };
  return undefined;
}

const EMPTY_DEFAULTS: BusinessUnitFormValues = {
  country: "",
  businessUnitName: "",
  empCodePrefix: "",
  empCodeStartFrom: { fullTime: undefined, contract: undefined, internship: undefined },
  headName: "",
  dateOfIncorporation: "",
  ein: "",
  sector: "",
  typeOfBusiness: "",
  addressLine1: "",
  natureOfBusiness: "",
  city: "",
  addressLine2: "",
  zipCode: "",
  state: "",
  financialYear: "",
  currency: "",
  timeZone: "",
  timeFormat: "12",
  isSubsidiary: false,
  isActive: true,
};

export interface BusinessUnitFormRef {
  saveCustomFields: (buId: string) => Promise<void>;
  isDirty: () => boolean;
}

interface BusinessUnitFormProps {
  entityId?: string;
  initialData?: BusinessUnitFormValues;
  onSave: (data: BusinessUnitFormValues) => void | Promise<void>;
  onCancel?: () => void;
  onDelete?: () => void;
  /** In read-only view mode, shows a top-right Edit button that switches to editing */
  onEdit?: () => void;
  /** 'single' hides Cancel, shows Clear/Delete. 'multiple' shows Cancel, hides Clear/Delete. */
  mode?: "single" | "multiple";
  /** Existing BU names to prevent duplicates */
  existingNames?: string[];
  /** Existing BU employee-code prefixes to prevent duplicates (per organisation) */
  existingPrefixes?: string[];
  /** Whether a BU is already saved (affects button labels + behavior) */
  hasSavedBU?: boolean;
  /** Whether employees exist in this BU (locks prefix + start-from fields) */
  hasEmployees?: boolean;
  isSaving?: boolean;
  readOnly?: boolean;
}

export const BusinessUnitForm = React.forwardRef<
  BusinessUnitFormRef,
  BusinessUnitFormProps
>(function BusinessUnitForm(
  {
    entityId,
    initialData,
    onSave,
    onCancel,
    onEdit,
    mode = "multiple",
    existingNames = [],
    existingPrefixes = [],
    hasSavedBU = false,
    hasEmployees = false,
    isSaving = false,
    readOnly = false,
  },
  ref,
) {
  const confirm = useConfirm();
  const scrollToError = useScrollToError();
  const customFieldsRef = React.useRef<SectionCustomFieldsRef>(null);
  const [cfDirty, setCfDirty] = React.useState(false);
  const [hasCFs, setHasCFs] = React.useState(false);
  const [isEditMode, setIsEditMode] = React.useState(false);
  const singleReadOnly =
    readOnly || (mode === "single" && hasSavedBU && !isEditMode);

  const [nameError, setNameError] = useState<string | null>(null);
  const [prefixError, setPrefixError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: initialData ?? EMPTY_DEFAULTS,
    onSubmit: ({ value }) => {
      // Check name uniqueness
      const trimmedName = value.businessUnitName.trim().toLowerCase();
      const isDuplicate = existingNames.some(
        (n) => n.toLowerCase() === trimmedName,
      );
      if (isDuplicate) {
        setNameError("A business unit with this name already exists");
        requestAnimationFrame(() => scrollToError());
        return;
      }
      setNameError(null);

      // Check prefix uniqueness (normalized to match backend: trim + uppercase)
      const normalizedPrefix = value.empCodePrefix.trim().toUpperCase();
      const isDuplicatePrefix = existingPrefixes.some(
        (p) => p.trim().toUpperCase() === normalizedPrefix,
      );
      if (isDuplicatePrefix) {
        setPrefixError(
          `Employee code prefix '${normalizedPrefix}' is already used by another business unit`,
        );
        requestAnimationFrame(() => scrollToError());
        return;
      }
      setPrefixError(null);

      // Required custom fields must be filled before we save anything
      const cfValid = customFieldsRef.current?.validate() ?? true;
      if (!cfValid) {
        requestAnimationFrame(() => scrollToError());
        return;
      }

      // Show confirmation before save/update
      confirm({
        title: hasSavedBU ? "Update Business Unit?" : "Save Business Unit?",
        description: hasSavedBU
          ? "Are you sure you want to update this business unit?"
          : "Are you sure you want to create this business unit?",
        confirmText: hasSavedBU ? "Update" : "Save",
        onConfirm: async () => {
          await onSave(value);
        },
      });
    },
  });

  const formDirty = useStore(form.store, (s) => s.isDirty);
  useNavigationGuard(formDirty || cfDirty);

  React.useImperativeHandle(ref, () => ({
    saveCustomFields: async (buId: string) => {
      await customFieldsRef.current?.saveValues(buId);
    },
    isDirty: () => form.state.isDirty || cfDirty,
  }));

  // Master data from API
  const orgId = useAppSelector((s) => s.organisation.savedOrganisation?.id);
  // Organisation address — used to copy into the BU address ("same as org")
  const orgAddress = useAppSelector(
    (s) => s.organisation.savedOrganisation?.address,
  );
  const orgCurrency = useAppSelector(
    (s) => s.organisation.savedOrganisation?.currency,
  );
  const orgTimezone = useAppSelector(
    (s) => s.organisation.savedOrganisation?.timezone,
  );
  const hasOrgAddress = !!orgAddress?.address_line_1;
  const [sameAsOrg, setSameAsOrg] = useState(false);

  function fillFromOrgAddress() {
    if (!orgAddress) return;
    const c = orgAddress.country ?? "";
    const st = orgAddress.state ?? "";
    form.setFieldValue("country", c);
    form.setFieldValue("addressLine1", orgAddress.address_line_1 ?? "");
    form.setFieldValue("addressLine2", orgAddress.address_line_2 ?? "");
    form.setFieldValue("state", st);
    form.setFieldValue("city", orgAddress.city ?? "");
    form.setFieldValue("zipCode", orgAddress.zip_code ?? "");
    // Currency & time zone are country-linked org settings — inherit them too
    if (orgCurrency) form.setFieldValue("currency", orgCurrency);
    if (orgTimezone) form.setFieldValue("timeZone", orgTimezone);
    setSelectedCountry(c);
    setSelectedState(st);
    setSameAsOrg(true);
  }

  function applyOrgAddress(checked: boolean) {
    // Unchecking just unlocks the fields — keep values, no confirmation needed
    if (!checked) {
      setSameAsOrg(false);
      return;
    }
    if (!orgAddress) return;

    // If the BU already has address details, confirm before overwriting them
    const v = form.state.values;
    const hasExistingAddress = !!(
      v.addressLine1 ||
      v.addressLine2 ||
      v.city ||
      v.state ||
      v.zipCode
    );

    if (hasExistingAddress) {
      confirm({
        title: "Use organisation address?",
        description:
          "This will replace the current address (and currency / time zone) with the organisation's details. Do you want to continue?",
        confirmText: "Yes, use organisation's",
        onConfirm: async () => fillFromOrgAddress(),
      });
    } else {
      fillFromOrgAddress();
    }
  }
  const { data: sectorOptions = [] } = useMasterData("SECTORS", orgId);
  const { data: businessTypeOptions = [] } = useMasterData(
    "BUSINESS_TYPES",
    orgId,
  );
  const { data: natureOptions = [] } = useMasterData("BUSINESS_NATURES", orgId);

  // Countries, states, cities from API
  const { data: countryOptions = [] } = useCountries();
  const [selectedCountry, setSelectedCountry] = useState(
    initialData?.country ?? "",
  );
  const [selectedState, setSelectedState] = useState(initialData?.state ?? "");
  const { data: stateOptions = [] } = useStates(selectedCountry);
  const { data: cityOptions = [] } = useCities(selectedCountry, selectedState);
  const { data: currencyOptions = [] } = useCurrencies(selectedCountry);
  const { data: timezoneOptions = [] } = useTimezones(selectedCountry);

  // Auto-fill currency and timezone when only one option for the selected country
  useEffect(() => {
    if (currencyOptions.length === 1 && !form.getFieldValue("currency")) {
      form.setFieldValue("currency", currencyOptions[0].value);
    }
  }, [currencyOptions]);

  useEffect(() => {
    if (timezoneOptions.length === 1 && !form.getFieldValue("timeZone")) {
      form.setFieldValue("timeZone", timezoneOptions[0].value);
    }
  }, [timezoneOptions]);

  // India follows the Apr–Mar fiscal year — auto-fill it when India is selected
  useEffect(() => {
    if (
      selectedCountry.trim().toLowerCase() === "india" &&
      !form.getFieldValue("financialYear")
    ) {
      form.setFieldValue("financialYear", "financial");
    }
  }, [selectedCountry]);

  // Sync when initialData changes (edit mode)
  useEffect(() => {
    if (initialData?.country) setSelectedCountry(initialData.country);
    if (initialData?.state) setSelectedState(initialData.state);
  }, [initialData?.country, initialData?.state]);

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
          // Scroll to first invalid field after React renders errors
          requestAnimationFrame(() => scrollToError());
        }}
      >
        <Card>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">
                  Business Unit Details
                </h3>
                <p className="text-sm text-muted-foreground">
                  Provide the primary details for the new legal entity, ensuring
                  all required fields are accurately completed for compliance.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <form.Field name="isSubsidiary">
                  {(field) => (
                    <div className="flex flex-col items-end gap-1">
                      <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-label">
                        Entity Type
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger type="button" tabIndex={-1}>
                              <CircleHelp className="size-3.5 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p>
                                Choose <strong>Subsidiary</strong> if this
                                entity is a subsidiary of the organisation;
                                otherwise keep it as a{" "}
                                <strong>Business Unit</strong>. A subsidiary
                                behaves exactly like a business unit — this flag
                                is only used to label and filter it.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </span>
                      {singleReadOnly ? (
                        <span className="text-sm font-medium text-foreground py-1">
                          {field.state.value ? "Subsidiary" : "Business Unit"}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2 pt-0.5">
                          <span
                            className={
                              field.state.value
                                ? "text-sm text-muted-foreground"
                                : "text-sm font-semibold text-primary"
                            }
                          >
                            Business Unit
                          </span>
                          <Switch
                            id={field.name}
                            checked={field.state.value}
                            onCheckedChange={(v) => field.handleChange(v)}
                            className="data-unchecked:bg-primary"
                          />
                          <span
                            className={
                              field.state.value
                                ? "text-sm font-semibold text-primary"
                                : "text-sm text-muted-foreground"
                            }
                          >
                            Subsidiary
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </form.Field>
                {singleReadOnly && !readOnly && (
                  <Button
                    type="button"
                    variant="soft"
                    onClick={() => setIsEditMode(true)}
                  >
                    <Pencil />
                    Edit
                  </Button>
                )}
                {readOnly && onEdit && (
                  <Button type="button" variant="soft" onClick={onEdit}>
                    <Pencil />
                    Edit
                  </Button>
                )}
              </div>
            </div>

            <fieldset disabled={singleReadOnly}>
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <form.Field
                  name="country"
                  validators={{ onChange: s.country, onSubmit: s.country }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Country <span className="text-destructive">*</span>
                        </FieldLabel>
                        <SearchableSelect
                          options={countryOptions}
                          value={field.state.value}
                          onChange={(v) => {
                            field.handleChange(v);
                            setSelectedCountry(v);
                            setSelectedState("");
                            form.setFieldValue("state", "");
                            form.setFieldValue("city", "");
                          }}
                          placeholder="Select a country"
                          disabled={sameAsOrg}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="businessUnitName"
                  validators={{
                    onChange: s.businessUnitName,
                    onSubmit: s.businessUnitName,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Business Unit Name{" "}
                          <span className="text-destructive">*</span>
                        </FieldLabel>
                        <Input
                          id={field.name}
                          placeholder="e.g., Acme Corporation LLC"
                          value={field.state.value}
                          onChange={(e) => {
                            field.handleChange(e.target.value);
                            setNameError(null);
                          }}
                          onBlur={field.handleBlur}
                          aria-invalid={isInvalid || !!nameError}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                        {nameError && (
                          <p className="text-sm text-destructive mt-1">
                            {nameError}
                          </p>
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="empCodePrefix"
                  validators={{
                    onChange: s.empCodePrefix,
                    onSubmit: s.empCodePrefix,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const isLocked = hasEmployees;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Employee Code Prefix{" "}
                          <span className="text-destructive">*</span>{" "}
                          {isLocked ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger type="button" tabIndex={-1}>
                                  <Lock className="size-3.5 text-muted-foreground inline" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>
                                    Cannot be changed after employees are
                                    created
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            !singleReadOnly && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger type="button" tabIndex={-1}>
                                    <CircleHelp className="size-3.5 text-muted-foreground inline" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>
                                      Used as the prefix for auto-generated
                                      employee codes (e.g., SIL-0001 for
                                      full-time, SIL-C-0001 for contract).
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )
                          )}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          placeholder="e.g., SIL"
                          value={field.state.value}
                          onChange={(e) => {
                            field.handleChange(e.target.value.toUpperCase());
                            setPrefixError(null);
                          }}
                          onBlur={field.handleBlur}
                          maxLength={10}
                          disabled={isLocked}
                          aria-invalid={isInvalid || !!prefixError}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                        {prefixError && (
                          <p className="text-sm text-destructive mt-1">
                            {prefixError}
                          </p>
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="headName">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor={field.name}>
                        Business Unit Head
                      </FieldLabel>
                      {singleReadOnly ? (
                        <p className="text-sm text-foreground py-2">
                          {field.state.value || "Not assigned"}
                        </p>
                      ) : (
                        <>
                          <Input
                            id={field.name}
                            value={field.state.value || "Not assigned"}
                            disabled
                            className="disabled:opacity-60"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Managed via Assign Heads
                          </p>
                        </>
                      )}
                    </Field>
                  )}
                </form.Field>

                <form.Field
                  name="dateOfIncorporation"
                  validators={{
                    onChange: s.dateOfIncorporation,
                    onSubmit: s.dateOfIncorporation,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Date of Incorporation{" "}
                          <span className="text-destructive">*</span>
                        </FieldLabel>
                        <DatePicker
                          value={
                            field.state.value
                              ? (() => {
                                  const [y, m, d] = field.state.value
                                    .split("-")
                                    .map(Number);
                                  return new Date(y, m - 1, d);
                                })()
                              : undefined
                          }
                          onChange={(val) =>
                            field.handleChange(
                              val
                                ? `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, "0")}-${String(val.getDate()).padStart(2, "0")}`
                                : "",
                            )
                          }
                          maxDate={new Date()}
                          placeholder="Select an incorporation date"
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="ein"
                  validators={{ onChange: s.ein, onSubmit: s.ein }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Employer Identification Number (EIN){" "}
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger type="button" tabIndex={-1}>
                                <CircleHelp className="size-3.5 text-muted-foreground inline" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>
                                  A unique 9-digit number assigned by the IRS
                                  (format: ##-#######)
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </FieldLabel>
                        <Input
                          id={field.name}
                          placeholder="##-#######"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <div className="col-span-full border-t pt-4">
                  <h3 className="text-xs font-semibold text-label uppercase tracking-wide">
                    Employee Code Configuration
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Set the starting number for each employment type. Employee
                    codes will be generated as{" "}
                    <strong>PREFIX-TYPE-NUMBER</strong>.
                  </p>
                  {hasEmployees && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                      <Info className="size-3.5 shrink-0" />
                      <span>
                        Employee code settings cannot be changed after employees
                        have been created in this business unit.
                      </span>
                    </div>
                  )}
                </div>

                {(["fullTime", "contract", "internship"] as const).map(
                  (typeKey) => {
                    const labels = {
                      fullTime: "Full-Time",
                      contract: "Contract",
                      internship: "Internship",
                    };
                    const letters = {
                      fullTime: "F",
                      contract: "C",
                      internship: "I",
                    };
                    const isLocked = hasEmployees;
                    return (
                      <form.Field
                        key={typeKey}
                        name={`empCodeStartFrom.${typeKey}`}
                        validators={{
                          onChange: isLocked ? undefined : validateStartFrom,
                          onSubmit: isLocked ? undefined : validateStartFrom,
                        }}
                      >
                        {(field) => {
                          const isInvalid =
                            field.state.meta.isTouched &&
                            !field.state.meta.isValid;
                          return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>
                              {labels[typeKey]} Start From{" "}
                              <span className="text-destructive">*</span>{" "}
                              {isLocked && (
                                <Lock className="size-3 text-muted-foreground inline" />
                              )}
                            </FieldLabel>
                            <Input
                              id={field.name}
                              type="text"
                              inputMode="numeric"
                              placeholder="e.g. 006 or 1"
                              value={field.state.value ?? ""}
                              onChange={(e) => {
                                // Keep as a digit string so leading zeros survive.
                                const digits = e.target.value
                                  .replace(/\D/g, "")
                                  .slice(0, 7);
                                field.handleChange(
                                  digits === "" ? undefined : digits,
                                );
                              }}
                              onBlur={field.handleBlur}
                              aria-invalid={isInvalid}
                              disabled={isLocked}
                            />
                            {isInvalid && (
                              <FieldError errors={field.state.meta.errors} />
                            )}
                            <form.Subscribe
                              selector={(s) => s.values.empCodePrefix}
                            >
                              {(prefix) => (
                                <p className="text-xs text-muted-foreground mt-1">
                                  Sample:{" "}
                                  <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
                                    {(prefix || "SIL").toUpperCase()}-
                                    {typeKey === "fullTime"
                                      ? ""
                                      : `${letters[typeKey]}-`}
                                    {field.state.value || "0"}
                                  </code>
                                </p>
                              )}
                            </form.Subscribe>
                          </Field>
                          );
                        }}
                      </form.Field>
                    );
                  },
                )}

                <div className="col-span-full border-t pt-4">
                  <h3 className="text-xs font-semibold text-label uppercase tracking-wide">
                    Classification
                  </h3>
                </div>

                <form.Field name="sector">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Sector</FieldLabel>
                        <SearchableSelect
                          options={sectorOptions}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder="Select sector"
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="typeOfBusiness">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Type of Business
                        </FieldLabel>
                        <SearchableSelect
                          options={businessTypeOptions}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder="Select type"
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="natureOfBusiness">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Nature of Business
                        </FieldLabel>
                        <SearchableSelect
                          options={natureOptions}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder="Select nature of business"
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <div className="col-span-full border-t pt-4 flex items-center justify-between gap-4">
                  <h3 className="text-xs font-semibold text-label uppercase tracking-wide">
                    Address
                  </h3>
                  {hasOrgAddress && !singleReadOnly && (
                    <label className="flex items-center gap-2 text-sm font-normal text-muted-foreground cursor-pointer">
                      <Checkbox
                        checked={sameAsOrg}
                        onCheckedChange={(v) => applyOrgAddress(v === true)}
                      />
                      Same as organisation address
                    </label>
                  )}
                </div>

                <form.Field
                  name="addressLine1"
                  validators={{
                    onChange: s.addressLine1,
                    onSubmit: s.addressLine1,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field
                        data-invalid={isInvalid}
                        className="sm:col-span-2 lg:col-span-3"
                      >
                        <FieldLabel htmlFor={field.name}>
                          Address line 1{" "}
                          <span className="text-destructive">*</span>
                        </FieldLabel>
                        <Input
                          id={field.name}
                          placeholder="e.g., 123 Main St"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          disabled={sameAsOrg}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="addressLine2">
                  {(field) => (
                    <Field className="sm:col-span-2 lg:col-span-3">
                      <FieldLabel htmlFor={field.name}>
                        Address line 2
                      </FieldLabel>
                      <Input
                        id={field.name}
                        placeholder="Apartment, suite, unit, building, floor, etc."
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        disabled={sameAsOrg}
                      />
                    </Field>
                  )}
                </form.Field>

                <form.Field
                  name="state"
                  validators={{ onChange: s.state, onSubmit: s.state }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          State <span className="text-destructive">*</span>
                        </FieldLabel>
                        <SearchableSelect
                          options={stateOptions}
                          value={field.state.value}
                          onChange={(v) => {
                            field.handleChange(v);
                            setSelectedState(v);
                            form.setFieldValue("city", "");
                          }}
                          placeholder="Select state"
                          disabled={sameAsOrg || !selectedCountry}
                          emptyMessage={
                            selectedCountry
                              ? "No states found."
                              : "Please select a country first."
                          }
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="city"
                  validators={{ onChange: s.city, onSubmit: s.city }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          City <span className="text-destructive">*</span>
                        </FieldLabel>
                        <SearchableSelect
                          options={cityOptions}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder="Select city"
                          disabled={sameAsOrg || !selectedCountry}
                          emptyMessage={
                            selectedState
                              ? "No cities found."
                              : "Please select a state first."
                          }
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="zipCode"
                  validators={{ onChange: s.zipCode, onSubmit: s.zipCode }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          ZIP Code <span className="text-destructive">*</span>
                        </FieldLabel>
                        <Input
                          id={field.name}
                          placeholder="e.g., 10001 or 10001-1234"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          disabled={sameAsOrg}
                          aria-invalid={isInvalid}
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <div className="col-span-full border-t pt-4">
                  <h3 className="text-xs font-semibold text-label uppercase tracking-wide">
                    Settings
                  </h3>
                </div>

                <form.Field
                  name="financialYear"
                  validators={{
                    onChange: s.financialYear,
                    onSubmit: s.financialYear,
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Fiscal Year{" "}
                          <span className="text-destructive">*</span>
                        </FieldLabel>
                        <SearchableSelect
                          options={FINANCIAL_YEARS}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder="Select financial year type"
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="currency"
                  validators={{ onChange: s.currency, onSubmit: s.currency }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Currency <span className="text-destructive">*</span>
                        </FieldLabel>
                        <SearchableSelect
                          options={currencyOptions}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder={
                            selectedCountry
                              ? "Select currency"
                              : "Select country first"
                          }
                          disabled={sameAsOrg}
                          emptyMessage={
                            selectedCountry
                              ? "No currencies found."
                              : "Please select a country first."
                          }
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field
                  name="timeZone"
                  validators={{ onChange: s.timeZone, onSubmit: s.timeZone }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          Time Zone <span className="text-destructive">*</span>
                        </FieldLabel>
                        <SearchableSelect
                          options={timezoneOptions}
                          value={field.state.value}
                          onChange={(v) => field.handleChange(v)}
                          placeholder={
                            selectedCountry
                              ? "Select Time Zone"
                              : "Select country first"
                          }
                          disabled={sameAsOrg}
                          emptyMessage={
                            selectedCountry
                              ? "No timezones found."
                              : "Please select a country first."
                          }
                        />
                        {isInvalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    );
                  }}
                </form.Field>

                {/* Time format radio */}
                <form.Field name="timeFormat">
                  {(field) => (
                    <Field>
                      <Label className="text-sm font-medium">Time</Label>
                      {singleReadOnly ? (
                        <p className="text-sm text-foreground py-1">
                          {field.state.value === "12" ? "12 Hours" : "24 Hours"}
                        </p>
                      ) : (
                        <div className="flex items-center gap-6">
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <span
                              onClick={() => field.handleChange("12")}
                              className={`flex size-4 items-center justify-center rounded-full border-2 ${
                                field.state.value === "12"
                                  ? "border-foreground bg-foreground"
                                  : "border-muted-foreground/40"
                              }`}
                            >
                              {field.state.value === "12" && (
                                <span className="size-1.5 rounded-full bg-background" />
                              )}
                            </span>
                            12 Hours
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <span
                              onClick={() => field.handleChange("24")}
                              className={`flex size-4 items-center justify-center rounded-full border-2 ${
                                field.state.value === "24"
                                  ? "border-foreground bg-foreground"
                                  : "border-muted-foreground/40"
                              }`}
                            >
                              {field.state.value === "24" && (
                                <span className="size-1.5 rounded-full bg-background" />
                              )}
                            </span>
                            24 Hours
                          </label>
                        </div>
                      )}
                    </Field>
                  )}
                </form.Field>

                {/* Status toggle — only in edit/view mode (create defaults to Active) */}
                {(!!entityId || singleReadOnly) && (
                  <form.Field name="isActive">
                    {(field) => (
                      <Field>
                        <Label className="text-sm font-medium">Status</Label>
                        {singleReadOnly ? (
                          <span
                            className={
                              field.state.value
                                ? "text-sm font-medium text-success"
                                : "text-sm text-muted-foreground"
                            }
                          >
                            {field.state.value ? "Active" : "Inactive"}
                          </span>
                        ) : (
                          <div className="flex items-center gap-3 pt-1">
                            <span className="text-sm text-muted-foreground">
                              Inactive
                            </span>
                            <Switch
                              checked={field.state.value}
                              onCheckedChange={(v) => field.handleChange(v)}
                            />
                            <span className="text-sm text-muted-foreground">
                              Active
                            </span>
                          </div>
                        )}
                      </Field>
                    )}
                  </form.Field>
                )}
              </div>

              <div
                className={`col-span-full ${hasCFs ? "border-t border-border/60 pt-6 mt-2" : ""}`}
              >
                {hasCFs && (
                  <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-label">
                    Additional Information
                  </h3>
                )}
                <SectionCustomFields
                  ref={customFieldsRef}
                  entityType="business_unit"
                  section="default"
                  entityId={entityId}
                  onDirtyChange={setCfDirty}
                  onHasDefinitionsChange={setHasCFs}
                  readOnly={singleReadOnly}
                />
              </div>
            </fieldset>
          </CardContent>
        </Card>
        {readOnly && onCancel && (
          <div className="mt-6 flex justify-end">
            <Button variant="outline" type="button" onClick={onCancel}>
              Back
            </Button>
          </div>
        )}
        {!singleReadOnly && (
          <div className="mt-6 flex justify-end gap-2">
            {/* Multiple mode: Cancel button */}
            {mode === "multiple" && onCancel && (
              <Button variant="outline" type="button" onClick={onCancel}>
                Cancel
              </Button>
            )}

            {/* Single mode: Clear (no BU) or Delete (BU exists) */}
            {mode === "single" && !hasSavedBU && (
              <form.Subscribe selector={(state) => state.isDirty}>
                {(isDirty) => (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => {
                      if (!isDirty && !cfDirty) {
                        form.reset(EMPTY_DEFAULTS);
                        customFieldsRef.current?.discardChanges();
                        setCfDirty(false);
                        setSameAsOrg(false);
                        return;
                      }
                      confirm({
                        title: "Clear Form?",
                        description:
                          "You have unsaved changes. Are you sure you want to clear the form? All entered data will be lost.",
                        confirmText: "Yes, Clear",
                        variant: "destructive",
                        onConfirm: async () => {
                          form.reset(EMPTY_DEFAULTS);
                          customFieldsRef.current?.discardChanges();
                          setCfDirty(false);
                          setSameAsOrg(false);
                        },
                      });
                    }}
                  >
                    Clear
                  </Button>
                )}
              </form.Subscribe>
            )}
            {/* {mode === 'single' && hasSavedBU && onDelete && (
                        <Button variant="destructive" type="button" onClick={onDelete}>
                            Delete
                        </Button>
                    )} */}

            {/* Cancel button for single edit mode */}
            {mode === "single" && hasSavedBU && isEditMode && (
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  confirm({
                    title: "Discard Changes?",
                    description:
                      "Any unsaved changes will be lost. Are you sure you want to cancel?",
                    confirmText: "Discard",
                    onConfirm: async () => {
                      form.reset();
                      customFieldsRef.current?.discardChanges();
                      setCfDirty(false);
                      setIsEditMode(false);
                      setSameAsOrg(false);
                    },
                  });
                }}
              >
                Cancel
              </Button>
            )}

            {/* Save / Update button */}
            <form.Subscribe
              selector={(state) => [
                state.canSubmit,
                state.isSubmitting,
                state.isDirty,
              ]}
            >
              {([canSubmit, isSubmitting, isDirty]) => (
                <Button
                  type="submit"
                  variant="soft"
                  disabled={
                    !canSubmit ||
                    isSubmitting ||
                    isSaving ||
                    (hasSavedBU && !isDirty && !cfDirty)
                  }
                >
                  {isSubmitting || isSaving
                    ? hasSavedBU
                      ? "Updating..."
                      : "Saving..."
                    : hasSavedBU
                      ? "Update"
                      : "Save"}
                </Button>
              )}
            </form.Subscribe>
          </div>
        )}
      </form>
    </div>
  );
});
