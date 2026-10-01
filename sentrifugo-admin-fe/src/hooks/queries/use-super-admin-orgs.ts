import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { superAdminOrgService } from '@/api/super-admin'
import { queryKeys, type ListParams } from '@/api/query-keys'
import type { SuperAdminOrgCreateDTO, SuperAdminOrgUpdateDTO } from '@/api/super-admin/types'
import { toast } from '@/lib/toast'

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function useSuperAdminDashboard() {
  return useQuery({
    queryKey: queryKeys.superAdminDashboard.stats,
    queryFn: () => superAdminOrgService.getDashboardStats(),
  })
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function useSuperAdminOrgs(params?: ListParams) {
  return useQuery({
    queryKey: queryKeys.superAdminOrgs.list(params),
    queryFn: () => superAdminOrgService.list(params),
  })
}

export function useSuperAdminOrg(id: string | null) {
  return useQuery({
    queryKey: queryKeys.superAdminOrgs.byId(id ?? ''),
    queryFn: () => superAdminOrgService.getById(id!),
    enabled: !!id,
  })
}

// ─── Write ────────────────────────────────────────────────────────────────────

export function useCreateSuperAdminOrg() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: SuperAdminOrgCreateDTO) => superAdminOrgService.create(payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.superAdminOrgs.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.superAdminDashboard.stats })
      toast.success(
        variables.send_activation
          ? 'Organisation created successfully. Activation link sent to admin email.'
          : 'Organisation created successfully.'
      )
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateSuperAdminOrg() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SuperAdminOrgUpdateDTO }) =>
      superAdminOrgService.update(id, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.superAdminOrgs.all })
      queryClient.setQueryData(queryKeys.superAdminOrgs.byId(data.id), data)
      toast.success('Organisation updated successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteSuperAdminOrg() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => superAdminOrgService.remove(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.superAdminOrgs.all })
      queryClient.removeQueries({ queryKey: queryKeys.superAdminOrgs.byId(id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.superAdminDashboard.stats })
      toast.success('Organisation deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
