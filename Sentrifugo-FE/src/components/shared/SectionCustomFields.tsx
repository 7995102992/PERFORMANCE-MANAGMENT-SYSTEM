import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Button } from "@/components/ui/button";
import { CustomFieldRenderer } from "@/components/shared/CustomFieldRenderer";
import { CustomFieldBuilderDialog } from "@/components/shared/CustomFieldBuilderDialog";
import {
  useGetDefinitionsQuery,
  useGetEntityValuesQuery,
  useLazyGetOptionsQuery,
  useCreateDefinitionMutation,
  useCreateOptionMutation,
  useUpdateDefinitionMutation,
  useDeleteDefinitionMutation,
  useDeleteOptionMutation,
  useUpsertEntityValuesMutation,
} from "@/store/api/customFieldsApi";
import { useUploadAssetMutation } from "@/store/api/exitManagementApi";
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

const OPTION_FIELD_TYPES_SET = new Set(OPTION_FIELD_TYPES);

interface PendingCreate {
  tempId: string;
  payload: DefinitionCreateDTO;
  options: OptionCreateDTO[];
}

interface PendingUpdate {
  payload: DefinitionUpdateDTO;
  newOptions: OptionCreateDTO[];
}

export interface SectionCustomFieldsRef {
  saveValues: (targetEntityId: string) => Promise<void>;
  discardChanges: () => void;
  validate: () => boolean;
}

interface SectionCustomFieldsProps {
  entityType: EntityType;
  section: SectionType;
  entityId?: string;
  readOnly?: boolean;
  immediateDefinitionSave?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onHasDefinitionsChange?: (has: boolean) => void;
}

let tempCounter = 0;
function nextTempId() {
  return `__temp_cf_${++tempCounter}`;
}

function isTempId(id: string) {
  return id.startsWith("__temp_cf_");
}

export const SectionCustomFields = React.forwardRef<
  SectionCustomFieldsRef,
  SectionCustomFieldsProps
