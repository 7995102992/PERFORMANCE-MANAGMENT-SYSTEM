import type { PmsStageNotice } from "@/types/pms-goals";

/** Route of the screen where each stage is worked, so the bell can open it. */
export function stageNoticePath(stage: PmsStageNotice["stage"], fy: number): string {
  switch (stage) {
    case "goal_setting":
      return `/pms/team-goal-setting/${fy}`;
    case "employee_acknowledgement":
      return `/pms/my-goals/${fy}`;
    default:
      return `/pms/goal-approvals/${fy}`;
  }
}

/** "is open from 01-May-2026 to 20-May-2026 (5 days left)." — the end date is always in the line. */
export function stageNoticeSummary(
  notice: PmsStageNotice,
  formatDate: (iso: string) => string,
): string {
  const range = `${formatDate(notice.start_date)} to ${formatDate(notice.end_date)}`;
  if (notice.state === "closed") return `closed on ${formatDate(notice.end_date)}.`;
  if (notice.state === "upcoming") return `opens on ${formatDate(notice.start_date)} and ends on ${formatDate(notice.end_date)}.`;
  const left = notice.days_left ?? 0;
  const when = left <= 1 ? "ends today" : `${left} days left`;
  return `is open from ${range} (${when}).`;
}
