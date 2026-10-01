import type { EnrichedEmployeeFields } from "@/types/leave";

/**
 * The LMS attaches employee display fields (name/emp_code/dept/BU/…) to its
 * membership responses. These helpers adapt that shape to what the existing
 * employee-card / table UI expects (firstName/lastName/empCode/…), so display
 * surfaces can render straight from the LMS response without fetching the whole
 * org from IAM and joining client-side.
 */
export interface NormalizedMember {
  user_id: string;
  userId: string;
  id: string;
  firstName: string;
  lastName: string;
  empCode: string;
  workEmail: string;
  departmentName?: string;
  businessUnitName?: string;
  designationName?: string;
}

export function normalizeMember<
  T extends EnrichedEmployeeFields & { user_id: string },
>(m: T): NormalizedMember {
  const full = (m.name ?? "").trim();
  const sp = full.indexOf(" ");
  return {
    user_id: m.user_id,
    userId: m.user_id,
    id: m.user_id,
    firstName: sp === -1 ? full : full.slice(0, sp),
    lastName: sp === -1 ? "" : full.slice(sp + 1),
    empCode: m.emp_code ?? "",
    workEmail: m.work_email ?? "",
    departmentName: m.department_name ?? undefined,
    businessUnitName: m.business_unit_name ?? undefined,
    designationName: m.designation_name ?? undefined,
  };
}

/** Case-insensitive match over the fields the search box targets. */
export function memberMatchesSearch(m: EnrichedEmployeeFields, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [m.name, m.emp_code, m.work_email].some((v) =>
    (v ?? "").toLowerCase().includes(q),
  );
}
