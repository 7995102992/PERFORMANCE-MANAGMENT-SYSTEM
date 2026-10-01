import { apiClient } from '@/lib/axios'
import type {
  SuperAdminOrgCreateDTO,
  SuperAdminOrgUpdateDTO,
  SuperAdminOrgResponseDTO,
  SuperAdminOrgListItemDTO,
  SuperAdminDashboardStats,
} from './types'

const BASE = '/super-admin/organisations'

export const superAdminOrgService = {
  /** GET /super-admin/organisations */
  async list(params?: {
    skip?: number
    limit?: number
    search?: string
    setup_status?: string
    is_active?: boolean
  }): Promise<SuperAdminOrgListItemDTO[]> {
    const { data } = await apiClient.get<SuperAdminOrgListItemDTO[]>(BASE, { params })
    return data
  },

  /** GET /super-admin/organisations/{id} */
  async getById(id: string): Promise<SuperAdminOrgResponseDTO> {
    const { data } = await apiClient.get<SuperAdminOrgResponseDTO>(`${BASE}/${id}`)
    return data
  },

  /** POST /super-admin/organisations */
  async create(payload: SuperAdminOrgCreateDTO): Promise<SuperAdminOrgResponseDTO> {
    const { data } = await apiClient.post<SuperAdminOrgResponseDTO>(BASE, payload)
    return data
  },

  /** PUT /super-admin/organisations/{id} */
  async update(id: string, payload: SuperAdminOrgUpdateDTO): Promise<SuperAdminOrgResponseDTO> {
    const { data } = await apiClient.put<SuperAdminOrgResponseDTO>(`${BASE}/${id}`, payload)
    return data
  },

  /** DELETE /super-admin/organisations/{id} */
  async remove(id: string): Promise<void> {
    await apiClient.delete(`${BASE}/${id}`)
  },

  /** GET /dashboard/stats */
  async getDashboardStats(): Promise<SuperAdminDashboardStats> {
    const { data } = await apiClient.get<SuperAdminDashboardStats>('/dashboard/stats')
    return data
  },
}
