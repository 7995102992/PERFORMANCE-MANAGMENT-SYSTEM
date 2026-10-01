import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { employeesService } from '@/api/org-setup'
import type { EmployeeCreateDTO, EmployeeUpdateDTO, EmployeeListParams } from '@/api/org-setup/employees'
import { usersService } from '@/api/users'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

const ALL_KEY = ['employees'] as const

export function useEmployees(_organisationId?: string, params?: EmployeeListParams) {
  return useQuery({
    queryKey: [...ALL_KEY, 'list', _organisationId ?? 'all', params ?? {}],
    queryFn: () => employeesService.list(params),
    enabled: !!_organisationId,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  })
}

export function useEmployee(id: string | null) {
  return useQuery({
    queryKey: [...ALL_KEY, id ?? ''],
    queryFn: () => employeesService.getById(id!),
    enabled: !!id,
  })
}

export function useCreateEmployee() {
  const qc = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: EmployeeCreateDTO) => employeesService.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_KEY })
      toast.success('Employee created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: EmployeeUpdateDTO }) =>
      employeesService.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_KEY })
      toast.success('Employee updated successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

/** Resend the activation email for a pending employee (keyed by their user id). */
export function useResendEmployeeActivation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => usersService.resendActivation(userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_KEY })
      toast.success('Activation email resent.')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteEmployee() {
  const qc = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => employeesService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_KEY })
      toast.success('Employee removed')
    },
    onError: (err) => { toast.error(err) },
  })
}

// ─── Bulk upload ─────────────────────────────────────────────────────────────

export function useDownloadTemplate() {
  return useMutation({
    mutationFn: () => employeesService.downloadTemplate(),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'employee-bulk-template.xlsx'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Template downloaded')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useBulkValidate() {
  return useMutation({
    mutationFn: ({ file }: { file: File }) => employeesService.bulkValidate(file),
    onError: (err) => { toast.error(err) },
  })
}

export function useBulkUpload() {
  const qc = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: ({ file, selectedRowNums }: { file: File; selectedRowNums?: number[] }) =>
      employeesService.bulkUpload(file, selectedRowNums),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ALL_KEY })
      toast.success(`${data.successful} employee${data.successful === 1 ? '' : 's'} imported successfully`)
    },
    onError: (err) => { toast.error(err) },
  })
}
