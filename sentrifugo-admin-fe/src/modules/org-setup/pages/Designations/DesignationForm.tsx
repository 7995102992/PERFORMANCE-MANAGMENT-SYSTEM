import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/field";
import { FormSheet } from "@/components/shared/FormSheet";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { usePayGrades } from "@/hooks/queries/use-paygrades";
import { useAppSelector } from "@/store";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import type { DesignationResponseDTO } from "@/api/org-setup/types";

// ─── Shared form-data shape ─────────────────────────────────────────────────

export interface DesignationFormData {
  designationName: string;
  description: string;
  payGradeIds: string[];
  status: boolean;
}

type Mode = "add" | "edit" | "view";

interface DesignationFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  editingDesignation?: DesignationResponseDTO | null;
  onSave?: (data: DesignationFormData) => void;
  onEdit?: () => void;
  isSaving?: boolean;
}

const FORM_ID = "designation-form";

// ─── Component ──────────────────────────────────────────────────────────────

export function DesignationForm({
  open,
  onOpenChange,
  mode,
  editingDesignation = null,
  onSave,
  onEdit,
  isSaving = false,
}: DesignationFormProps) {
  const isView = mode === "view";
  const isEdit = mode === "edit";
  const scrollToError = useScrollToError('[role="dialog"]');

  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const orgId = savedOrg?.id;
  const { data: remotePayGrades = [] } = usePayGrades(orgId);
  const payGradeOptions = remotePayGrades
    .filter((pg) => pg.is_active)
    .map((pg) => ({ label: pg.name, value: pg.id }));

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [status, setStatus] = React.useState(true);
  const [payGradeIds, setPayGradeIds] = React.useState<string[]>([]);
  const [submitted, setSubmitted] = React.useState(false);
  const [hasEdited, setHasEdited] = React.useState(false);

  // Seed state whenever the sheet opens (per designation).
  React.useEffect(() => {
    if (!open) return;
    setName(editingDesignation?.designationName ?? "");
    setDescription(editingDesignation?.description ?? "");
    setStatus(editingDesignation?.is_active ?? true);
    setPayGradeIds(editingDesignation?.payGradeIds ?? []);
    setSubmitted(false);
    setHasEdited(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingDesignation?.id]);

  const guardedOpenChange = useUnsavedGuard(hasEdited && !isView, onOpenChange);

  const trimmedName = name.trim();
  const nameError = submitted
    ? !trimmedName
      ? "Designation name is required"
      : trimmedName.length > 100
        ? "Must be 100 characters or less"
        : undefined
    : undefined;
  const payGradeError =
    submitted && payGradeIds.length === 0
      ? "Select at least one pay grade"
      : undefined;

  const isValid =
    !!trimmedName && trimmedName.length <= 100 && payGradeIds.length > 0;

  function handleSave() {
    setSubmitted(true);
    if (!isValid) {
      requestAnimationFrame(() => scrollToError());
      return;
    }
    onSave?.({
      designationName: trimmedName,
      description: description.trim(),
      payGradeIds,
      status,
    });
  }

  const title = isView
    ? "View Designation"
    : isEdit
      ? "Edit Designation"
      : "Add Designation";

  const headerAction =
    isView && onEdit ? (
      <Button type="button" variant="soft" onClick={onEdit}>
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
        disabled={isSaving}
      >
        Cancel
      </Button>
      <Button type="submit" form={FORM_ID} variant="soft" disabled={isSaving}>
        {isSaving ? "Saving..." : isEdit ? "Update" : "Save"}
      </Button>
    </>
  );

  return (
    <FormSheet
      open={open}
      onOpenChange={isView ? onOpenChange : guardedOpenChange}
      title={title}
      width={560}
      footer={footer}
      headerAction={headerAction}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-4">
          {/* Designation Name */}
          <Field data-invalid={!!nameError}>
            <label className="text-sm font-medium text-label tracking-wider">
              Designation Name <span className="text-destructive">*</span>
            </label>
            {isView ? (
              <p className="text-sm text-foreground py-2">{name || "—"}</p>
            ) : (
              <>
                <Input
                  placeholder="Enter designation name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setHasEdited(true);
                  }}
                  maxLength={100}
                  aria-invalid={!!nameError}
                />
                {nameError && (
                  <p className="text-sm text-destructive">{nameError}</p>
                )}
              </>
            )}
          </Field>

          {/* Pay Grades */}
          <Field data-invalid={!!payGradeError}>
            <label className="text-sm font-medium text-label tracking-wider">
              Pay Grades <span className="text-destructive">*</span>
            </label>
            {isView ? (
              <p className="text-sm text-foreground py-2">
                {payGradeIds.length > 0
                  ? payGradeIds
                      .map(
                        (id) =>
                          editingDesignation?.payGrades?.find(
                            (pg) => pg._id === id,
                          )?.name ??
                          payGradeOptions.find((o) => o.value === id)?.label ??
                          id,
                      )
                      .join(", ")
                  : "—"}
              </p>
            ) : (
              <>
                <SearchableSelect
                  multi
                  options={payGradeOptions}
                  value={payGradeIds}
                  onChange={(v) => {
                    setPayGradeIds(v);
                    setHasEdited(true);
                  }}
                  placeholder={
                    payGradeOptions.length === 0
                      ? "No pay grades available"
                      : "Select pay grades..."
                  }
                  disabled={payGradeOptions.length === 0}
                />
                {payGradeError && (
                  <p className="text-sm text-destructive">{payGradeError}</p>
                )}
                {payGradeOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Create pay grades first to assign them here.
                  </p>
                )}
              </>
            )}
          </Field>

          {/* Description */}
          <Field>
            <label className="text-sm font-medium text-label tracking-wider">
              Description
            </label>
            {isView ? (
              <p className="text-sm text-foreground py-2">
                {description || "—"}
              </p>
            ) : (
              <Textarea
                placeholder="Enter a description for this designation"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setHasEdited(true);
                }}
                rows={3}
              />
            )}
          </Field>

          {/* Status — edit/view only (create defaults to Active) */}
          {(isEdit || isView) && (
            <Field>
              <label className="text-sm font-medium text-label tracking-wider">
                Status
              </label>
              {isView ? (
                <div className="py-2">
                  <span
                    className={
                      status
                        ? "text-sm font-medium text-success"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {status ? "Active" : "Inactive"}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">Inactive</span>
                  <Switch
                    checked={status}
                    onCheckedChange={(v) => {
                      setStatus(v);
                      setHasEdited(true);
                    }}
                  />
                  <span className="text-sm text-muted-foreground">Active</span>
                </div>
              )}
            </Field>
          )}
        </div>
      </form>
    </FormSheet>
  );
}
