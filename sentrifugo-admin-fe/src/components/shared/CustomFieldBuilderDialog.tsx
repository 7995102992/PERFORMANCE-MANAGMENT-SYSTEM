import * as React from "react";
import {
  Calendar,
  CheckSquare,
  ChevronDown,
  CircleDot,
  Hash,
  Link,
  Mail,
  Phone,
  Plus,
  Trash2,
  Type,
  Upload,
  AlignLeft,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "./SearchableSelect";

import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import type {
  CustomFieldType,
  EntityType,
  SectionType,
  FileTypeGroup,
  DefinitionCreateDTO,
  DefinitionUpdateDTO,
  CustomFieldDefinition,
  OptionCreateDTO,
} from "@/types/custom-fields";
import { OPTION_FIELD_TYPES } from "@/types/custom-fields";

// ─── Field type grid ─────────────────────────────────────────────────────────

const FIELD_TYPES: {
  value: CustomFieldType;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: "text", label: "Text", icon: <Type className="h-5 w-5" /> },
  {
    value: "textarea",
    label: "Textarea",
    icon: <AlignLeft className="h-5 w-5" />,
  },
  { value: "number", label: "Number", icon: <Hash className="h-5 w-5" /> },
  { value: "date", label: "Date", icon: <Calendar className="h-5 w-5" /> },
  {
    value: "single_select",
    label: "Dropdown",
    icon: <ChevronDown className="h-5 w-5" />,
  },
  {
    value: "multi_select",
    label: "Multi Select",
    icon: <CheckSquare className="h-5 w-5" />,
  },
  { value: "radio", label: "Radio", icon: <CircleDot className="h-5 w-5" /> },
  {
    value: "checkbox",
    label: "Checkbox",
    icon: <CheckSquare className="h-5 w-5" />,
  },
  { value: "file", label: "Upload", icon: <Upload className="h-5 w-5" /> },
  { value: "url", label: "URL", icon: <Link className="h-5 w-5" /> },
  { value: "email", label: "Email", icon: <Mail className="h-5 w-5" /> },
  { value: "phone", label: "Phone", icon: <Phone className="h-5 w-5" /> },
];

const MAX_SIZE_OPTIONS = [
  { label: "2 MB", value: "2" },
  { label: "5 MB", value: "5" },
  { label: "10 MB", value: "10" },
  { label: "25 MB", value: "25" },
];

const FILE_TYPE_OPTIONS = [
  { label: "PDF", value: "pdf" },
  { label: "Word Documents", value: "word" },
  { label: "Spreadsheets", value: "excel" },
  { label: "CSV", value: "csv" },
  { label: "Images", value: "images" },
];
const ADD_ACTION_BUTTON_CLASS =
  "border-primary/30 text-primary hover:bg-primary/10 hover:text-primary";

// ─── Props ───────────────────────────────────────────────────────────────────

