import { apiClient } from '@/lib/axios'
import type {
  CustomFieldDefinition,
  CustomFieldOption,
  CustomFieldValue,
  DefinitionCreateDTO,
  DefinitionUpdateDTO,
  EntityType,
  EntityValuesResponse,
  OptionCreateDTO,
  OptionUpdateDTO,
  ReorderItemDTO,
  SectionType,
  ValueUpsertDTO,
} from '@/types/custom-fields'

// ─── Definitions ─────────────────────────────────────────────────────────────

export const definitionService = {
  async list(params?: { entity_type?: EntityType; section?: SectionType; is_active?: boolean }) {
    const { data } = await apiClient.get<CustomFieldDefinition[]>('/custom-fields/definitions', { params })
    return data
  },

  async getById(id: string) {
    const { data } = await apiClient.get<CustomFieldDefinition>(`/custom-fields/definitions/${id}`)
    return data
  },

  async create(payload: DefinitionCreateDTO) {
    const { data } = await apiClient.post<CustomFieldDefinition>('/custom-fields/definitions', payload)
    return data
  },

  async update(id: string, payload: DefinitionUpdateDTO) {
    const { data } = await apiClient.put<CustomFieldDefinition>(`/custom-fields/definitions/${id}`, payload)
    return data
  },

  async remove(id: string) {
    await apiClient.delete(`/custom-fields/definitions/${id}`)
  },

  async reorder(items: ReorderItemDTO[]) {
    await apiClient.patch('/custom-fields/definitions/reorder', { items })
  },
}

// ─── Options ─────────────────────────────────────────────────────────────────

export const optionService = {
  async list(definitionId: string) {
    const { data } = await apiClient.get<CustomFieldOption[]>(`/custom-fields/definitions/${definitionId}/options`)
    return data
  },

  async create(definitionId: string, payload: OptionCreateDTO) {
    const { data } = await apiClient.post<CustomFieldOption>(`/custom-fields/definitions/${definitionId}/options`, payload)
    return data
  },

  async update(optionId: string, payload: OptionUpdateDTO) {
    const { data } = await apiClient.put<CustomFieldOption>(`/custom-fields/options/${optionId}`, payload)
    return data
  },

  async remove(optionId: string) {
    await apiClient.delete(`/custom-fields/options/${optionId}`)
  },

  async reorder(definitionId: string, items: ReorderItemDTO[]) {
    await apiClient.patch(`/custom-fields/definitions/${definitionId}/options/reorder`, { items })
  },
}

// ─── Values ──────────────────────────────────────────────────────────────────

export const valueService = {
  async getEntityValues(entityType: EntityType, entityId: string) {
    const { data } = await apiClient.get<EntityValuesResponse>(`/custom-fields/values/${entityType}/${entityId}`)
    return data
  },

  async upsertEntityValues(entityType: EntityType, entityId: string, items: ValueUpsertDTO[]) {
    const { data } = await apiClient.put<CustomFieldValue[]>(`/custom-fields/values/${entityType}/${entityId}`, items)
    return data
  },

  async deleteEntityValues(entityType: EntityType, entityId: string) {
    await apiClient.delete(`/custom-fields/values/${entityType}/${entityId}`)
  },
}
