import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field, FieldError } from "@/components/ui/field";
import { FormSheet } from "@/components/shared/FormSheet";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { useEffect } from "react";
import { useForm } from "@tanstack/react-form";
import { departmentModelSchema } from "@/modules/org-setup/types/departmentModel";
import type { DepartmentModelProps } from "@/modules/org-setup/types/departmentModel";
import { useBusinessUnits } from "@/hooks/queries/use-business-unit";
import { useAppSelector } from "@/store";
import { useScrollToError } from "@/hooks/use-scroll-to-error";

const s = departmentModelSchema.shape;

const EMPTY_DEFAULTS = {
  businessUnits: [] as string[],
  primaryBusinessUnit: "",
  departmentName: "",
  departmentCode: "",
  description: "",
  departmentHead: "",
  departmentHeadName: "",
  status: true,
};

const FORM_ID = "department-form";

export function DepartmentModel(props: DepartmentModelProps) {
  const { open, onOpenChange, mode } = props;
  const isEdit = mode === "edit";
  const isView = mode === "view";
  const onSave = mode !== "view" ? props.onSave : undefined;

  // Get org to fetch BUs
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const { data: remoteBUs = [] } = useBusinessUnits(savedOrg?.id, {
    is_active: true,
  });
  const scrollToError = useScrollToError('[role="dialog"]');

  // Map BUs to SearchableSelect options
  const buOptions = remoteBUs.map((bu) => ({
    label: bu.business_unit_name,
    value: bu.id,
  }));

  const form = useForm({
    defaultValues: isEdit || isView ? props.data : EMPTY_DEFAULTS,
    onSubmit: ({ value }) => {
      onSave?.(value);
    },
  });

  const isDirty = form.state.isDirty;
  const unsavedGuard = useUnsavedGuard(isDirty, onOpenChange);
  const guardedOpenChange = isView ? onOpenChange : unsavedGuard;

  // Single-BU org → lock the BU picker to the one fixed BU. Either way, when a
  // single BU exists, auto-fill it instead of leaving an empty single-item picker.
  const singleBuMode = !savedOrg?.is_multiple_business_units;
  // Stable primitive (not the re-created buOptions array) so the reset effect
  // doesn't re-run on every render and wipe the user's input.
  const soleBuId = remoteBUs.length === 1 ? remoteBUs[0].id : null;

  useEffect(() => {
    if (!open) return;
    const base = isEdit || isView ? props.data : EMPTY_DEFAULTS;
    // On a fresh Add with exactly one BU, pre-select it so its name shows.
    const next =
      !isEdit && !isView && soleBuId
        ? { ...base, businessUnits: [soleBuId] }
        : base;
    form.reset(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, soleBuId]);

  const title = isView
    ? "View Department"
    : isEdit
      ? "Edit Department"
      : "Add New Department";

  const headerAction =
    props.mode === "view" && props.onEdit ? (
      <Button type="button" variant="soft" onClick={props.onEdit}>
        <Pencil />
        Edit
      </Button>
    ) : undefined;

  const footer = isView ? (
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
      Close
    </Button>
  ) : (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => guardedOpenChange(false)}
      >
        Cancel
      </Button>
      {/* Keep the button enabled on invalid so clicking still triggers
                validation + scroll-to-error. In edit mode, disable when nothing
                has changed (no dirty edits to save). */}
      <form.Subscribe selector={(state) => [state.isSubmitting, state.isDirty]}>
        {([isSubmitting, isDirty]) => (
          <Button
            type="submit"
            form={FORM_ID}
            variant="soft"
            disabled={isSubmitting || (isEdit && !isDirty)}
          >
            {isEdit ? "Update" : "Save"}
          </Button>
        )}
      </form.Subscribe>
    </>
  );

  return (
    <FormSheet
      open={open}
      onOpenChange={guardedOpenChange}
      title={title}
      width={620}
      footer={footer}
      headerAction={headerAction}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
          // Scroll to first invalid field after React renders errors
          requestAnimationFrame(() => scrollToError());
        }}
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {/* Business Units — multi-select from API */}
          <form.Field
            name="businessUnits"
            validators={{ onChange: isView ? undefined : s.businessUnits }}
          >
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;
              const selectedLabels = field.state.value
                .map((v) => buOptions.find((o) => o.value === v)?.label ?? v)
                .join(", ");
              return (
                <Field data-invalid={isInvalid} className="sm:col-span-2">
                  <label className="text-sm font-medium text-label tracking-wider">
                    Business Units <span className="text-destructive">*</span>
                  </label>
                  {isView ? (
                    <p className="text-sm text-foreground py-2">
                      {selectedLabels || "—"}
                    </p>
                  ) : (
                    <>
                      <SearchableSelect
                        multi
                        options={buOptions}
                        value={field.state.value}
                        onChange={(v) => field.handleChange(v)}
                        placeholder={
                          buOptions.length === 0
                            ? "No business units available"
                            : "Select business units..."
                        }
                        disabled={buOptions.length === 0 || singleBuMode}
                      />
                      {isInvalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                      {buOptions.length === 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Please create at least one business unit first.
                        </p>
                      )}
                    </>
                  )}
                </Field>
              );
            }}
          </form.Field>

          {/* Primary Business Unit — shown only when multiple BUs selected */}
          <form.Subscribe selector={(state) => state.values.businessUnits}>
            {(selectedBUs) => {
              if (selectedBUs.length <= 1) return null;
              const primaryOptions = buOptions.filter((o) =>
                selectedBUs.includes(o.value),
              );
              return (
                <form.Field name="primaryBusinessUnit">
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.value;
                    return (
                      <Field data-invalid={isInvalid} className="sm:col-span-2">
                        <label className="text-sm font-medium text-label tracking-wider">
                          Primary Business Unit{" "}
                          <span className="text-destructive">*</span>
                        </label>
                        {isView ? (
                          <p className="text-sm text-foreground py-2">
                            {primaryOptions.find(
                              (o) => o.value === field.state.value,
                            )?.label || "—"}
                          </p>
                        ) : (
                          <>
                            <SearchableSelect
                              options={primaryOptions}
                              value={field.state.value}
                              onChange={(v) => field.handleChange(v)}
                              placeholder="Select primary business unit"
                            />
                            <p className="text-xs text-muted-foreground mt-1">
                              The main business unit this department belongs to
                            </p>
                          </>
                        )}
                      </Field>
                    );
                  }}
                </form.Field>
              );
            }}
          </form.Subscribe>

          {/* Department Name */}
          <form.Field
            name="departmentName"
            validators={{ onChange: isView ? undefined : s.departmentName }}
          >
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={isInvalid}>
                  <label className="text-sm font-medium text-label tracking-wider">
                    Department Name <span className="text-destructive">*</span>
                  </label>
                  {isView ? (
                    <p className="text-sm text-foreground py-2">
                      {field.state.value || "—"}
                    </p>
                  ) : (
                    <>
                      <Input
                        id={field.name}
                        placeholder="Enter department name"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        aria-invalid={isInvalid}
                        maxLength={100}
                      />
                      {isInvalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </>
                  )}
                </Field>
              );
            }}
          </form.Field>

          {/* Department Code */}
          <form.Field
            name="departmentCode"
            validators={{ onChange: isView ? undefined : s.departmentCode }}
          >
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={isInvalid}>
                  <label className="text-sm font-medium text-label tracking-wider">
                    Department Code <span className="text-destructive">*</span>
                  </label>
                  {isView ? (
                    <p className="text-sm text-foreground py-2">
                      {field.state.value || "—"}
                    </p>
                  ) : (
                    <>
                      <Input
                        id={field.name}
                        placeholder="e.g. HR, ENG, FIN"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        aria-invalid={isInvalid}
                        maxLength={20}
                      />
                      {isInvalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </>
                  )}
                </Field>
              );
            }}
          </form.Field>

          {/* Description */}
          <form.Field name="description">
            {(field) => (
              <Field className="sm:col-span-2">
                <label className="text-sm font-medium text-label tracking-wider">
                  Description
                </label>
                {isView ? (
                  <p className="text-sm text-foreground py-2">
                    {field.state.value || "—"}
                  </p>
                ) : (
                  <Textarea
                    id={field.name}
                    placeholder="Enter department description"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    rows={3}
                  />
                )}
              </Field>
            )}
          </form.Field>

          {/* Department Head — display only, managed via Assign Heads */}
          <form.Field name="departmentHeadName">
            {(field) => (
              <Field>
                <label className="text-sm font-medium text-label tracking-wider">
                  Department Head
                </label>
                <p className="text-sm text-foreground py-2">
                  {field.state.value || "—"}
                </p>
                {!isView && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Managed via Assign Heads
                  </p>
                )}
              </Field>
            )}
          </form.Field>

          {/* Status — only in edit/view mode (create defaults to Active) */}
          {(isEdit || isView) && (
            <form.Field name="status">
              {(field) => (
                <Field>
                  <label className="text-sm font-medium text-label tracking-wider">
                    Status
                  </label>
                  {isView ? (
                    <div className="py-2">
                      <span
                        className={
                          field.state.value
                            ? "text-sm font-medium text-success"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {field.state.value ? "Active" : "Inactive"}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">
                        Inactive
                      </span>
                      <Switch
                        checked={field.state.value}
                        onCheckedChange={(checked) =>
                          field.handleChange(checked)
                        }
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
      </form>
    </FormSheet>
  );
}
