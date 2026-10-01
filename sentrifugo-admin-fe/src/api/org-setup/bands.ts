import { apiClient } from '@/lib/axios'
import type {
  BandCreateDTO,
  BandUpdateDTO,
  BandResponseDTO,
} from './types'

export const bandsService = {
  /** GET /bands/ */
  async list() {
    const { data } = await apiClient.get<BandResponseDTO[]>('/bands/')
    return data
  },

  /** GET /bands/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<BandResponseDTO>(`/bands/${id}`)
    return data
  },

  /** POST /bands/ */
  async create(payload: BandCreateDTO) {
    const { data } = await apiClient.post<BandResponseDTO>('/bands/', payload)
    return data
  },

  /** PUT /bands/{id} */
  async update(id: string, payload: BandUpdateDTO) {
    const { data } = await apiClient.put<BandResponseDTO>(`/bands/${id}`, payload)
    return data
  },

  /** DELETE /bands/{id} */
  async remove(id: string) {
    await apiClient.delete(`/bands/${id}`)
  },
}
