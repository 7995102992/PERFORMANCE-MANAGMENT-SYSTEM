import { apiClient } from '@/lib/axios'
import type {
  DesignationCreateDTO,
  DesignationUpdateDTO,
  DesignationResponseDTO,
} from './types'

export const designationsService = {
  /** GET /designations/?department_id=&department_ids=&skip=&limit=&search= */
  async list(params?: { skip?: number; limit?: number; search?: string; is_active?: boolean }) {
    // Designations are org-level — no department / hierarchy filtering.
    const { data } = await apiClient.get<DesignationResponseDTO[]>('/designations/', {
      params: { ...params },
    })
    return data
  },

  /** GET /designations/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<DesignationResponseDTO>(`/designations/${id}`)
    return data
  },

  /** POST /designations/ */
  async create(payload: DesignationCreateDTO) {
    const { data } = await apiClient.post<DesignationResponseDTO>('/designations/', payload)
    return data
  },

  /** PUT /designations/{id} */
  async update(id: string, payload: DesignationUpdateDTO) {
    const { data } = await apiClient.put<DesignationResponseDTO>(`/designations/${id}`, payload)
    return data
  },

  /** DELETE /designations/{id} */
  async remove(id: string) {
    await apiClient.delete(`/designations/${id}`)
  },
}
