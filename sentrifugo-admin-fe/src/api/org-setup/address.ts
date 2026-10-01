import { apiClient } from '@/lib/axios'
import type { AddressCreateDTO, AddressUpdateDTO, AddressResponseDTO } from './types'

// Matches IAM Admin BE: /addresses endpoints

export const addressService = {
  /** GET /addresses/ */
  async list() {
    const { data } = await apiClient.get<AddressResponseDTO[]>('/addresses/')
    return data
  },

  /** GET /addresses/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<AddressResponseDTO>(`/addresses/${id}`)
    return data
  },

  /** POST /addresses/ */
  async create(payload: AddressCreateDTO) {
    const { data } = await apiClient.post<AddressResponseDTO>('/addresses/', payload)
    return data
  },

  /** PUT /addresses/{id} */
  async update(id: string, payload: AddressUpdateDTO) {
    const { data } = await apiClient.put<AddressResponseDTO>(`/addresses/${id}`, payload)
    return data
  },

  /** DELETE /addresses/{id} */
  async remove(id: string) {
    await apiClient.delete(`/addresses/${id}`)
  },
}
