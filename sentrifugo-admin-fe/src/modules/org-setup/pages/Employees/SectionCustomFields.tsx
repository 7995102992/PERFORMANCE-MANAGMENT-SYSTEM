import * as React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Button } from "@/components/ui/button";
import { CustomFieldRenderer } from "@/components/shared/CustomFieldRenderer";
import { CustomFieldBuilderDialog } from "@/components/shared/CustomFieldBuilderDialog";
import {
  useCustomFieldDefinitions,
  useCustomFieldValues,
} from "@/hooks/queries/use-custom-fields";
import {
  definitionService,
  optionService,
  valueService,
} from "@/api/custom-fields";
import { queryKeys } from "@/api/query-keys";
import type {
  EntityType,
  SectionType,
  DefinitionCreateDTO,
  DefinitionUpdateDTO,
  OptionCreateDTO,
  CustomFieldDefinition,
  CustomFieldOption,
  ValueUpsertDTO,
} from "@/types/custom-fields";
import { OPTION_FIELD_TYPES } from "@/types/custom-fields";
import { assetService } from "@/api/assets";

const OPTION_FIELD_TYPES_SET = new Set(OPTION_FIELD_TYPES);
const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

// ─── Pending operation types ────────────────────────────────────────────────

interface PendingCreate {
  tempId: string;
  payload: DefinitionCreateDTO;
  options: OptionCreateDTO[];
}

interface PendingUpdate {
  payload: DefinitionUpdateDTO;
  newOptions: OptionCreateDTO[];
}

// ─── Props / Ref ────────────────────────────────────────────────────────────

export interface SectionCustomFieldsRef {
  saveValues: (targetEntityId: string) => Promise<void>;
  discardChanges: () => void;
  /** Runs required-field validation and surfaces inline errors. Returns true if valid. */
  validate: () => boolean;
}

interface SectionCustomFieldsProps {
  entityType: EntityType;
  section: SectionType;
  entityId?: string;
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onHasDefinitionsChange?: (has: boolean) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempCounter = 0;
function nextTempId() {
  return `__temp_cf_${++tempCounter}`;
}

function isTempId(id: string) {
  return id.startsWith("__temp_cf_");
}

// Treat 404 as already-applied so partial-save retries are idempotent.
async function tolerate404<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) return undefined;
    throw err;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export const SectionCustomFields = React.forwardRef<
  SectionCustomFieldsRef,
  SectionCustomFieldsProps
