import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { auditLogsService } from '@/api/audit-logs'
import type { AuditLogQuery } from '@/types/audit-log'

const ALL_KEY = ['audit-logs'] as const

export function useAuditLogs(params: AuditLogQuery, enabled = true) {
  return useQuery({
    queryKey: [...ALL_KEY, 'list', params],
    queryFn: () => auditLogsService.list(params),
    enabled,
    staleTime: 15 * 1000,
    placeholderData: keepPreviousData,
  })
}

export function useAuditFacets(enabled = true) {
  return useQuery({
    queryKey: [...ALL_KEY, 'facets'],
    queryFn: () => auditLogsService.facets(),
    enabled,
    staleTime: 60 * 1000,
  })
}
