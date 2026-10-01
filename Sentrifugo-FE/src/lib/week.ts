/** Monday of the week containing `date` (weeks run Mon–Sun). */
export function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Which of its month's Mondays this week starts on — 1 for the first, 2 for
 * the second, and so on.
 *
 * A week belongs to the month it STARTS in, which is the rule the backend uses
 * for stored timesheets, for unfiled `not_submitted` rows and for the payroll
 * cutoff. So the week's own start date answers this completely: no anchor
 * month is needed, and passing one would only let a caller disagree with the
 * data.
 *
 * This used to count from the Monday of the month's first *calendar* week,
 * which is a different grid. July 2026 starts on a Wednesday, so that grid
 * began at Mon Jun 29 and numbered Jul 6 as "Week 2" — every week in the month
 * shifted up by one, and a four-week month ended at "Week 5".
 *
 * Expect 4 or 5 per month; both are normal. August 2026 has five Mondays
 * (3, 10, 17, 24, 31), so nothing may assume a fixed row count.
 *
 * `getUTCDate`, not `getDate`: `week_start_date` arrives as a naive midnight
 * timestamp, and parsing that anywhere behind UTC rolls it back a day — which
 * turns Monday the 6th into Sunday the 5th and quietly shifts the answer. The
 * same trap the `?week=` deep link hit.
 */
export function getWeekNumberInMonth(weekStartDateStr: string): number {
  const weekStart = new Date(weekStartDateStr);
  return Math.floor((weekStart.getUTCDate() - 1) / 7) + 1;
}

/**
 * The cutoff boundary: the most recent occurrence of `cutoffDay`. This month if
 * today is on or past it, otherwise last month. Days beyond a month's length
 * clamp to its last day, so 31 means month end.
 *
 * Weeks ending before this are closed for editing unless their project's month
 * was reopened — the override part can't be derived client-side, so this only
 * answers the coarse "could anything in this month be closed?".
 */
export function cutoffBoundary(cutoffDay: number, today = new Date()): Date {
  const clampToMonth = (year: number, month: number) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(cutoffDay, lastDay));
  };
  const thisMonth = clampToMonth(today.getFullYear(), today.getMonth());
  thisMonth.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  return start >= thisMonth
    ? thisMonth
    : clampToMonth(today.getFullYear(), today.getMonth() - 1);
}

/**
 * Whether any week in the given month could already be closed — true once the
 * boundary has moved past the month's first day. Used to gate the reopen
 * control; the per-week, per-project answer needs server data.
 */
export function monthHasClosedWeeks(
  month: number,
  year: number,
  cutoffDay: number,
  today = new Date(),
): boolean {
  return cutoffBoundary(cutoffDay, today) > new Date(year, month, 1);
}

/**
 * Whether a week belongs to a month, matching how the backend buckets weeks in
 * GET /approvals/timesheets: by the calendar month of the week's START date.
 *
 * The same rule `getWeekNumberInMonth` counts by, so the two agree — a week
 * this returns true for is numbered within that month, and Mon Jul 27 – Sun
 * Aug 2 is July's fourth week even though it ends in August.
 */
export function isWeekInMonth(
  weekStartDateStr: string,
  month: number,
  year: number,
): boolean {
  const start = new Date(weekStartDateStr);
  return start.getMonth() === month && start.getFullYear() === year;
}
