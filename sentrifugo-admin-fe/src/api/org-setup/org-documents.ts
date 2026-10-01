import { apiClient } from '@/lib/axios'
import type {
  FolderCreateDTO,
  FolderUpdateDTO,
  FolderResponseDTO,
  BulkFolderCreateDTO,
  OrgDocumentCreateDTO,
  OrgDocumentUpdateDTO,
  OrgDocumentResponseDTO,
  BulkDocumentCreateDTO,
} from './types'

// ─── Folders ─────────────────────────────────────────────────────────────────

export const foldersService = {
  async list(params?: { skip?: number; limit?: number; search?: string }) {
    const { data } = await apiClient.get<FolderResponseDTO[]>('/org-documents/folders/', { params })
    return data
  },

  async getById(id: string) {
    const { data } = await apiClient.get<FolderResponseDTO>(`/org-documents/folders/${id}`)
    return data
  },

  async create(payload: FolderCreateDTO) {
    const { data } = await apiClient.post<FolderResponseDTO>('/org-documents/folders/', payload)
    return data
  },

  async createBulk(payload: BulkFolderCreateDTO) {
    const { data } = await apiClient.post<FolderResponseDTO[]>('/org-documents/folders/bulk', payload)
    return data
  },

  async update(id: string, payload: FolderUpdateDTO) {
    const { data } = await apiClient.put<FolderResponseDTO>(`/org-documents/folders/${id}`, payload)
    return data
  },

  async remove(id: string) {
    await apiClient.delete(`/org-documents/folders/${id}`)
  },

  async deactivateAllDocuments(folderId: string) {
    const { data } = await apiClient.patch<{ deactivated: number }>(`/org-documents/folders/${folderId}/deactivate-all-documents`)
    return data
  },
}

// ─── Documents ───────────────────────────────────────────────────────────────

export const orgDocumentsService = {
  async list(folderId?: string, params?: { skip?: number; limit?: number; search?: string }) {
    const { data } = await apiClient.get<OrgDocumentResponseDTO[]>('/org-documents/documents/', {
      params: { ...(folderId ? { folder_id: folderId } : {}), ...params },
    })
    return data
  },

  async getById(id: string) {
    const { data } = await apiClient.get<OrgDocumentResponseDTO>(`/org-documents/documents/${id}`)
    return data
  },

  async create(payload: OrgDocumentCreateDTO) {
    const { data } = await apiClient.post<OrgDocumentResponseDTO>('/org-documents/documents/', payload)
    return data
  },

  async createBulk(payload: BulkDocumentCreateDTO) {
    const { data } = await apiClient.post<OrgDocumentResponseDTO[]>('/org-documents/documents/bulk', payload)
    return data
  },

  async update(id: string, payload: OrgDocumentUpdateDTO) {
    const { data } = await apiClient.put<OrgDocumentResponseDTO>(`/org-documents/documents/${id}`, payload)
    return data
  },

  async remove(id: string) {
    await apiClient.delete(`/org-documents/documents/${id}`)
  },
}
