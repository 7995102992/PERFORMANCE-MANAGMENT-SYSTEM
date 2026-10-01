import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

// ─── Types (IAM BE /org-documents/my/* DTOs) ─────────────────────────────────

export interface DocFolderAccess {
  business_units: string[]
  departments: string[]
  worker_types: string[]
}

export interface MyDocFolder {
  id: string
  organisation_id: string
  /** null for a main folder; the main folder's id for a sub-folder. */
  parent_id?: string | null
  name: string
  description?: string | null
  custom_access: boolean
  access: DocFolderAccess
  is_active: boolean
  /** Active sub-folders inside this one. Always 0 for a sub-folder. */
  subfolder_count?: number | null
}

export interface MyOrgDocument {
  id: string
  organisation_id: string
  folder_id: string
  title: string
  description?: string | null
  allow_download: boolean
  require_acknowledgement: boolean
  asset_id: string
  /** Which revision of the file is currently published. Starts at 1. */
  current_version_no: number
  is_active: boolean
  file_name?: string | null
  file_size?: number | null
  mime_type?: string | null
  file_url?: string | null
  /** When the current revision was published, and the admin's note about it. */
  version_updated_at?: string | null
  version_change_note?: string | null
  // Caller's acknowledgement state, for the CURRENT version only. When a new
  // version is published this flips back to false, with
  // acknowledged_version_no still holding the revision they last signed —
  // so the UI can say "re-acknowledgement required", not "never acknowledged".
  acknowledged: boolean
  acknowledged_at?: string | null
  acknowledged_version_no?: number | null
}

export interface AcknowledgeResponse {
  document_id: string
  version_no: number
  acknowledged: boolean
  acknowledged_at: string
}

// ─── API ─────────────────────────────────────────────────────────────────────
// Folder visibility is scoped server-side: org-level folders (custom access
// off) are visible to everyone; custom-access folders only when the caller's
// BU + department + worker type all match.

export const orgDocumentsApi = createApi({
  reducerPath: 'orgDocumentsApi',
  baseQuery: createBaseQuery(IAM_BASE_URL),
  tagTypes: ['DocFolders', 'MyDocuments'],
  endpoints: (builder) => ({
    /**
     * One level at a time: no arg → main folders; a folder id → that folder's
     * sub-folders. Access is checked against the main folder either way.
     */
    getMyDocFolders: builder.query<MyDocFolder[], string | void>({
      query: (parentId) => ({
        url: '/org-documents/my/folders',
        params: { limit: 100, ...(parentId ? { parent_id: parentId } : {}) },
      }),
      providesTags: (_res, _err, parentId) => [
        { type: 'DocFolders' as const, id: parentId || 'root' },
      ],
    }),

    getMyDocuments: builder.query<MyOrgDocument[], string>({
      query: (folderId) => ({
        url: '/org-documents/my/documents',
        params: { folder_id: folderId, limit: 100 },
      }),
      providesTags: (_res, _err, folderId) => [
        { type: 'MyDocuments', id: folderId },
      ],
    }),

    acknowledgeDocument: builder.mutation<
      AcknowledgeResponse,
      { docId: string; folderId: string }
    >({
      query: ({ docId }) => ({
        url: `/org-documents/my/documents/${docId}/acknowledge`,
        method: 'POST',
        // The browser's clock at the moment of the click — this is the
        // timestamp that gets stored.
        body: { acknowledged_at: new Date().toISOString() },
      }),
      invalidatesTags: (_res, _err, { folderId }) => [
        { type: 'MyDocuments', id: folderId },
      ],
    }),
  }),
})

export const {
  useGetMyDocFoldersQuery,
  useGetMyDocumentsQuery,
  useAcknowledgeDocumentMutation,
} = orgDocumentsApi
