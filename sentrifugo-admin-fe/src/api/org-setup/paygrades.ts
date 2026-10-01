import { apiClient } from '@/lib/axios'
import type {
  PayGradeCreateDTO,
  PayGradeUpdateDTO,
  PayGradeResponseDTO,
} from './types'

export const paygradesService = {
  /** GET /paygrades/ */
  async list() {
    const { data } = await apiClient.get<PayGradeResponseDTO[]>('/paygrades/')
    return data
  },

  /** GET /paygrades/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<PayGradeResponseDTO>(`/paygrades/${id}`)
    return data
  },

  /** POST /paygrades/ */
  async create(payload: PayGradeCreateDTO) {
    const { data } = await apiClient.post<PayGradeResponseDTO>('/paygrades/', payload)
    return data
  },

  /** PUT /paygrades/{id} */
  async update(id: string, payload: PayGradeUpdateDTO) {
    const { data } = await apiClient.put<PayGradeResponseDTO>(`/paygrades/${id}`, payload)
    return data
  },

  /** DELETE /paygrades/{id} */
  async remove(id: string) {
    await apiClient.delete(`/paygrades/${id}`)
  },
}
