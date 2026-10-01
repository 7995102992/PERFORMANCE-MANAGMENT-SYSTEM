import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { paygradesService } from '@/api/org-setup'
import { queryKeys } from '@/api/query-keys'
import type { PayGradeCreateDTO, PayGradeUpdateDTO } from '@/api/org-setup/types'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

export function usePayGrades(_organisationId?: string) {
  return useQuery({
    queryKey: [...queryKeys.paygrades.all, _organisationId ?? 'all'],
    queryFn: () => paygradesService.list(),
    enabled: !!_organisationId,
  })
}

export function useCreatePayGrade() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: PayGradeCreateDTO) => paygradesService.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paygrades.all })
      toast.success('Pay grade created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdatePayGrade() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: PayGradeUpdateDTO }) =>
      paygradesService.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paygrades.all })
      toast.success('Pay grade updated successfully')
    },
    onError: (err) => {
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: queryKeys.paygrades.all })
    },
  })
}

export function useDeletePayGrade() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => paygradesService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paygrades.all })
      toast.success('Pay grade deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
