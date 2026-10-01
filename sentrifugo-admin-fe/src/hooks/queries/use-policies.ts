import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { policiesService } from '@/api/org-setup'
import { queryKeys } from '@/api/query-keys'
import type { PolicyCreateDTO, PolicyListParams, PolicyUpdateDTO, PolicyPermissionsUpdateDTO } from '@/api/org-setup/types'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

export function usePolicy(id: string | null) {
  return useQuery({
    queryKey: queryKeys.policies.byId(id ?? ''),
    queryFn: () => policiesService.getById(id!),
    enabled: !!id,
  })
}

export function usePolicyPermissions(id: string | null) {
  return useQuery({
    queryKey: queryKeys.policies.permissions(id ?? ''),
    queryFn: () => policiesService.getPermissions(id!),
    enabled: !!id,
  })
}

export function usePolicies(params?: PolicyListParams) {
  return useQuery({
    queryKey: queryKeys.policies.list(params as Record<string, unknown>),
    queryFn: () => policiesService.list(params),
  })
}

/** Roles = policies with is_role=true (GET /policies/roles). */
export function useRoles(params?: PolicyListParams) {
  return useQuery({
    queryKey: ['policies', 'roles', params as Record<string, unknown>],
    queryFn: () => policiesService.listRoles(params),
  })
}

export function useCreatePolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: PolicyCreateDTO) => policiesService.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
      toast.success('Role created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdatePolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: PolicyUpdateDTO }) =>
      policiesService.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
      toast.success('Role updated successfully')
    },
    onError: (err) => {
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
    },
  })
}

export function useUpdatePolicyPermissions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: PolicyPermissionsUpdateDTO }) =>
      policiesService.updatePermissions(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
      toast.success('Permissions updated successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useAssignUserPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, policyId }: { userId: string; policyId: string }) =>
      policiesService.assignToUser(userId, policyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
      queryClient.invalidateQueries({ queryKey: ['employees'] })
      toast.success('Role assigned successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDetachUserPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, policyId }: { userId: string; policyId: string }) =>
      policiesService.detachFromUser(userId, policyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
      toast.success('Role removed from employee')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeletePolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => policiesService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.policies.all })
      toast.success('Role deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
