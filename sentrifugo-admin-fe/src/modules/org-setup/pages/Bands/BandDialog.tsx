import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FormSheet } from "@/components/shared/FormSheet";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { useCurrencies } from "@/hooks/queries/use-master-data";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import type { Band } from "@/modules/org-setup/types/band";
import { useScrollToError } from "@/hooks/use-scroll-to-error";

// ─── Props ────────────────────────────────────────────────────────────────────

interface BandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: (band: Band) => void;
  editingBand?: Band | null;
  viewMode?: boolean;
  /** In view mode, shows a top-right Edit button that switches to editing */
  onEdit?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BandDialog({
  open,
  onOpenChange,
  onSave,
  editingBand = null,
  viewMode = false,
  onEdit,
}: BandDialogProps) {
  const [name, setName] = React.useState("");
  const [currency, setCurrency] = React.useState("");
  const [minAmount, setMinAmount] = React.useState("");
  const [maxAmount, setMaxAmount] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [status, setStatus] = React.useState(true);
  const [submitted, setSubmitted] = React.useState(false);

  const isDirty =
    !!name.trim() ||
    !!currency.trim() ||
    !!minAmount.trim() ||
    !!maxAmount.trim() ||
    !!notes.trim();
  const unsavedGuard = useUnsavedGuard(isDirty, onOpenChange);
  const guardedOpenChange = viewMode ? onOpenChange : unsavedGuard;
  const scrollToError = useScrollToError('[role="dialog"]');
  // Currencies (master data) — all currencies, not country-scoped.
  const { data: currencyOptions = [] } = useCurrencies();

  React.useEffect(() => {
    if (!open) return;
    if (editingBand) {
      setName(editingBand.name);
      setCurrency(editingBand.currency ?? "");
      setMinAmount(
        editingBand.minAmount != null ? String(editingBand.minAmount) : "",
      );
      setMaxAmount(
        editingBand.maxAmount != null ? String(editingBand.maxAmount) : "",
      );
      setNotes(editingBand.notes);
      setStatus(editingBand.is_active);
    } else {
      setName("");
      setCurrency("");
      setMinAmount("");
      setMaxAmount("");
      setNotes("");
      setStatus(true);
    }
    setSubmitted(false);
  }, [open, editingBand]);

  const trimmedName = name.trim();

  const nameError = submitted
    ? !trimmedName
      ? "Band name is required"
      : trimmedName.length > 100
        ? "Band name must be 100 characters or less"
        : undefined
    : undefined;

  // Currency / Min / Max are optional now — the user fills them in if they want.
  const minNum = minAmount.trim() === "" ? undefined : Number(minAmount);
  const maxNum = maxAmount.trim() === "" ? undefined : Number(maxAmount);
  const minInvalid =
    minAmount.trim() !== "" && (Number.isNaN(minNum) || (minNum as number) < 0);
  const maxInvalid =
    maxAmount.trim() !== "" && (Number.isNaN(maxNum) || (maxNum as number) < 0);
  const rangeInvalid =
    !minInvalid &&
    !maxInvalid &&
    minNum !== undefined &&
    maxNum !== undefined &&
    (maxNum as number) < (minNum as number);

  const amountError = submitted
    ? minInvalid
      ? "Enter a valid minimum amount (0 or more)"
      : maxInvalid
        ? "Enter a valid maximum amount (0 or more)"
        : rangeInvalid
          ? "Maximum must be greater than or equal to minimum"
          : undefined
    : undefined;

  const isValid =
    !!trimmedName &&
    trimmedName.length <= 100 &&
    !minInvalid &&
    !maxInvalid &&
    !rangeInvalid;

  // In edit mode, enable Save only when something actually changed.
  const editMin = editingBand?.minAmount ?? undefined;
  const editMax = editingBand?.maxAmount ?? undefined;
  const hasChanges =
    !editingBand ||
    name.trim() !== editingBand.name ||
    currency.trim().toUpperCase() !== (editingBand.currency ?? "") ||
    minNum !== editMin ||
    maxNum !== editMax ||
    notes.trim() !== (editingBand.notes ?? "") ||
    status !== editingBand.is_active;

  function handleSave() {
    setSubmitted(true);
    if (!isValid) {
      requestAnimationFrame(() => scrollToError());
      return;
    }

    onSave?.({
      id: editingBand?.id ?? "",
      name: name.trim(),
      currency: currency.trim() ? currency.trim().toUpperCase() : undefined,
      minAmount: minNum,
      maxAmount: maxNum,
      effectiveFrom: undefined,
      effectiveTo: undefined,
      notes: notes.trim(),
      is_active: status,
    });
  }

  const title = viewMode ? "View Band" : editingBand ? "Edit Band" : "Add Band";
  const description = viewMode
    ? "Band details are shown below."
    : editingBand
      ? "Update the band details below."
      : "Create a new salary band for your organisation.";

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
      description={description}
      width={580}
      submitLabel={editingBand ? "Save Changes" : "Save"}
      onSubmit={handleSave}
      submitDisabled={!hasChanges}
      footer={viewMode ? viewFooter : undefined}
      headerAction={headerAction}
    >
      <div className="space-y-4">
        {/* Band Name */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-label tracking-wider">
            Band Name <span className="text-destructive">*</span>
          </label>
          {viewMode ? (
            <p className="text-sm text-foreground py-2">{name || "—"}</p>
          ) : (
            <>
              <Input
                placeholder="e.g. Senior Engineer Band"
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

        {/* Currency */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-label tracking-wider">
            Currency
          </label>
          {viewMode ? (
            <p className="text-sm text-foreground py-2">
              {currencyOptions.find((o) => o.value === currency)?.label ||
                currency ||
                "—"}
            </p>
          ) : (
            <SearchableSelect
              options={currencyOptions}
              value={currency}
              onChange={setCurrency}
              placeholder="Select currency"
            />
          )}
        </div>

        {/* Min / Max amounts */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-3">
            <label className="text-sm font-medium text-label tracking-wider">
              Min Amount
            </label>
            {viewMode ? (
              <p className="text-sm text-foreground py-2">
                {minAmount !== "" ? minAmount : "—"}
              </p>
            ) : (
              <Input
                type="number"
                min={0}
                placeholder="e.g. 500000"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
              />
            )}
          </div>
          <div className="space-y-3">
            <label className="text-sm font-medium text-label tracking-wider">
              Max Amount
            </label>
            {viewMode ? (
              <p className="text-sm text-foreground py-2">
                {maxAmount !== "" ? maxAmount : "—"}
              </p>
            ) : (
              <Input
                type="number"
                min={0}
                placeholder="e.g. 1200000"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
              />
            )}
          </div>
          {amountError && (
            <p className="col-span-2 text-sm text-destructive">{amountError}</p>
          )}
        </div>

        {/* Status */}
        {(editingBand || viewMode) && (
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
              <div className="flex items-center gap-3 pt-1">
                <span className="text-sm text-muted-foreground">Inactive</span>
                <Switch checked={status} onCheckedChange={setStatus} />
                <span className="text-sm text-muted-foreground">Active</span>
              </div>
            )}
          </div>
        )}

        {/* Notes */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-label tracking-wider">
            Notes
          </label>
          {viewMode ? (
            <p className="text-sm text-foreground py-2">{notes || "—"}</p>
          ) : (
            <Textarea
              placeholder="Additional notes about this band..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="resize-none"
            />
          )}
        </div>
      </div>
    </FormSheet>
  );
}
