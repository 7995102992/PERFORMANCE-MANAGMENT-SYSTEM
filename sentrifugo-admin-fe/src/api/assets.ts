import { apiClient } from '@/lib/axios'

export interface AssetResponseDTO {
  id: string
  file_name: string
  file_size: number
  mime_type: string
  file_url: string
  folder: string
  is_active: boolean
}

export const assetService = {
  /** POST /assets/upload — multipart file upload */
  async upload(file: File, folder: string): Promise<AssetResponseDTO> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('folder', folder)
    const { data } = await apiClient.post<AssetResponseDTO>('/assets/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    })
    return data
  },

  /** GET /assets/{id} */
  async getById(id: string): Promise<AssetResponseDTO> {
    const { data } = await apiClient.get<AssetResponseDTO>(`/assets/${id}`)
    return data
  },

  /** DELETE /assets/{id} — removes file from storage + DB */
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/assets/${id}`)
  },
}
