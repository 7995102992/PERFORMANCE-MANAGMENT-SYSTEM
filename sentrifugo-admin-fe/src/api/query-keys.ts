// Centralized query key factory — prevents typo bugs & makes invalidation easy.

export interface ListParams {
  skip?: number
  limit?: number
  search?: string
  is_active?: boolean
  is_subsidiary?: boolean
}

export const queryKeys = {
  // External data sources
  companySearch: (query: string) => ['company-search', query] as const,
  companyDetails: (id: string) => ['company-details', id] as const,

  // Backend APIs
  organisation: {
    all: ['organisation'] as const,
    list: (params?: ListParams) => ['organisation', 'list', params ?? {}] as const,
    byId: (id: string) => ['organisation', id] as const,
  },
  businessUnits: {
    all: ['business-units'] as const,
    list: (orgId?: string, params?: ListParams) => ['business-units', 'list', orgId ?? 'all', params ?? {}] as const,
    byId: (id: string) => ['business-units', id] as const,
  },
  departments: {
    all: ['departments'] as const,
    list: (orgId?: string, params?: ListParams) => ['departments', 'list', orgId ?? 'all', params ?? {}] as const,
    byId: (id: string) => ['departments', id] as const,
  },
  designations: {
    all: ['designations'] as const,
    list: (orgId?: string, params?: ListParams) => ['designations', 'list', orgId ?? 'all', params ?? {}] as const,
    byId: (id: string) => ['designations', id] as const,
  },
  folders: {
    all: ['folders'] as const,
    list: (orgId?: string, params?: ListParams) => ['folders', 'list', orgId ?? 'all', params ?? {}] as const,
  },
  orgDocuments: {
    all: ['org-documents'] as const,
    list: (folderId?: string, params?: ListParams) => ['org-documents', 'list', folderId ?? 'all', params ?? {}] as const,
  },
  bands: {
    all: ['bands'] as const,
    byId: (id: string) => ['bands', id] as const,
  },
  paygrades: {
    all: ['paygrades'] as const,
    byId: (id: string) => ['paygrades', id] as const,
  },
  policies: {
    all: ['policies'] as const,
    list: (params?: Record<string, unknown>) => ['policies', 'list', params] as const,
    byId: (id: string) => ['policies', id] as const,
    permissions: (id: string) => ['policies', id, 'permissions'] as const,
  },
  lookups: {
    modules: ['lookups', 'modules'] as const,
    acl: ['lookups', 'acl'] as const,
    permissions: ['lookups', 'permissions'] as const,
  },
  superAdminOrgs: {
    all: ['super-admin-orgs'] as const,
    list: (params?: ListParams) => ['super-admin-orgs', 'list', params ?? {}] as const,
    byId: (id: string) => ['super-admin-orgs', id] as const,
  },
  superAdminDashboard: {
    stats: ['super-admin-dashboard', 'stats'] as const,
  },
  orgDashboard: {
    stats: ['org-dashboard', 'stats'] as const,
  },
  moduleCatalog: ['module-catalog'] as const,
  customFields: {
    all: ['custom-fields'] as const,
    definitions: (entityType?: string, section?: string) => ['custom-fields', 'definitions', entityType ?? 'all', section ?? 'all'] as const,
    definitionById: (id: string) => ['custom-fields', 'definitions', id] as const,
    options: (definitionId: string) => ['custom-fields', 'options', definitionId] as const,
    values: (entityType: string, entityId: string) => ['custom-fields', 'values', entityType, entityId] as const,
  },
  profile: {
    me: ['profile', 'me'] as const,
  },
  orgAdmins: {
    all: ['org-admins'] as const,
    list: (orgId?: string) => ['org-admins', 'list', orgId ?? 'self'] as const,
  },
} as const
