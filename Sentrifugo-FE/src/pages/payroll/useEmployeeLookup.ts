import { useMemo } from 'react'
import { useGetEmployeesQuery } from '@/store/api/iamApi'

export interface EmployeeInfo {
  name: string | null
  designation: string | null
  date_of_joining: string | null
  gender: string | null
}

/**
 * Resolves user_id / emp_code → employee bio from the IAM directory.
 * Used to fill the IAM-owned payslip columns (name, designation, DOJ, gender)
 * and to show uploader names instead of raw user ids, until the backend
 * denormalises these onto the payslip at import.
 */
export function useEmployeeLookup() {
  const { data: employees } = useGetEmployeesQuery()

  return useMemo(() => {
    const byUserId = new Map<string, EmployeeInfo>()
    const byEmpCode = new Map<string, EmployeeInfo>()

    for (const e of employees ?? []) {
      const name =
        [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ').trim() || null
      const info: EmployeeInfo = {
        name,
        designation: e.designationName ?? e.designation_name ?? null,
        date_of_joining: e.dateOfJoining ?? null,
        gender: ((e as Record<string, unknown>).gender as string | undefined) ?? null,
      }
      const uid = e.userId ?? e.user_id
      if (uid) byUserId.set(uid, info)
      const code = e.empCode ?? e.emp_code
      if (code) byEmpCode.set(code, info)
    }

    const nameOf = (userId: string | null | undefined): string =>
      (userId ? byUserId.get(userId)?.name : null) || userId || '—'

    return {
      /** Best-effort bio for a payslip, preferring user_id then emp_code. */
      infoFor: (userId?: string | null, empCode?: string | null): EmployeeInfo | undefined =>
        (userId ? byUserId.get(userId) : undefined) ??
        (empCode ? byEmpCode.get(empCode) : undefined),
      /** Display name for a user id, falling back to the id itself. */
      nameOf,
    }
  }, [employees])
}
