import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { departmentsService } from '@/api/org-setup'
import { queryKeys, type ListParams } from '@/api/query-keys'
import type { DepartmentCreateDTO, DepartmentUpdateDTO } from '@/api/org-setup/types'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

export function useDepartments(_organisationId?: string, params?: ListParams & { businessUnitIds?: string[] }) {
  return useQuery({
    queryKey: [...queryKeys.departments.list(_organisationId, params), params?.businessUnitIds ?? []],
    queryFn: () => departmentsService.list(params),
    enabled: !!_organisationId,
    staleTime: 2 * 60 * 1000,
  })
}

export function useDepartmentsByBUs(_organisationId?: string, businessUnitIds?: string[]) {
  return useQuery({
    queryKey: ['departments', 'by-bus', _organisationId, businessUnitIds],
    queryFn: () => departmentsService.list({ businessUnitIds, limit: 100, is_active: true }),
    enabled: !!_organisationId && !!businessUnitIds && businessUnitIds.length > 0,
    staleTime: 2 * 60 * 1000,
  })
}

export function useCreateDepartment() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: DepartmentCreateDTO) => departmentsService.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.all })
      toast.success('Department created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateDepartment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: DepartmentUpdateDTO }) =>
      departmentsService.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.all })
      toast.success('Department updated successfully')
    },
    onError: (err) => {
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.all })
    },
  })
}

export function useDeleteDepartment() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => departmentsService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.all })
      toast.success('Department deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
