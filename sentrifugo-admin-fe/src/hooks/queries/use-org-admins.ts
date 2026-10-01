import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usersService, type UserCreateDTO } from '@/api/users'
import { queryKeys } from '@/api/query-keys'
import { toast } from '@/lib/toast'

export function useOrgAdmins(organisationId?: string) {
  return useQuery({
    queryKey: queryKeys.orgAdmins.list(organisationId),
    queryFn: () =>
      usersService.list({
        is_org_admin: true,
        organisation_id: organisationId,
      }),
    enabled: !!organisationId,
  })
}

export function useCreateOrgAdmin(organisationId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: Omit<UserCreateDTO, 'is_org_admin'>) =>
      usersService.create({
        ...payload,
        is_org_admin: true,
        auth_method: 'local',
        send_activation: true,
        organisation_id: organisationId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgAdmins.all })
      toast.success('Org admin added. Activation email sent.')
    },
    onError: (err) => toast.error(err),
  })
}

export function useResendOrgAdminActivation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => usersService.resendActivation(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgAdmins.all })
      toast.success('Activation email resent.')
    },
    onError: (err) => toast.error(err),
  })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useToggleOrgAdminStatus(_organisationId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'inactive' }) =>
      usersService.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgAdmins.all })
      toast.success('Status updated')
    },
    onError: (err) => toast.error(err),
  })
}
