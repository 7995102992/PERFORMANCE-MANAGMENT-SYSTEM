import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { businessUnitService, saveBusinessUnit } from '@/api/org-setup'
import { queryKeys, type ListParams } from '@/api/query-keys'
import type { BusinessUnitFormValues } from '@/modules/org-setup/types/business-unit'
import { toast } from '@/lib/toast'
import { setupAffecting } from '@/lib/setup-mutation-meta'

// ─── Read ────────────────────────────────────────────────────────────────────

export function useBusinessUnits(_organisationId?: string, params?: ListParams) {
  return useQuery({
    queryKey: queryKeys.businessUnits.list(_organisationId, params),
    queryFn: () => businessUnitService.list(params),
    enabled: _organisationId !== undefined,
    staleTime: 2 * 60 * 1000,
  })
}

// ─── Write ───────────────────────────────────────────────────────────────────

interface SaveBuVariables {
  organisationId?: string
  businessUnitId?: string
  headUserId?: string | null
  values: BusinessUnitFormValues
}

export function useSaveBusinessUnit() {
  const queryClient = useQueryClient()

  return useMutation({
    ...setupAffecting,
    mutationFn: ({ businessUnitId, headUserId, values }: SaveBuVariables) =>
      saveBusinessUnit({ businessUnitId, headUserId, values }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.businessUnits.all })
      toast.success(vars.businessUnitId ? 'Business unit updated successfully' : 'Business unit created successfully')
    },
    onError: (err) => {
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: queryKeys.businessUnits.all })
    },
  })
}

export function useDeleteBusinessUnit() {
  const queryClient = useQueryClient()

  return useMutation({
    ...setupAffecting,
    mutationFn: (id: string) => businessUnitService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.businessUnits.all })
      toast.success('Business unit deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
