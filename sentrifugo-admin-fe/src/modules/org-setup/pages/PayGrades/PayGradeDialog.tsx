import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FormSheet } from "@/components/shared/FormSheet";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import type { PayGrade } from "@/modules/org-setup/types/paygrade";
import { useScrollToError } from "@/hooks/use-scroll-to-error";

// ─── Props ────────────────────────────────────────────────────────────────────

interface PayGradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: (payGrade: PayGrade) => void;
  editingPayGrade?: PayGrade | null;
  bandOptions: { label: string; value: string }[];
  viewMode?: boolean;
  /** In view mode, shows a top-right Edit button that switches to editing */
  onEdit?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PayGradeDialog({
  open,
  onOpenChange,
  onSave,
  editingPayGrade = null,
  bandOptions,
  viewMode = false,
  onEdit,
}: PayGradeDialogProps) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [bandIds, setBandIds] = React.useState<string[]>([]);
  const [status, setStatus] = React.useState(true);
  const [submitted, setSubmitted] = React.useState(false);

  const isDirty =
    !!name.trim() ||
    !!description.trim() ||
    bandIds.length > 0;
  const unsavedGuard = useUnsavedGuard(isDirty, onOpenChange);
  const guardedOpenChange = viewMode ? onOpenChange : unsavedGuard;
  const scrollToError = useScrollToError('[role="dialog"]');

  React.useEffect(() => {
    if (!open) return;
    if (editingPayGrade) {
      setName(editingPayGrade.name);
      setDescription(editingPayGrade.description);
      setBandIds(editingPayGrade.bandIds);
      setStatus(editingPayGrade.is_active);
    } else {
      setName("");
      setDescription("");
      setBandIds([]);
      setStatus(true);
    }
    setSubmitted(false);
  }, [open, editingPayGrade]);

  const trimmedName = name.trim();
  const nameError = submitted
    ? !trimmedName
      ? "Pay grade name is required"
      : trimmedName.length > 100
        ? "Must be 100 characters or less"
        : undefined
    : undefined;
  const bandError =
    submitted && bandIds.length === 0 ? "Select at least one band" : undefined;

  const isValid =
    !!trimmedName &&
    trimmedName.length <= 100 &&
    bandIds.length > 0;

  // In edit mode, enable Save only when something actually changed.
  // (Create mode is always considered changed so the button stays enabled.)
  const hasChanges =
    !editingPayGrade ||
    name.trim() !== editingPayGrade.name ||
    description.trim() !== (editingPayGrade.description ?? "") ||
    bandIds.join(",") !== editingPayGrade.bandIds.join(",") ||
    status !== editingPayGrade.is_active;

  function handleSave() {
    setSubmitted(true);
    if (!isValid) {
      requestAnimationFrame(() => scrollToError());
      return;
    }

    const bandLabels = bandIds.map(
      (id) => bandOptions.find((b) => b.value === id)?.label ?? id,
    );

    onSave?.({
      id: editingPayGrade?.id ?? "",
      name: trimmedName,
      description: description.trim(),
      bandIds,
      bandNames: bandLabels,
      is_active: status,
    });
  }

  const title = viewMode
    ? "View Pay Grade"
    : editingPayGrade
      ? "Edit Pay Grade"
      : "Add Pay Grade";
  const description2 = viewMode
    ? "Pay grade details are shown below."
    : editingPayGrade
      ? "Update the pay grade details below."
      : "Fill in the details for the new pay grade.";

  const viewFooter = (
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
      Close
    </Button>
  );

  const headerAction =
    viewMode && onEdit ? (
      <Button type="button" variant="soft" onClick={onEdit}>
        <Pencil />
        Edit
      </Button>
    ) : undefined;

  return (
    <FormSheet
      open={open}
      onOpenChange={guardedOpenChange}
      title={title}
      description={description2}
      width={500}
      submitLabel={editingPayGrade ? "Save Changes" : "Save"}
      onSubmit={handleSave}
      submitDisabled={!hasChanges}
      footer={viewMode ? viewFooter : undefined}
      headerAction={headerAction}
    >
      <div className="space-y-4">
        {/* Name */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-label tracking-wider">
            Pay Grade Name <span className="text-destructive">*</span>
          </label>
          {viewMode ? (
            <p className="text-sm text-foreground py-2">{name || "—"}</p>
          ) : (
            <>
              <Input
                placeholder="Enter pay grade name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
              {nameError && (
                <p className="text-sm text-destructive">{nameError}</p>
              )}
            </>
          )}
        </div>

        {/* Description */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-label tracking-wider">
            Description
          </label>
          {viewMode ? (
            <p className="text-sm text-foreground py-2">{description || "—"}</p>
          ) : (
            <Textarea
              placeholder="Provide a detailed description for this pay grade"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="resize-none"
            />
          )}
        </div>

        {/* Bands (multi) */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-label tracking-wider">
            Bands <span className="text-destructive">*</span>
          </label>
          {viewMode ? (
            <p className="text-sm text-foreground py-2">
              {bandIds.length > 0
                ? bandIds
                    .map(
                      (id) =>
                        bandOptions.find((b) => b.value === id)?.label ?? id,
                    )
                    .join(", ")
                : "—"}
            </p>
          ) : (
            <>
              <SearchableSelect
                multi
                options={bandOptions}
                value={bandIds}
                onChange={(v) => setBandIds(v)}
                placeholder="Select bands..."
              />
              {bandError && (
                <p className="text-sm text-destructive">{bandError}</p>
              )}
            </>
          )}
        </div>

        {/* Status — only in edit/view mode (create defaults to Active) */}
        {(editingPayGrade || viewMode) && (
          <div className="space-y-3">
            <label className="text-sm font-medium text-label tracking-wider">
              Status
            </label>
            {viewMode ? (
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
                <Switch checked={status} onCheckedChange={setStatus} />
                <span className="text-sm text-muted-foreground">Active</span>
              </div>
            )}
          </div>
        )}
      </div>
    </FormSheet>
  );
}
