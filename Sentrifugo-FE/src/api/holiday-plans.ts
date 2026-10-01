import { apiClient } from '@/lib/axios';
import type {
  HolidayPlanCreate,
  HolidayPlanUpdate,
  HolidayPlanResponse,
  HolidayPlanListItem,
  HolidayPlanEmployeeEntry,
  HolidayCreate,
  HolidayUpdate,
  HolidayResponse,
} from '@/types/leave';

export const fetchHolidayPlans = async (
  orgId: string,
  year?: number,
): Promise<HolidayPlanResponse[]> => {
  const { data } = await apiClient.get<HolidayPlanResponse[]>(
    '/holiday-plans',
    {
      params: { org_id: orgId, ...(year !== undefined && { year }) },
    },
  );
  return data;
};

/**
 * `/holiday-plans` scoped to the caller's own org (derived from the token), so
 * callers that don't already hold an org id don't have to look one up.
 */
export const fetchHolidayPlansForYear = async (
  year: number,
): Promise<HolidayPlanListItem[]> => {
  const { data } = await apiClient.get<HolidayPlanListItem[]>('/holiday-plans', {
    params: { year },
  });
  return data;
};

/** Members of one holiday plan — the only way to answer "which plan is this
 *  employee on?", since no endpoint takes a user id. */
export const fetchHolidayPlanEmployees = async (
  planId: string,
): Promise<HolidayPlanEmployeeEntry[]> => {
  const { data } = await apiClient.get<HolidayPlanEmployeeEntry[]>(
    `/holiday-plans/${planId}/employees`,
  );
  return data;
};

/** Holidays of one plan within a date range. */
export const fetchHolidaysCalendar = async (
  planId: string,
  fromDate: string,
  toDate: string,
): Promise<HolidayResponse[]> => {
  const { data } = await apiClient.get<HolidayResponse[]>('/holidays/calendar', {
    params: { plan_id: planId, from_date: fromDate, to_date: toDate },
  });
  return data;
};

export const fetchHolidayPlan = async (
  id: string,
): Promise<HolidayPlanResponse> => {
  const { data } = await apiClient.get<HolidayPlanResponse>(
    `/holiday-plans/${id}`,
  );
  return data;
};

export const createHolidayPlan = async (
  data: HolidayPlanCreate,
): Promise<HolidayPlanResponse> => {
  const { data: responseData } = await apiClient.post<HolidayPlanResponse>(
    '/holiday-plans',
    data,
  );
  return responseData;
};

export const updateHolidayPlan = async (
  id: string,
  data: HolidayPlanUpdate,
): Promise<HolidayPlanResponse> => {
  const { data: responseData } = await apiClient.put<HolidayPlanResponse>(
    `/holiday-plans/${id}`,
    data,
  );
  return responseData;
};

export const deleteHolidayPlan = async (id: string): Promise<void> => {
  await apiClient.delete(`/holiday-plans/${id}`);
};

export const fetchHolidays = async (
  planId: string,
): Promise<HolidayResponse[]> => {
  const { data } = await apiClient.get<HolidayResponse[]>(
    `/holiday-plans/${planId}/holidays`,
  );
  return data;
};

export const createHoliday = async (
  data: HolidayCreate,
): Promise<HolidayResponse> => {
  const { data: responseData } = await apiClient.post<HolidayResponse>(
    '/holidays',
    data,
  );
  return responseData;
};

export const updateHoliday = async (
  id: string,
  data: HolidayUpdate,
): Promise<HolidayResponse> => {
  const { data: responseData } = await apiClient.put<HolidayResponse>(
    `/holidays/${id}`,
    data,
  );
  return responseData;
};

export const deleteHoliday = async (id: string): Promise<void> => {
  await apiClient.delete(`/holidays/${id}`);
};