interface CustomFieldBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (definition: DefinitionCreateDTO, options: OptionCreateDTO[]) => void;
  onUpdate?: (
    id: string,
    definition: DefinitionUpdateDTO,
    options: OptionCreateDTO[],
  ) => void;
  editingField?: CustomFieldDefinition | null;
  editingOptions?: OptionCreateDTO[];
  entityType: EntityType;
  section?: SectionType;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CustomFieldBuilderDialog({
  open,
  onOpenChange,
  onSave,
  onUpdate,
  editingField = null,
  editingOptions = [],
  entityType,
  section = "default",
}: CustomFieldBuilderDialogProps) {
  const [name, setName] = React.useState("");
  const [fieldType, setFieldType] = React.useState<CustomFieldType | "">("");
  const [options, setOptions] = React.useState<
    { label: string; value: string }[]
  >([{ label: "", value: "" }]);
  const [maxSizeMB, setMaxSizeMB] = React.useState("5");
  const [allowedFileTypes, setAllowedFileTypes] = React.useState<string[]>([]);
  const [placeholder, setPlaceholder] = React.useState("");
  const [helpText, setHelpText] = React.useState("");
  const [isRequired, setIsRequired] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  const isDirty =
    !!name.trim() ||
    !!fieldType ||
    options.some((o) => o.label.trim()) ||
    isRequired;
  const guardedOpenChange = useUnsavedGuard(isDirty, onOpenChange);

  React.useEffect(() => {
    if (!open) return;
    if (editingField) {
      setName(editingField.name);
      setFieldType(editingField.field_type);
      setOptions(
        editingOptions.length > 0
          ? editingOptions.map((o) => ({ label: o.label, value: o.value }))
          : [{ label: "", value: "" }],
      );
      setMaxSizeMB(
        editingField.file_settings?.max_size_mb
          ? String(editingField.file_settings.max_size_mb)
          : "5",
      );
      setAllowedFileTypes(editingField.file_settings?.allowed_file_types ?? []);
      setPlaceholder(editingField.placeholder ?? "");
      setHelpText(editingField.help_text ?? "");
      setIsRequired(editingField.is_required);
    } else {
      setName("");
      setFieldType("");
      setOptions([{ label: "", value: "" }]);
      setMaxSizeMB("5");
      setAllowedFileTypes([]);
      setPlaceholder("");
      setHelpText("");
      setIsRequired(false);
    }
    setSubmitted(false);
  }, [open, editingField, editingOptions]);

  const needsOptions = OPTION_FIELD_TYPES.includes(
    fieldType as CustomFieldType,
  );
  const isFileType = fieldType === "file";
  const filledOptions = options.filter((o) => o.label.trim().length > 0);

  // ── Validation ──────────────────────────────────────────────────────────────

  const trimmedName = name.trim();
  const nameError = submitted
    ? !trimmedName
      ? "Field name is required"
      : trimmedName.length > 100
        ? "Must be 100 characters or less"
        : undefined
    : undefined;
  const typeError =
    submitted && !fieldType ? "Field type is required" : undefined;
  const optionsError =
    submitted && needsOptions && filledOptions.length === 0
      ? "At least one option is required"
      : undefined;
  const maxSizeError =
    submitted && isFileType && !maxSizeMB
      ? "Max file size is required"
      : undefined;
  const fileTypesError =
    submitted && isFileType && allowedFileTypes.length === 0
      ? "Select at least one file type"
      : undefined;

  const isValid =
    !!trimmedName &&
    trimmedName.length <= 100 &&
    !!fieldType &&
    (!needsOptions || filledOptions.length > 0) &&
    (!isFileType || (!!maxSizeMB && allowedFileTypes.length > 0));

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handleSave() {
    setSubmitted(true);
    if (!isValid) return;

    const optionDTOs: OptionCreateDTO[] = needsOptions
      ? filledOptions.map((o, i) => ({
          label: o.label.trim(),
          value:
            o.value.trim() ||
            o.label
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_|_$/g, ""),
          sort_order: i,
        }))
      : [];

    const definitionPayload: DefinitionCreateDTO = {
      entity_type: entityType,
      section,
      name: trimmedName,
      field_type: fieldType as CustomFieldType,
      file_settings: isFileType
        ? {
            max_size_mb: Number(maxSizeMB),
            allowed_file_types: allowedFileTypes as FileTypeGroup[],
          }
        : null,
      placeholder: placeholder.trim() || null,
      help_text: helpText.trim() || null,
      is_required: isRequired,
    };

    if (editingField && onUpdate) {
      const updatePayload: DefinitionUpdateDTO = {
        name: trimmedName,
        field_type: fieldType as CustomFieldType,
        file_settings: isFileType
          ? {
              max_size_mb: Number(maxSizeMB),
              allowed_file_types: allowedFileTypes as FileTypeGroup[],
            }
          : null,
        placeholder: placeholder.trim() || null,
        help_text: helpText.trim() || null,
        is_required: isRequired,
      };
      onUpdate(editingField.id, updatePayload, optionDTOs);
    } else {
      onSave(definitionPayload, optionDTOs);
    }
    onOpenChange(false);
  }

  function autoValue(label: string): string {
    return label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-[540px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {editingField ? "Edit Custom Field" : "Add Custom Field"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-5 pr-1 py-1">
          {/* Field Name */}
          <div className="space-y-3">
            <Label>
              Field Name <span className="text-destructive">*</span>
            </Label>
            <Input
              placeholder="e.g. Custom Field Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
            {nameError && (
              <p className="text-sm text-destructive">{nameError}</p>
            )}
          </div>

          {/* Field Type */}
          <div className="space-y-3">
            <Label>
              Field Type <span className="text-destructive">*</span>
            </Label>
            <div className="grid grid-cols-4 gap-2">
              {FIELD_TYPES.map((ft) => (
                <button
                  key={ft.value}
                  type="button"
                  onClick={() => setFieldType(ft.value)}
                  className={[
                    "flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    fieldType === ft.value
                      ? "border-primary bg-primary/5 ring-2 ring-primary/20 text-primary"
                      : "border-border hover:border-muted-foreground/40 text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  {ft.icon}
                  <span className="text-xs font-medium leading-none">
                    {ft.label}
                  </span>
                </button>
              ))}
            </div>
            {typeError && (
              <p className="text-sm text-destructive">{typeError}</p>
            )}
          </div>

          {/* Options (dropdown/radio/checkbox/multi_select) */}
          {needsOptions && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <Label>
                Options <span className="text-destructive">*</span>
              </Label>
              {optionsError && (
                <p className="text-sm text-destructive">{optionsError}</p>
              )}
              <div className="space-y-3">
                {options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder={`Option ${i + 1} label`}
                      value={opt.label}
                      onChange={(e) => {
                        const updated = [...options];
                        updated[i] = {
                          label: e.target.value,
                          value: autoValue(e.target.value),
                        };
                        setOptions(updated);
                      }}
                      className="flex-1"
                    />
                    {options.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setOptions(options.filter((_, idx) => idx !== i))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={`w-full ${ADD_ACTION_BUTTON_CLASS}`}
                  onClick={() =>
                    setOptions([...options, { label: "", value: "" }])
                  }
                >
                  <Plus /> Add Option
                </Button>
              </div>
            </div>
          )}

          {/* File upload settings */}
          {isFileType && (
            <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
              <Label className="text-sm font-medium">
                File Upload Settings
              </Label>
              <div className="space-y-3">
                <Label>
                  Max File Size <span className="text-destructive">*</span>
                </Label>
                <SearchableSelect
                  options={MAX_SIZE_OPTIONS}
                  value={maxSizeMB}
                  onChange={(v) => setMaxSizeMB(v)}
                  placeholder="Select max size"
                  searchable={false}
                />
                {maxSizeError && (
                  <p className="text-sm text-destructive">{maxSizeError}</p>
                )}
              </div>
              <div className="space-y-3">
                <Label>
                  Allowed File Types <span className="text-destructive">*</span>
                </Label>
                <SearchableSelect
                  multi
                  options={FILE_TYPE_OPTIONS}
                  value={allowedFileTypes}
                  onChange={(v) => setAllowedFileTypes(v)}
                  placeholder="Select allowed types..."
                />
                {fileTypesError && (
                  <p className="text-sm text-destructive">{fileTypesError}</p>
                )}
              </div>
            </div>
          )}

          {/* Placeholder — only for input-style fields */}
          {fieldType &&
            !["radio", "checkbox", "file", "multi_select"].includes(
              fieldType,
            ) && (
              <div className="space-y-3">
                <Label>Placeholder</Label>
                <Input
                  placeholder={`e.g. Enter ${name.trim() || "value"}...`}
                  value={placeholder}
                  onChange={(e) => setPlaceholder(e.target.value)}
                  maxLength={200}
                />
              </div>
            )}

          {/* Help text */}
          <div className="space-y-3">
            <Label>Help Text</Label>
            <Input
              placeholder="e.g. Required for emergency records"
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              maxLength={500}
            />
          </div>

          {/* Required toggle */}
          <div className="flex items-center justify-between rounded-lg border p-3.5">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Required Field</p>
              <p className="text-xs text-muted-foreground">
                User must fill this out before saving
              </p>
            </div>
            <Switch checked={isRequired} onCheckedChange={setIsRequired} />
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => guardedOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave}>
            {editingField ? "Save Changes" : "Add Field"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
