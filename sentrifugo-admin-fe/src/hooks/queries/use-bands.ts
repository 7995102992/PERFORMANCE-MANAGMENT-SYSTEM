import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { bandsService } from '@/api/org-setup'
import { queryKeys } from '@/api/query-keys'
import type { BandCreateDTO, BandUpdateDTO } from '@/api/org-setup/types'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

export function useBands(_organisationId?: string) {
  return useQuery({
    queryKey: [...queryKeys.bands.all, _organisationId ?? 'all'],
    queryFn: () => bandsService.list(),
    enabled: !!_organisationId,
  })
}

export function useCreateBand() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (payload: BandCreateDTO) => bandsService.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bands.all })
      toast.success('Band created successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useUpdateBand() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: BandUpdateDTO }) =>
      bandsService.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bands.all })
      toast.success('Band updated successfully')
    },
    onError: (err) => {
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: queryKeys.bands.all })
    },
  })
}

export function useDeleteBand() {
  const queryClient = useQueryClient()
  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => bandsService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bands.all })
      toast.success('Band deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
