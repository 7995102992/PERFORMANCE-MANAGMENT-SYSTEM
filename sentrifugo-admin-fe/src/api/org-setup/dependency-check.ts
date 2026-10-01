import { apiClient } from '@/lib/axios'

export interface DependencyCheckResult {
  entity_type: string
  entity_id: string
  can_inactivate: boolean
  dependencies: { type: string; count: number }[]
}

export type EntityType = 'organisation' | 'business_unit' | 'department' | 'designation' | 'pay_grade' | 'band' | 'document_folder'

export const dependencyCheckService = {
  async check(entityType: EntityType, entityId: string) {
    const { data } = await apiClient.get<DependencyCheckResult>(
      `/dependency-check/${entityType}/${entityId}`
    )
    return data
  },
}
