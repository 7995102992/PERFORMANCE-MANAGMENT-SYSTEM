import { useQuery, useQueries } from '@tanstack/react-query';
import {
  fetchHolidayPlansForYear,
  fetchHolidayPlanEmployees,
  fetchHolidaysCalendar,
} from '@/api/holiday-plans';

export const employeeHolidayKeys = {
  all: ['employee-holidays'] as const,
  plans: (year: number) => [...employeeHolidayKeys.all, 'plans', year] as const,
  members: (planId: string) =>
    [...employeeHolidayKeys.all, 'members', planId] as const,
  calendar: (planId: string, from: string, to: string) =>
    [...employeeHolidayKeys.all, 'calendar', planId, from, to] as const,
};

export interface EmployeeHolidayResolver {
  get: (userId: string, date: string) => string | undefined;
}

/**
 * The imperative form of `useEmployeeHolidays`, for code outside the render
 * cycle — a CSV export walking a date range, for example. Resolves the same
 * way: plans for the year → members → that plan's holidays.
 *
 * Ranges spanning a year boundary fetch each year's plans, since plans are
 * per-year and an employee is assigned to one in each.
 */
export const fetchEmployeeHolidayResolver = async (
  fromDate: string,
  toDate: string,
): Promise<EmployeeHolidayResolver> => {
  const fromYear = Number(fromDate.slice(0, 4));
  const toYear = Number(toDate.slice(0, 4));
  const years = Array.from(
    { length: Math.max(1, toYear - fromYear + 1) },
    (_, i) => fromYear + i,
  );

  const planLists = await Promise.all(years.map((y) => fetchHolidayPlansForYear(y)));
  const ids = [...new Set(planLists.flat().map((p) => p._id))];

  const [memberLists, holidayLists] = await Promise.all([
    Promise.all(ids.map((id) => fetchHolidayPlanEmployees(id))),
    Promise.all(ids.map((id) => fetchHolidaysCalendar(id, fromDate, toDate))),
  ]);

  const planByUser = new Map<string, string>();
  memberLists.forEach((entries, i) => {
    for (const entry of entries) {
      if (!planByUser.has(entry.user_id)) planByUser.set(entry.user_id, ids[i]);
    }
  });

  const byPlan = new Map<string, Map<string, string>>();
  holidayLists.forEach((holidays, i) => {
    const byDate = new Map<string, string>();
    for (const h of holidays) {
      if (h.date) byDate.set(h.date.slice(0, 10), h.name);
    }
    byPlan.set(ids[i], byDate);
  });

  return {
    get: (userId: string, date: string) => {
      const planId = planByUser.get(userId);
      if (!planId) return undefined;
      return byPlan.get(planId)?.get(date);
    },
  };
};

export interface EmployeeHolidayLookup {
  /** True while the plan list, memberships or holidays are still resolving. */
  isLoading: boolean;
  /** Holiday name for this employee on this date, from the plan they are
   *  assigned to. `undefined` means it is an ordinary day for them. */
  get: (userId: string, date: string) => string | undefined;
  /** The plan an employee is assigned to, or `undefined` if they are on none. */
  planIdFor: (userId: string) => string | undefined;
}

const EMPTY: string[] = [];

/**
 * Holidays for specific employees, resolved through the holiday plan each one is
 * actually assigned to.
 *
 * This exists because no endpoint answers "holidays for employee X". The two
 * sources that look like they do are both wrong for this purpose:
 *
 *  - `/working-day` returns `is_holiday` / `holiday_name`, but it matches
 *    holidays by `applicable_department_ids` / `business_unit_ids` across every
 *    plan in the org — it never consults the employee's plan assignment. An
 *    employee on the India plan whose department is also tagged on a US plan's
 *    holiday gets that US holiday back (e.g. Labor Day on 2026-09-07). Callers
 *    must not use `is_holiday`; use this hook instead.
 *  - `/holidays/calendar?plan_id=` and `/manager/team-calendar` are org- and
 *    team-wide, so one employee's holiday leaks onto everyone on the screen.
 *
 * `/my-holidays` does it correctly but is self-scoped, so HR and managers
 * viewing someone else can't use it. Until the backend exposes a per-user
 * equivalent, we reproduce it: plans for the year → members of each plan →
 * `user_id → plan_id` → that plan's holidays. Request count scales with the
 * number of plans in the org (typically a handful), not the number of
 * employees, and the queries are shared via the cache across callers.
 *
 * An employee on no plan gets no holidays — never a fallback to another plan.
 *
 * `userIds` only gates whether we fetch at all; the lookup is keyed by plan, so
 * the array does not need to be memoised.
 */
export const useEmployeeHolidays = (
  userIds: string[],
  fromDate: string,
  toDate: string,
): EmployeeHolidayLookup => {
  const year = Number(fromDate.slice(0, 4));
  const enabled = userIds.length > 0 && !!fromDate && !!toDate && !!year;

  const plansQuery = useQuery({
    queryKey: employeeHolidayKeys.plans(year),
    queryFn: () => fetchHolidayPlansForYear(year),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const planIds = plansQuery.data?.map((p) => p._id) ?? EMPTY;

  // Memberships and holidays are fetched in parallel rather than chained: the
  // holiday lists are keyed by plan, so we don't need to know who is on which
  // plan before asking for them. Plan counts are small; a serial round trip
  // would cost more than the extra requests.
  const membershipQueries = useQueries({
    queries: planIds.map((planId) => ({
      queryKey: employeeHolidayKeys.members(planId),
      queryFn: () => fetchHolidayPlanEmployees(planId),
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
    combine: (results) => ({
      isLoading: results.some((r) => r.isLoading),
      // user_id → plan_id. An employee on more than one plan keeps the first
      // match, mirroring how /my-holidays resolves a single plan per employee.
      byUser: results.reduce((map, r, i) => {
        for (const entry of r.data ?? []) {
          if (!map.has(entry.user_id)) map.set(entry.user_id, planIds[i]);
        }
        return map;
      }, new Map<string, string>()),
    }),
  });

  const holidayQueries = useQueries({
    queries: planIds.map((planId) => ({
      queryKey: employeeHolidayKeys.calendar(planId, fromDate, toDate),
      queryFn: () => fetchHolidaysCalendar(planId, fromDate, toDate),
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
    combine: (results) => ({
      isLoading: results.some((r) => r.isLoading),
      // plan_id → (yyyy-MM-dd → holiday name)
      byPlan: results.reduce((map, r, i) => {
        const byDate = new Map<string, string>();
        for (const h of r.data ?? []) {
          if (h.date) byDate.set(h.date.slice(0, 10), h.name);
        }
        map.set(planIds[i], byDate);
        return map;
      }, new Map<string, Map<string, string>>()),
    }),
  });

  const planIdFor = (userId: string) => membershipQueries.byUser.get(userId);

  return {
    isLoading:
      enabled &&
      (plansQuery.isLoading ||
        membershipQueries.isLoading ||
        holidayQueries.isLoading),
    planIdFor,
    get: (userId: string, date: string) => {
      const planId = planIdFor(userId);
      if (!planId) return undefined;
      return holidayQueries.byPlan.get(planId)?.get(date);
    },
  };
};
