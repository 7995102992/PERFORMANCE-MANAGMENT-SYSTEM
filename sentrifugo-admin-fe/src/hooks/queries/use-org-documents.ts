import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { foldersService, orgDocumentsService } from '@/api/org-setup'
import { assetService } from '@/api/assets'
import { queryKeys, type ListParams } from '@/api/query-keys'
import type {
  FolderCreateDTO,
  FolderUpdateDTO,
  BulkFolderCreateDTO,
  OrgDocumentCreateDTO,
  OrgDocumentUpdateDTO,
  BulkDocumentCreateDTO,
} from '@/api/org-setup/types'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

// ─── Folders ─────────────────────────────────────────────────────────────────

export function useFolders(_organisationId?: string, params?: ListParams) {
  return useQuery({
    queryKey: queryKeys.folders.list(_organisationId, params),
    queryFn: () => foldersService.list(params),
    enabled: !!_organisationId,
    staleTime: 2 * 60 * 1000,
  })
}

export function useCreateFolder() {
  const qc = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: FolderCreateDTO) => foldersService.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.folders.all })
      toast.success('Folder created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useCreateFoldersBulk() {
  const qc = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: BulkFolderCreateDTO) => foldersService.createBulk(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.folders.all })
      toast.success('Folders created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: FolderUpdateDTO }) =>
      foldersService.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.folders.all })
      toast.success('Folder updated successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteFolder() {
  const qc = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => foldersService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.folders.all })
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      toast.success('Folder deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeactivateAllDocuments() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (folderId: string) => foldersService.deactivateAllDocuments(folderId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      qc.invalidateQueries({ queryKey: queryKeys.folders.all })
      toast.success('All documents deactivated')
    },
    onError: (err) => { toast.error(err) },
  })
}

// ─── Documents ───────────────────────────────────────────────────────────────

export function useOrgDocuments(folderId?: string, params?: ListParams) {
  return useQuery({
    queryKey: queryKeys.orgDocuments.list(folderId, params),
    queryFn: () => orgDocumentsService.list(folderId, params),
    enabled: !!folderId,
  })
}

export function useCreateOrgDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: OrgDocumentCreateDTO) => orgDocumentsService.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      toast.success('Document added successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useCreateOrgDocumentsBulk() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: BulkDocumentCreateDTO) => orgDocumentsService.createBulk(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      toast.success('Documents added successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateOrgDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: OrgDocumentUpdateDTO }) =>
      orgDocumentsService.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      toast.success('Document updated successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteOrgDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => orgDocumentsService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      toast.success('Document deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}

// ─── Upload helper: file → asset → document in one call ─────────────────────

export function useUploadAndCreateDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      file: File
      folderId: string
      title: string
      description?: string
      allowDownload?: boolean
      requireAcknowledgement?: boolean
    }) => {
      const asset = await assetService.upload(input.file, 'org-documents')
      return orgDocumentsService.create({
        folder_id: input.folderId,
        title: input.title,
        description: input.description ?? null,
        // Download is opt-in — default off unless explicitly enabled
        allow_download: input.allowDownload ?? false,
        require_acknowledgement: input.requireAcknowledgement ?? false,
        asset_id: asset.id,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgDocuments.all })
      toast.success('Document uploaded successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteAsset() {
  return useMutation({
    mutationFn: (assetId: string) => assetService.remove(assetId),
    onSuccess: () => { toast.success('Asset deleted successfully') },
    onError: (err) => { toast.error(err) },
  })
}
