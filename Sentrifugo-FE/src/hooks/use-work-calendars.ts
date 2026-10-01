import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  fetchWorkCalendar,
  createWorkCalendar,
  updateWorkCalendar,
  assignWorkCalendar,
  assignEmployeeWorkCalendar,
  fetchShifts,
  fetchShift,
  createShift,
  updateShift,
  deleteShift,
  fetchWorkingDay,
} from '@/api/work-calendars';
import type {
  WorkCalendarCreate,
  WorkCalendarUpdate,
  AssignmentScope,
  EmployeeOverridePayload,
  ShiftCreate,
  ShiftUpdate,
  WorkingDayResponse,
} from '@/types/leave';

export const workCalendarKeys = {
  all: ['work-calendars'] as const,
  detail: (id: string) => [...workCalendarKeys.all, 'detail', id] as const,
  shifts: (calendarId: string) =>
    [...workCalendarKeys.all, 'shifts', calendarId] as const,
  shift: (id: string) => [...workCalendarKeys.all, 'shift', id] as const,
  workingDay: (params: { user_id: string; date: string }) =>
    [...workCalendarKeys.all, 'working-day', params.user_id, params.date] as const,
};

export const useWorkCalendar = (id: string) =>
  useQuery({
    queryKey: workCalendarKeys.detail(id),
    queryFn: () => fetchWorkCalendar(id),
    enabled: !!id,
  });

export const useCreateWorkCalendar = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkCalendarCreate) => createWorkCalendar(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workCalendarKeys.all });
    },
  });
};

export const useUpdateWorkCalendar = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkCalendarUpdate }) =>
      updateWorkCalendar(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workCalendarKeys.all });
    },
  });
};

export const useAssignWorkCalendar = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: AssignmentScope) => assignWorkCalendar(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workCalendarKeys.all });
    },
  });
};

export const useAssignEmployeeWorkCalendar = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: EmployeeOverridePayload) =>
      assignEmployeeWorkCalendar(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workCalendarKeys.all });
    },
  });
};

export const useShifts = (calendarId: string) =>
  useQuery({
    queryKey: workCalendarKeys.shifts(calendarId),
    queryFn: () => fetchShifts(calendarId),
    enabled: !!calendarId,
  });

export const useCreateShift = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ShiftCreate) => createShift(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: workCalendarKeys.shifts(variables.calendar_id),
      });
    },
  });
};

export const useShift = (id: string) =>
  useQuery({
    queryKey: workCalendarKeys.shift(id),
    queryFn: () => fetchShift(id),
    enabled: !!id,
  });

export const useUpdateShift = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ShiftUpdate }) =>
      updateShift(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: workCalendarKeys.shift(variables.id) });
      qc.invalidateQueries({ queryKey: workCalendarKeys.all });
    },
  });
};

export const useDeleteShift = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteShift(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workCalendarKeys.all });
    },
  });
};

export const useWorkingDay = (params: {
  user_id: string;
  date: string;
  department_id?: string;
  business_unit_id?: string;
}) =>
  useQuery({
    queryKey: workCalendarKeys.workingDay(params),
    queryFn: () => fetchWorkingDay(params),
    enabled: !!params.user_id && !!params.date,
  });

export interface WorkingDayRef {
  userId: string;
  date: string;
}

const workingDayCacheKey = (userId: string, date: string) => `${userId}|${date}`;

export interface WorkingDayLookup {
  /** True while at least one lookup in the batch is still in flight. */
  isLoading: boolean;
  get: (userId: string, date: string) => WorkingDayResponse | undefined;
  /**
   * Whether this specific lookup is still in flight. Prefer this over the
   * batch-wide `isLoading` when rendering per-row: it lets each row settle as
   * soon as its own request lands instead of every row waiting on the slowest
   * one in the batch.
   */
  isPending: (userId: string, date: string) => boolean;
}

/**
 * The batch form of `useWorkingDay`, for resolving many (employee, date) pairs
 * at once — a team roster for one day, or one employee across a month.
 *
 * `/working-day` is the only endpoint that answers "is this a working day for
 * *this* employee" without the caller re-implementing the calendar's
 * `weekend_matrix` (week-of-month index × week_start_day offset × half-day
 * codes). It has no bulk variant, hence one request per pair; they share the
 * same cache entries as `useWorkingDay`, so overlapping callers hit cache.
 *
 * Pass a memoised `refs` array — a new array identity on every render would
 * re-subscribe the whole batch each time.
 */
export const useWorkingDays = (refs: WorkingDayRef[]): WorkingDayLookup =>
  useQueries({
    queries: refs.map(({ userId, date }) => ({
      queryKey: workCalendarKeys.workingDay({ user_id: userId, date }),
      queryFn: () => fetchWorkingDay({ user_id: userId, date }),
      enabled: !!userId && !!date,
      // Calendar config barely changes within a session; avoid refetching the
      // same day every time the user toggles back to it.
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
    combine: (results) => {
      const byKey = new Map<string, WorkingDayResponse>();
      const pending = new Set<string>();
      results.forEach((r, i) => {
        const key = workingDayCacheKey(refs[i].userId, refs[i].date);
        if (r.data) byKey.set(key, r.data);
        // isLoading (not isPending) so a failed lookup counts as settled and
        // the caller falls back instead of hanging on a placeholder forever.
        else if (r.isLoading) pending.add(key);
      });
      return {
        isLoading: results.some((r) => r.isLoading),
        get: (userId: string, date: string) =>
          byKey.get(workingDayCacheKey(userId, date)),
        isPending: (userId: string, date: string) =>
          pending.has(workingDayCacheKey(userId, date)),
      };
    },
  });