>(function SectionCustomFields(
  { entityType, section, entityId, readOnly = false, immediateDefinitionSave = false, onDirtyChange, onHasDefinitionsChange },
  ref,
) {
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingField, setEditingField] = React.useState<CustomFieldDefinition | null>(null);
  const [editingOptions, setEditingOptions] = React.useState<OptionCreateDTO[]>([]);
  const [localValues, setLocalValues] = React.useState<
    Record<string, { value: string | null; option_ids: string[] }>
  >({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function clearError(defId: string) {
    setErrors((prev) => {
      if (!prev[defId]) return prev;
      const next = { ...prev };
      delete next[defId];
      return next;
    });
  }

  const [pendingCreates, setPendingCreates] = React.useState<PendingCreate[]>([]);
  const [pendingUpdates, setPendingUpdates] = React.useState(() => new Map<string, PendingUpdate>());
  const [pendingDeletes, setPendingDeletes] = React.useState(() => new Set<string>());

  const { data: definitions = [] } = useGetDefinitionsQuery({
    entity_type: entityType,
    section,
    is_active: true,
  });
  const { data: valuesResponse } = useGetEntityValuesQuery(
    { entityType, entityId: entityId! },
    { skip: !entityId },
  );

  const [createDefinition] = useCreateDefinitionMutation();
  const [createOption] = useCreateOptionMutation();
  const [updateDefinition] = useUpdateDefinitionMutation();
  const [deleteDefinition] = useDeleteDefinitionMutation();
  const [deleteOption] = useDeleteOptionMutation();
  const [upsertValues] = useUpsertEntityValuesMutation();
  const [uploadAsset] = useUploadAssetMutation();

  React.useEffect(() => {
    const hasLocalValues = Object.keys(localValues).length > 0;
    const hasPendingDefs =
      pendingCreates.length > 0 || pendingUpdates.size > 0 || pendingDeletes.size > 0;
    onDirtyChange?.(hasLocalValues || hasPendingDefs);
  }, [localValues, pendingCreates, pendingUpdates, pendingDeletes, onDirtyChange]);

  const [fetchOptions] = useLazyGetOptionsQuery();
  const [standaloneOptionsMap, setStandaloneOptionsMap] = React.useState<Record<string, CustomFieldOption[]>>({});

  const [optionsFetchKey, setOptionsFetchKey] = React.useState(0);

  React.useEffect(() => {
    const optionDefs = definitions.filter((d) => OPTION_FIELD_TYPES_SET.has(d.field_type));
    if (optionDefs.length === 0) return;
    let cancelled = false;
    (async () => {
      const map: Record<string, CustomFieldOption[]> = {};
      for (const d of optionDefs) {
        try {
          const result = await fetchOptions(d.id, false).unwrap();
          if (cancelled) return;
          map[d.id] = result;
        } catch { /* ignore */ }
      }
      if (!cancelled) setStandaloneOptionsMap(map);
    })();
    return () => { cancelled = true; };
  }, [definitions, fetchOptions, optionsFetchKey]);

  const valueMap = React.useMemo(() => {
    const map: Record<string, { value: string | null; option_ids: string[] }> = {};
    if (valuesResponse?.fields) {
      for (const f of valuesResponse.fields) {
        if (f.value) {
          map[f.definition.id] = { value: f.value.value ?? null, option_ids: f.value.option_ids };
        }
      }
    }
    return map;
  }, [valuesResponse]);

  const baseOptionsMap = React.useMemo(() => {
    const map: Record<string, CustomFieldOption[]> = {};
    if (entityId && valuesResponse?.fields) {
      for (const f of valuesResponse.fields) {
        map[f.definition.id] = f.options;
      }
    }
    Object.assign(map, standaloneOptionsMap);
    return map;
  }, [entityId, valuesResponse, standaloneOptionsMap]);

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
  }, [definitions, pendingCreates, pendingUpdates, pendingDeletes, entityType, section]);

  React.useEffect(() => {
    onHasDefinitionsChange?.(visibleDefinitions.length > 0);
  }, [visibleDefinitions.length, onHasDefinitionsChange]);

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

  function getFieldValue(defId: string) {
    return localValues[defId] ?? valueMap[defId] ?? { value: null, option_ids: [] };
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
    try {
      const asset = await uploadAsset({ file, folder: "custom-fields" }).unwrap();
      handleValueChange(defId, asset.id);
    } catch {
      // upload error handled by RTK Query
    }
  }

  async function handleSaveDefinition(payload: DefinitionCreateDTO, options: OptionCreateDTO[]) {
    if (immediateDefinitionSave) {
      try {
        const created = await createDefinition(payload).unwrap();
        for (const opt of options) {
          await createOption({ definitionId: created.id, body: opt }).unwrap();
        }
        setOptionsFetchKey((k) => k + 1);
      } catch { /* handled by RTK Query */ }
      return;
    }
    const tempId = nextTempId();
    setPendingCreates((prev) => [...prev, { tempId, payload, options }]);
  }

  async function handleUpdateDefinition(id: string, payload: DefinitionUpdateDTO, newOptions: OptionCreateDTO[]) {
    if (immediateDefinitionSave && !isTempId(id)) {
      try {
        await updateDefinition({ id, body: payload }).unwrap();
        const existing = baseOptionsMap[id] ?? [];
        const existingByValue = new Map(existing.map((o) => [o.value, o]));
        const newValueSet = new Set(newOptions.map((o) => o.value));
        for (const opt of existing) {
          if (!newValueSet.has(opt.value)) {
            try { await deleteOption(opt.id).unwrap(); } catch { /* ignore */ }
          }
        }
        for (const opt of newOptions) {
          if (!existingByValue.has(opt.value)) {
            await createOption({ definitionId: id, body: opt }).unwrap();
          }
        }
        setOptionsFetchKey((k) => k + 1);
      } catch { /* handled by RTK Query */ }
      return;
    }
    if (isTempId(id)) {
      setPendingCreates((prev) =>
        prev.map((pc) =>
          pc.tempId === id
            ? {
                ...pc,
                payload: {
                  ...pc.payload,
                  name: payload.name ?? pc.payload.name,
                  field_type: (payload.field_type ?? pc.payload.field_type) as DefinitionCreateDTO["field_type"],
                  file_settings: payload.file_settings !== undefined ? payload.file_settings : pc.payload.file_settings,
                  placeholder: payload.placeholder !== undefined ? payload.placeholder : pc.payload.placeholder,
                  help_text: payload.help_text !== undefined ? payload.help_text : pc.payload.help_text,
                  is_required: payload.is_required !== undefined ? payload.is_required : pc.payload.is_required,
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
    const pendingCreate = pendingCreates.find((pc) => pc.tempId === fieldDef.id);
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

    const fieldName = definitions.find((d) => d.id === defId)?.name ?? "this field";
    confirm({
      title: "Remove Custom Field",
      description: `"${fieldName}" will be permanently removed. Continue?`,
      confirmText: "Remove",
      onConfirm: async () => {
        if (immediateDefinitionSave) {
          try { await deleteDefinition(defId).unwrap(); } catch { /* ignore */ }
        } else {
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
        }
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

  React.useImperativeHandle(
    ref,
    () => ({
      saveValues: async (targetEntityId: string) => {
        for (const defId of pendingDeletes) {
          try { await deleteDefinition(defId).unwrap(); } catch { /* 404 = already removed */ }
        }

        for (const [defId, update] of pendingUpdates) {
          try {
            await updateDefinition({ id: defId, body: update.payload }).unwrap();
          } catch { continue; }

          const existing = baseOptionsMap[defId] ?? [];
          const existingByValue = new Map(existing.map((o) => [o.value, o]));
          const newValueSet = new Set(update.newOptions.map((o) => o.value));

          for (const opt of existing) {
            if (!newValueSet.has(opt.value)) {
              try { await deleteOption(opt.id).unwrap(); } catch { /* ignore */ }
            }
          }
          for (const opt of update.newOptions) {
            if (!existingByValue.has(opt.value)) {
              await createOption({ definitionId: defId, body: opt }).unwrap();
            }
          }
        }

        const tempToRealDefId = new Map<string, string>();
        const tempDefToOptMapping = new Map<string, Map<string, string>>();

        for (const pc of pendingCreates) {
          const created = await createDefinition(pc.payload).unwrap();
          tempToRealDefId.set(pc.tempId, created.id);

          const optMap = new Map<string, string>();
          for (const opt of pc.options) {
            const createdOpt = await createOption({ definitionId: created.id, body: opt }).unwrap();
            optMap.set(opt.value, createdOpt.id);
          }
          tempDefToOptMapping.set(pc.tempId, optMap);
        }

        const items: ValueUpsertDTO[] = [];

        for (const def of definitions) {
          if (pendingDeletes.has(def.id)) continue;
          const val = localValues[def.id];
          if (val) {
            items.push({ field_definition_id: def.id, value: val.value, option_ids: val.option_ids });
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
            items.push({ field_definition_id: realDefId, value: val.value, option_ids: mappedOptionIds });
          }
        }

        if (items.length > 0) {
          await upsertValues({ entityType, entityId: targetEntityId, body: items }).unwrap();
        }

        setPendingCreates([]);
        setPendingUpdates(new Map());
        setPendingDeletes(new Set());
        setLocalValues({});
        setErrors({});
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
              next[def.id] = `${def.name} is required — select at least one option.`;
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
      definitions, localValues, pendingCreates, pendingUpdates, pendingDeletes,
      entityType, baseOptionsMap, visibleDefinitions, valueMap,
      createDefinition, createOption, updateDefinition, deleteDefinition,
      deleteOption, upsertValues,
    ],
  );

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
          const isPending = isTempId(fieldDef.id) || pendingUpdates.has(fieldDef.id);
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
                    size="icon"
                    className="size-6 text-muted-foreground"
                    onClick={() => handleEdit(fieldDef)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-destructive"
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
                onOptionIdsChange={(ids) => handleOptionIdsChange(fieldDef.id, ids)}
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
