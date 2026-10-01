import { apiClient } from '@/lib/axios'
import type { AuditFacets, AuditLogQuery, AuditLogsResponse } from '@/types/audit-log'

// The IAM read-proxy lives on the same base as the rest of the admin API
// (VITE_API_BASE_URL). Org scoping is enforced server-side from the JWT.
export const auditLogsService = {
  async list(params: AuditLogQuery): Promise<AuditLogsResponse> {
    // Drop empty values so we don't send blank query params.
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    )
    const { data } = await apiClient.get<AuditLogsResponse>('/audit-logs', { params: clean })
    return data
  },

  async facets(): Promise<AuditFacets> {
    const { data } = await apiClient.get<AuditFacets>('/audit-logs/facets')
    return data
  },
}
