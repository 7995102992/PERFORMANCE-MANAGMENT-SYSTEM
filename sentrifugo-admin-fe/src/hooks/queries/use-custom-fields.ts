import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { definitionService, optionService, valueService } from '@/api/custom-fields'
import { queryKeys } from '@/api/query-keys'
import { toast } from '@/lib/toast'
import type {
  DefinitionCreateDTO,
  DefinitionUpdateDTO,
  EntityType,
  OptionCreateDTO,
  OptionUpdateDTO,
  ReorderItemDTO,
  SectionType,
  ValueUpsertDTO,
} from '@/types/custom-fields'

// ─── Definitions ─────────────────────────────────────────────────────────────

export function useCustomFieldDefinitions(entityType?: EntityType, section?: SectionType) {
  return useQuery({
    queryKey: queryKeys.customFields.definitions(entityType, section),
    queryFn: () => definitionService.list({ entity_type: entityType, section, is_active: true }),
    enabled: !!entityType,
    staleTime: 2 * 60 * 1000,
  })
}

export function useCreateDefinition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: DefinitionCreateDTO) => definitionService.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.all })
      toast.success('Custom field created')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateDefinition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: DefinitionUpdateDTO }) =>
      definitionService.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.all })
      toast.success('Custom field updated')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteDefinition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => definitionService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.all })
      toast.success('Custom field deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useReorderDefinitions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: ReorderItemDTO[]) => definitionService.reorder(items),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.all })
      toast.success('Fields reordered')
    },
    onError: (err) => { toast.error(err) },
  })
}

// ─── Options ─────────────────────────────────────────────────────────────────

export function useCustomFieldOptions(definitionId?: string) {
  return useQuery({
    queryKey: queryKeys.customFields.options(definitionId ?? ''),
    queryFn: () => optionService.list(definitionId!),
    enabled: !!definitionId,
    staleTime: 2 * 60 * 1000,
  })
}

export function useCreateOption() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ definitionId, payload }: { definitionId: string; payload: OptionCreateDTO }) =>
      optionService.create(definitionId, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.options(vars.definitionId) })
      toast.success('Option added')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateOption() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ optionId, payload }: { optionId: string; payload: OptionUpdateDTO }) =>
      optionService.update(optionId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.all })
      toast.success('Option updated')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteOption() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (optionId: string) => optionService.remove(optionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.all })
      toast.success('Option deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useReorderOptions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ definitionId, items }: { definitionId: string; items: ReorderItemDTO[] }) =>
      optionService.reorder(definitionId, items),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.options(vars.definitionId) })
      toast.success('Options reordered')
    },
    onError: (err) => { toast.error(err) },
  })
}

// ─── Values ──────────────────────────────────────────────────────────────────

export function useCustomFieldValues(entityType?: EntityType, entityId?: string) {
  return useQuery({
    queryKey: queryKeys.customFields.values(entityType ?? '', entityId ?? ''),
    queryFn: () => valueService.getEntityValues(entityType!, entityId!),
    enabled: !!entityType && !!entityId,
    staleTime: 60 * 1000,
  })
}

export function useUpsertValues() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ entityType, entityId, items }: { entityType: EntityType; entityId: string; items: ValueUpsertDTO[] }) =>
      valueService.upsertEntityValues(entityType, entityId, items),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.customFields.values(vars.entityType, vars.entityId) })
      toast.success('Custom field values saved')
    },
    onError: (err) => { toast.error(err) },
  })
}