>(function SectionCustomFields(
  {
    entityType,
    section,
    entityId,
    readOnly = false,
    onDirtyChange,
    onHasDefinitionsChange,
  },
  ref,
) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingField, setEditingField] =
    React.useState<CustomFieldDefinition | null>(null);
  const [editingOptions, setEditingOptions] = React.useState<OptionCreateDTO[]>(
    [],
  );

  // Local value state — holds unsaved value changes
  const [localValues, setLocalValues] = React.useState<
    Record<string, { value: string | null; option_ids: string[] }>
  >({});

  // Inline error state — defId → error message (only required-field violations)
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function clearError(defId: string) {
    setErrors((prev) => {
      if (!prev[defId]) return prev;
      const next = { ...prev };
      delete next[defId];
      return next;
    });
  }

  // Pending definition changes — deferred until parent form submit
  const [pendingCreates, setPendingCreates] = React.useState<PendingCreate[]>(
    [],
  );
  const [pendingUpdates, setPendingUpdates] = React.useState(
    () => new Map<string, PendingUpdate>(),
  );
  const [pendingDeletes, setPendingDeletes] = React.useState(
    () => new Set<string>(),
  );

  // API data
  const { data: definitions = [] } = useCustomFieldDefinitions(
    entityType,
    section,
  );
  const { data: valuesResponse } = useCustomFieldValues(entityType, entityId);

  // ── Dirty tracking ────────────────────────────────────────────────────────

  React.useEffect(() => {
    const hasLocalValues = Object.keys(localValues).length > 0;
    const hasPendingDefs =
      pendingCreates.length > 0 ||
      pendingUpdates.size > 0 ||
      pendingDeletes.size > 0;
    onDirtyChange?.(hasLocalValues || hasPendingDefs);
  }, [
    localValues,
    pendingCreates,
    pendingUpdates,
    pendingDeletes,
    onDirtyChange,
  ]);

  // ── Options for create mode (no entityId) ─────────────────────────────────

  const optionDefinitions = React.useMemo(
    () =>
      !entityId
        ? definitions.filter((d) => OPTION_FIELD_TYPES_SET.has(d.field_type))
        : [],
    [entityId, definitions],
  );

  const standaloneOptionQueries = useQueries({
    queries: optionDefinitions.map((d) => ({
      queryKey: queryKeys.customFields.options(d.id),
      queryFn: () => optionService.list(d.id),
      staleTime: 2 * 60 * 1000,
    })),
  });

  // ── Value map from API (edit mode) ────────────────────────────────────────

  const valueMap = React.useMemo(() => {
    const map: Record<string, { value: string | null; option_ids: string[] }> =
      {};
    if (valuesResponse?.fields) {
      for (const f of valuesResponse.fields) {
        if (f.value) {
          map[f.definition.id] = {
            value: f.value.value ?? null,
            option_ids: f.value.option_ids,
          };
        }
      }
    }
    return map;
  }, [valuesResponse]);

  // ── Base options map from API ─────────────────────────────────────────────

  const baseOptionsMap = React.useMemo(() => {
    const map: Record<string, CustomFieldOption[]> = {};
    if (entityId && valuesResponse?.fields) {
      for (const f of valuesResponse.fields) {
        map[f.definition.id] = f.options;
      }
    } else {
      optionDefinitions.forEach((d, i) => {
        const q = standaloneOptionQueries[i];
        if (q?.data) map[d.id] = q.data;
      });
    }
    return map;
  }, [entityId, valuesResponse, optionDefinitions, standaloneOptionQueries]);

  // ── Visible definitions: existing (minus deletes, with updates) + pending creates

  const visibleDefinitions = React.useMemo(() => {
    const existing = definitions
      .filter((d) => !pendingDeletes.has(d.id))
      .map((d) => {
        const update = pendingUpdates.get(d.id);
        if (update) return { ...d, ...update.payload } as CustomFieldDefinition;
        return d;
      });

    const created: CustomFieldDefinition[] = pendingCreates.map((pc, idx) => ({
      id: pc.tempId,
      organisation_id: "",
      entity_type: entityType,
      section,
      name: pc.payload.name,
      key: "",
      field_type: pc.payload.field_type,
      file_settings: pc.payload.file_settings ?? null,
      placeholder: pc.payload.placeholder ?? null,
      help_text: pc.payload.help_text ?? null,
      is_required: pc.payload.is_required ?? false,
      sort_order: pc.payload.sort_order ?? definitions.length + idx,
      is_active: true,
    }));

    return [...existing, ...created];
  }, [
    definitions,
    pendingCreates,
    pendingUpdates,
    pendingDeletes,
    entityType,
    section,
  ]);

  // Notify parent about definition visibility
  React.useEffect(() => {
    onHasDefinitionsChange?.(visibleDefinitions.length > 0);
  }, [visibleDefinitions.length, onHasDefinitionsChange]);

  // ── Visible options map: base + pending create/update options ──────────────

  const visibleOptionsMap = React.useMemo(() => {
    const map: Record<string, CustomFieldOption[]> = { ...baseOptionsMap };

    for (const pc of pendingCreates) {
      map[pc.tempId] = pc.options.map((o, i) => ({
        id: `${pc.tempId}_opt_${i}`,
        field_definition_id: pc.tempId,
        label: o.label,
        value: o.value,
        sort_order: o.sort_order ?? i,
        is_active: true,
      }));
    }

    for (const [defId, update] of pendingUpdates) {
      if (update.newOptions.length > 0) {
        map[defId] = update.newOptions.map((o, i) => ({
          id: `pending_upd_${defId}_opt_${i}`,
          field_definition_id: defId,
          label: o.label,
          value: o.value,
          sort_order: o.sort_order ?? i,
          is_active: true,
        }));
      }
    }

    return map;
  }, [baseOptionsMap, pendingCreates, pendingUpdates]);

  // ── Value helpers ─────────────────────────────────────────────────────────

  function getFieldValue(defId: string) {
    return (
      localValues[defId] ?? valueMap[defId] ?? { value: null, option_ids: [] }
    );
  }

  function handleValueChange(defId: string, value: string | null) {
    setLocalValues((prev) => ({
      ...prev,
      [defId]: { ...getFieldValue(defId), value },
    }));
    clearError(defId);
  }

  function handleOptionIdsChange(defId: string, option_ids: string[]) {
    setLocalValues((prev) => ({
      ...prev,
      [defId]: { ...getFieldValue(defId), option_ids },
    }));
    clearError(defId);
  }

  async function handleFileChange(defId: string, file: File | null) {
    if (!file) {
      handleValueChange(defId, null);
      return;
    }
    const asset = await assetService.upload(file, "general");
    handleValueChange(defId, asset.id);
  }

  // ── Deferred definition CRUD ──────────────────────────────────────────────

  function handleSaveDefinition(
    payload: DefinitionCreateDTO,
    options: OptionCreateDTO[],
  ) {
    const tempId = nextTempId();
    setPendingCreates((prev) => [...prev, { tempId, payload, options }]);
  }

  function handleUpdateDefinition(
    id: string,
    payload: DefinitionUpdateDTO,
    newOptions: OptionCreateDTO[],
  ) {
    if (isTempId(id)) {
      setPendingCreates((prev) =>
        prev.map((pc) =>
          pc.tempId === id
            ? {
                ...pc,
                payload: {
                  ...pc.payload,
                  name: payload.name ?? pc.payload.name,
                  field_type: (payload.field_type ??
                    pc.payload.field_type) as DefinitionCreateDTO["field_type"],
                  file_settings:
                    payload.file_settings !== undefined
                      ? payload.file_settings
                      : pc.payload.file_settings,
                  placeholder:
                    payload.placeholder !== undefined
                      ? payload.placeholder
                      : pc.payload.placeholder,
                  help_text:
                    payload.help_text !== undefined
                      ? payload.help_text
                      : pc.payload.help_text,
                  is_required:
                    payload.is_required !== undefined
                      ? payload.is_required
                      : pc.payload.is_required,
                },
                options: newOptions,
              }
            : pc,
        ),
      );
    } else {
      setPendingUpdates((prev) => {
        const next = new Map(prev);
        next.set(id, { payload, newOptions });
        return next;
      });
    }
  }

  function handleEdit(fieldDef: CustomFieldDefinition) {
    const pendingCreate = pendingCreates.find(
      (pc) => pc.tempId === fieldDef.id,
    );
    if (pendingCreate) {
      setEditingField(fieldDef);
      setEditingOptions(pendingCreate.options);
    } else {
      const pendingUpdate = pendingUpdates.get(fieldDef.id);
      const currentOptions =
        pendingUpdate?.newOptions ??
        (baseOptionsMap[fieldDef.id] ?? []).map((o) => ({
          label: o.label,
          value: o.value,
          sort_order: o.sort_order,
        }));
      setEditingField(fieldDef);
      setEditingOptions(currentOptions);
    }
    setDialogOpen(true);
  }

  function handleDelete(defId: string) {
    if (isTempId(defId)) {
      setPendingCreates((prev) => prev.filter((pc) => pc.tempId !== defId));
      setLocalValues((prev) => {
        const next = { ...prev };
        delete next[defId];
        return next;
      });
      clearError(defId);
      return;
    }

    const fieldName =
      definitions.find((d) => d.id === defId)?.name ?? "this field";
    const entityLabel = entityType.replace(/_/g, " ") + "s";
    confirm({
      title: "Remove Custom Field",
      description: `"${fieldName}" will be removed from ALL ${entityLabel} when you save, along with any values already entered. Continue?`,
      confirmText: "Remove",
      onConfirm: () => {
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.add(defId);
          return next;
        });
        setPendingUpdates((prev) => {
          const next = new Map(prev);
          next.delete(defId);
          return next;
        });
        setLocalValues((prev) => {
          const next = { ...prev };
          delete next[defId];
          return next;
        });
        clearError(defId);
      },
    });
  }

  function handleAdd() {
    setEditingField(null);
    setEditingOptions([]);
    setDialogOpen(true);
  }

  // ── Save all pending changes + values (called by parent on form submit) ──

  React.useImperativeHandle(
    ref,
    () => ({
      saveValues: async (targetEntityId: string) => {
        // 1. Execute pending deletes (404 = already removed on a prior partial save)
        for (const defId of pendingDeletes) {
          await tolerate404(definitionService.remove(defId));
        }

        // 2. Execute pending updates + option diffs (404s tolerated for the same reason)
        for (const [defId, update] of pendingUpdates) {
          const updated = await tolerate404(
            definitionService.update(defId, update.payload),
          );
          if (!updated) continue;

          const existing = baseOptionsMap[defId] ?? [];
          const existingByValue = new Map(existing.map((o) => [o.value, o]));
          const newValueSet = new Set(update.newOptions.map((o) => o.value));

          for (const opt of existing) {
            if (!newValueSet.has(opt.value))
              await tolerate404(optionService.remove(opt.id));
          }
          for (const opt of update.newOptions) {
            if (!existingByValue.has(opt.value))
              await optionService.create(defId, opt);
          }
        }

        // 3. Execute pending creates → build temp-to-real ID maps
        const tempToRealDefId = new Map<string, string>();
        const tempDefToOptMapping = new Map<string, Map<string, string>>();

        for (const pc of pendingCreates) {
          const created = await definitionService.create(pc.payload);
          tempToRealDefId.set(pc.tempId, created.id);

          const optMap = new Map<string, string>();
          for (const opt of pc.options) {
            const createdOpt = await optionService.create(created.id, opt);
            optMap.set(opt.value, createdOpt.id);
          }
          tempDefToOptMapping.set(pc.tempId, optMap);
        }

        // 4. Build value upsert items
        const items: ValueUpsertDTO[] = [];

        for (const def of definitions) {
          if (pendingDeletes.has(def.id)) continue;
          const val = localValues[def.id];
          if (val) {
            items.push({
              field_definition_id: def.id,
              value: val.value,
              option_ids: val.option_ids,
            });
          }
        }

        for (const pc of pendingCreates) {
          const realDefId = tempToRealDefId.get(pc.tempId)!;
          const val = localValues[pc.tempId];
          if (val && (val.value || val.option_ids.length > 0)) {
            let mappedOptionIds = val.option_ids;
            const optMapping = tempDefToOptMapping.get(pc.tempId);
            if (optMapping && val.option_ids.length > 0) {
              const tempOptsById = new Map(
                pc.options.map((o, i) => [`${pc.tempId}_opt_${i}`, o.value]),
              );
              mappedOptionIds = val.option_ids
                .map((tempOptId) => {
                  const optValue = tempOptsById.get(tempOptId);
                  return optValue ? optMapping.get(optValue) : undefined;
                })
                .filter((id): id is string => !!id);
            }
            items.push({
              field_definition_id: realDefId,
              value: val.value,
              option_ids: mappedOptionIds,
            });
          }
        }

        if (items.length > 0) {
          await valueService.upsertEntityValues(
            entityType,
            targetEntityId,
            items,
          );
        }

        // 5. Reset pending state and refresh queries
        setPendingCreates([]);
        setPendingUpdates(new Map());
        setPendingDeletes(new Set());
        setLocalValues({});
        setErrors({});
        queryClient.invalidateQueries({ queryKey: queryKeys.customFields.all });
      },

      discardChanges: () => {
        setPendingCreates([]);
        setPendingUpdates(new Map());
        setPendingDeletes(new Set());
        setLocalValues({});
        setErrors({});
      },

      validate: () => {
        const next: Record<string, string> = {};
        for (const def of visibleDefinitions) {
          if (!def.is_required) continue;
          const v = getFieldValue(def.id);
          const isOption = OPTION_FIELD_TYPES_SET.has(def.field_type);
          if (isOption) {
            if (!v.option_ids || v.option_ids.length === 0) {
              next[def.id] =
                `${def.name} is required — select at least one option.`;
            }
          } else {
            const raw = v.value;
            if (raw == null || String(raw).trim() === "") {
              next[def.id] = `${def.name} is required.`;
            }
          }
        }
        setErrors(next);
        return Object.keys(next).length === 0;
      },
    }),
    [
      definitions,
      localValues,
      pendingCreates,
      pendingUpdates,
      pendingDeletes,
      entityType,
      baseOptionsMap,
      queryClient,
      visibleDefinitions,
      valueMap,
    ],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const dialogEl = (
    <CustomFieldBuilderDialog
      open={dialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) setEditingField(null);
      }}
      onSave={handleSaveDefinition}
      onUpdate={handleUpdateDefinition}
      editingField={editingField}
      editingOptions={editingOptions}
      entityType={entityType}
      section={section}
    />
  );

  if (visibleDefinitions.length === 0) {
    if (readOnly) return null;
    return (
      <div className="flex justify-end">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="text-foreground px-0 h-auto"
          onClick={handleAdd}
        >
          <Plus />
          Add Custom Field
        </Button>
        {dialogEl}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleDefinitions.map((fieldDef) => {
          const val = getFieldValue(fieldDef.id);
          const isPending =
            isTempId(fieldDef.id) || pendingUpdates.has(fieldDef.id);
          const err = errors[fieldDef.id];
          return (
            <div
              key={fieldDef.id}
              data-invalid={!!err || undefined}
              className={`relative group ${isPending ? "ring-1 ring-primary/20 rounded-lg p-1" : ""}`}
            >
              {!readOnly && (
                <div className="absolute -top-3 right-0 hidden group-hover:flex items-center gap-1 z-10 bg-background border shadow-sm rounded-md p-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    onClick={() => handleEdit(fieldDef)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive"
                    onClick={() => handleDelete(fieldDef.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <CustomFieldRenderer
                fieldDef={fieldDef}
                options={visibleOptionsMap[fieldDef.id] ?? []}
                value={val.value}
                optionIds={val.option_ids}
                error={err}
                onValueChange={(v) => handleValueChange(fieldDef.id, v)}
                onOptionIdsChange={(ids) =>
                  handleOptionIdsChange(fieldDef.id, ids)
                }
                onFileChange={(file) => handleFileChange(fieldDef.id, file)}
              />
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-foreground px-0 h-auto"
            onClick={handleAdd}
          >
            <Plus />
            Add Custom Field
          </Button>
        </div>
      )}

      {!readOnly && dialogEl}
    </div>
  );
});
