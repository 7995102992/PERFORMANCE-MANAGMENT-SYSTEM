import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { designationsService } from '@/api/org-setup'
import { queryKeys, type ListParams } from '@/api/query-keys'
import type { DesignationCreateDTO, DesignationUpdateDTO } from '@/api/org-setup/types'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

export function useDesignations(_organisationId?: string, params?: ListParams) {
  return useQuery({
    queryKey: [...queryKeys.designations.list(_organisationId, params)],
    queryFn: () => designationsService.list(params),
    enabled: !!_organisationId,
    staleTime: 2 * 60 * 1000,
  })
}

export function useCreateDesignation() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: DesignationCreateDTO) => designationsService.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.designations.all })
      toast.success('Designation created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateDesignation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: DesignationUpdateDTO }) =>
      designationsService.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.designations.all })
      // A designation owns its policy/role; updating it changes that policy's
      // name + permission grid. Invalidate the policies cache too so the grid
      // editor re-seeds from fresh data instead of the stale (pre-edit) cache.
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
      toast.success('Designation updated successfully')
    },
    onError: (err) => {
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: queryKeys.designations.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
    },
  })
}

export function useDeleteDesignation() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => designationsService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.designations.all })
      toast.success('Designation deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
