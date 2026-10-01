import { apiClient } from '@/lib/axios'

export interface UserDTO {
  id: string
  email: string
  first_name: string
  last_name: string
  middle_name?: string | null
  phone?: string | null
  status: 'active' | 'inactive'
  is_org_admin: boolean
  organisation_id?: string | null
  /** True when the account has never been activated → eligible for resend. */
  activation_pending?: boolean
  created_on?: string | null
  modified_on?: string | null
}

export interface UserCreateDTO {
  email: string
  first_name: string
  last_name: string
  phone?: string | null
  is_org_admin?: boolean
  organisation_id?: string | null
  auth_method?: 'local' | 'azure_sso'
  send_activation?: boolean
}

export interface UserUpdateDTO {
  first_name?: string
  last_name?: string
  phone?: string | null
  status?: 'active' | 'inactive'
  is_org_admin?: boolean
}

export interface UserListParams {
  skip?: number
  limit?: number
  is_org_admin?: boolean
  organisation_id?: string
}

export const usersService = {
  async list(params?: UserListParams): Promise<UserDTO[]> {
    const { data } = await apiClient.get<UserDTO[]>('/users', { params })
    return data
  },

  async getById(id: string): Promise<UserDTO> {
    const { data } = await apiClient.get<UserDTO>(`/users/${id}`)
    return data
  },

  async create(payload: UserCreateDTO): Promise<UserDTO> {
    const { data } = await apiClient.post<UserDTO>('/users', payload)
    return data
  },

  async update(id: string, payload: UserUpdateDTO): Promise<UserDTO> {
    const { data } = await apiClient.put<UserDTO>(`/users/${id}`, payload)
    return data
  },

  /** POST /users/{id}/resend-activation — resend activation email (admin action). */
  async resendActivation(id: string): Promise<{ message: string }> {
    const { data } = await apiClient.post<{ message: string }>(`/users/${id}/resend-activation`)
    return data
  },
}
