import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { organisationService, saveOrganisation } from '@/api/org-setup'
import { queryKeys } from '@/api/query-keys'
import { store } from '@/store'
import type { OrganisationFormValues } from '@/modules/org-setup/types/organisation'
import { toast } from '@/lib/toast'

// ─── Read ────────────────────────────────────────────────────────────────────

export function useOrganisations(enabled = true) {
  return useQuery({
    queryKey: queryKeys.organisation.list(),
    queryFn: () => {
      const token = store.getState().auth.token
      if (!token) return Promise.resolve([])
      return organisationService.list()
    },
    staleTime: 60 * 1000,
    enabled,
  })
}

export function useOrganisation(id: string | null) {
  return useQuery({
    queryKey: queryKeys.organisation.byId(id ?? ''),
    queryFn: () => organisationService.getById(id!),
    enabled: !!id,
  })
}

// ─── Write ────────────────────────────────────────────────────────────────────

interface SaveOrgVariables {
  organisationId?: string
  values: OrganisationFormValues
  existingLogoAssetId?: string | null
}

export function useSaveOrganisation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (vars: SaveOrgVariables) => saveOrganisation(vars),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organisation.all })
      queryClient.setQueryData(queryKeys.organisation.byId(data.id), data)
      toast.success('Organisation saved successfully')
    },
    onError: (err) => { toast.error(err) },
  })
}

export function useDeleteOrganisation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => organisationService.remove(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organisation.all })
      queryClient.removeQueries({ queryKey: queryKeys.organisation.byId(id) })
      toast.success('Organisation deleted')
    },
    onError: (err) => { toast.error(err) },
  })
}
