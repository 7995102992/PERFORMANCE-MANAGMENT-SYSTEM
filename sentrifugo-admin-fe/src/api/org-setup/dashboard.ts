import { apiClient } from '@/lib/axios'

export interface OrgDashboardStatsDTO {
  total_employees: number
  total_business_units: number
  total_departments: number
  enabled_modules: Array<string | { code: string; is_active: boolean }>
}

export const orgDashboardService = {
  async getStats() {
    const { data } = await apiClient.get<OrgDashboardStatsDTO>('/dashboard/org-stats')
    return data
  },
}
