import { apiClient } from '@/lib/axios'
import type {
  DepartmentCreateDTO,
  DepartmentUpdateDTO,
  DepartmentResponseDTO,
} from './types'

export const departmentsService = {
  /** GET /departments/?business_unit_ids=&skip=&limit=&search= */
  async list(params?: { skip?: number; limit?: number; search?: string; businessUnitIds?: string[]; is_active?: boolean }) {
    const { businessUnitIds, ...rest } = params ?? {}
    const { data } = await apiClient.get<DepartmentResponseDTO[]>('/departments/', {
      params: {
        ...(businessUnitIds?.length ? { business_unit_ids: businessUnitIds.join(',') } : {}),
        ...rest,
      },
    })
    return data
  },

  /** GET /departments/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<DepartmentResponseDTO>(`/departments/${id}`)
    return data
  },

  /** POST /departments/ */
  async create(payload: DepartmentCreateDTO) {
    const { data } = await apiClient.post<DepartmentResponseDTO>('/departments/', payload)
    return data
  },

  /** PUT /departments/{id} */
  async update(id: string, payload: DepartmentUpdateDTO) {
    const { data } = await apiClient.put<DepartmentResponseDTO>(`/departments/${id}`, payload)
    return data
  },

  /** DELETE /departments/{id} */
  async remove(id: string) {
    await apiClient.delete(`/departments/${id}`)
  },
}
