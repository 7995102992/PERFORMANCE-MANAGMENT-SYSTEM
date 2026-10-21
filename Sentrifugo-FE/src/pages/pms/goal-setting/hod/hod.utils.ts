/** Route of the HOD Goal Approvals list; `$fy` is the financial-year start (2026). */
export const HOD_LIST_PATH = "/pms/goal-approvals/$fy";
/** Route of the review screen for one request. */
export const HOD_REVIEW_PATH = "/pms/goal-approvals/$fy/review/$requestType/$employeeUserId";
/** Route of the Approval History list. */
export const HOD_HISTORY_PATH = "/pms/goal-approvals/$fy/history";
/** Route of the trail of one employee. */
export const HOD_TRAIL_PATH = "/pms/goal-approvals/$fy/trail/$employeeUserId";

/** Longest remark the API accepts. */
export const HOD_REMARKS_MAX = 500;

/** `5650` → `5,650`; empty values show a dash. */
export function hodNumber(value?: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}

/** `{ value: 5650, unit: "TPD" }` → `5,650 TPD`. */
export function hodValue(value?: number | null, unit?: string | null): string {
  return unit ? `${hodNumber(value)} ${unit}` : hodNumber(value);
}

/** Native select styled like the other PMS filters. */
export const HOD_SELECT_CLASS =
  "h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";
