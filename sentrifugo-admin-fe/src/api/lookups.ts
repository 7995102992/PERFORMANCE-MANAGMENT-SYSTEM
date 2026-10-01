import { apiClient } from '@/lib/axios'
import type { ModuleCatalogItem } from '@/api/super-admin/types'

export interface ModuleLookupDTO {
  id: string
  code: string
  label: string
  description: string
  mandatory: boolean
}

export interface AclLookupDTO {
  id: string
  role: string
  label: string
  rank: number
}

export interface PermissionLookupDTO {
  id: string
  code: string
  label: string
}

export const lookupsService = {
  /** GET /lookups/modules */
  async modules() {
    const { data } = await apiClient.get<ModuleLookupDTO[]>('/lookups/modules')
    return data
  },

  /** GET /lookups/acl */
  async acl() {
    const { data } = await apiClient.get<AclLookupDTO[]>('/lookups/acl')
    return data
  },

  /** GET /lookups/permissions */
  async permissions(module?: string) {
    const { data } = await apiClient.get<PermissionLookupDTO[]>('/lookups/permissions', {
      params: module ? { module } : undefined,
    })
    return data
  },
  /** GET /lookups/modules — full module catalog with labels, descriptions, mandatory flags */
  async getModules(): Promise<ModuleCatalogItem[]> {
    const { data } = await apiClient.get<ModuleCatalogItem[]>('/lookups/modules')
    return data
  },

  /** GET /lookups/modules?all=true — full unfiltered catalog for module management */
  async getModulesAll(): Promise<ModuleCatalogItem[]> {
    const { data } = await apiClient.get<ModuleCatalogItem[]>('/lookups/modules', {
      params: { all: true },
    })
    return data
  },
}
