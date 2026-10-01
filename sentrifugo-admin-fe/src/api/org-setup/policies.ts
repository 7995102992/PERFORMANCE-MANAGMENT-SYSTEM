import { apiClient } from '@/lib/axios'
import type {
  PolicyCreateDTO,
  PolicyDetailResponseDTO,
  PolicyListParams,
  PolicyPaginatedResponse,
  PolicyPermissionsResponseDTO,
  PolicyPermissionsUpdateDTO,
  PolicyUpdateDTO,
} from './types'

// Matches IAM Admin BE: /policies endpoints

export const policiesService = {
  /** GET /policies?skip=0&limit=20&is_active=true */
  async list(params?: PolicyListParams) {
    const { data } = await apiClient.get<PolicyPaginatedResponse>('/policies', {
      params,
    })
    return data
  },

  /** GET /policies/roles — policies flagged as roles (is_role=true) */
  async listRoles(params?: PolicyListParams) {
    const { data } = await apiClient.get<PolicyPaginatedResponse>('/policies/roles', {
      params,
    })
    return data
  },

  /** GET /policies/{id} */
  async getById(id: string) {
    const { data } = await apiClient.get<PolicyDetailResponseDTO>(`/policies/${id}`)
    return data
  },

  /** GET /policies/{id}/permissions */
  async getPermissions(id: string) {
    const { data } = await apiClient.get<PolicyPermissionsResponseDTO>(`/policies/${id}/permissions`)
    return data
  },

  /** POST /policies */
  async create(payload: PolicyCreateDTO) {
    const { data } = await apiClient.post<PolicyDetailResponseDTO>('/policies', payload)
    return data
  },

  /** PUT /policies/{id} — update name/status only */
  async update(id: string, payload: PolicyUpdateDTO) {
    const { data } = await apiClient.put<PolicyDetailResponseDTO>(`/policies/${id}`, payload)
    return data
  },

  /** PUT /policies/{id}/permissions — update permissions matrix */
  async updatePermissions(id: string, payload: PolicyPermissionsUpdateDTO) {
    const { data } = await apiClient.put<PolicyPermissionsResponseDTO>(`/policies/${id}/permissions`, payload)
    return data
  },

  /** POST /users/{userId}/policies/{policyId} — assign policy to user */
  async assignToUser(userId: string, policyId: string) {
    const { data } = await apiClient.post(`/users/${userId}/policies/${policyId}`)
    return data
  },

  /** DELETE /users/{userId}/policies/{policyId} — detach policy from user */
  async detachFromUser(userId: string, policyId: string) {
    await apiClient.delete(`/users/${userId}/policies/${policyId}`)
  },

  /** DELETE /policies/{id} */
  async remove(id: string) {
    await apiClient.delete(`/policies/${id}`)
  },
}
