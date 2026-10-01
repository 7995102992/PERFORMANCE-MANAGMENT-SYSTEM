// Audit Log types — shapes returned by the IAM read-proxy (`GET /audit-logs`).
// Fields marked "Phase 1: null" are not yet captured by any producer and render
// as "—" in the table.

export interface AuditLogRow {
  timestamp: string
  action: string | null
  action_type: string | null
  module: string | null
  target_entity_type: string | null
  target_entity_id: string | null
  target_entity_name: string | null // Phase 1: usually null
  field_names: string[]
  old_value: string | null // Phase 1: null
  new_value: string | null // Phase 1: null
  status: string
  failure_reason: string | null
  user_id: string | null
  user_name: string | null // enriched
  user_email: string | null // enriched
  user_role: string | null // enriched
  source: string | null // Phase 1: null
  user_agent: string | null // Phase 1: null
  ip_address: string | null
  correlation_id: string | null
}

export interface AuditPagination {
  limit: number
  offset: number
  total: number
}

export interface AuditFacets {
  modules: string[]
  action_types: string[]
  actions: string[]
  entity_types: string[]
  statuses: string[]
}

export interface AuditLogsResponse {
  data: AuditLogRow[]
  pagination: AuditPagination
  facets: AuditFacets
}

export interface AuditLogQuery {
  start_time?: string
  end_time?: string
  actor_id?: string
  module?: string
  action_type?: string
  action?: string
  target_entity_type?: string
  status?: string
  user_email?: string
  user_role?: string
  ip_address?: string
  field_name?: string
  search?: string
  limit?: number
  offset?: number
}
