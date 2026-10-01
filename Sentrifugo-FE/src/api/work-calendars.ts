import { apiClient } from '@/lib/axios';
import type {
  WorkCalendarCreate,
  WorkCalendarUpdate,
  WorkCalendarResponse,
  AssignmentScope,
  EmployeeOverridePayload,
  AssignmentResponse,
  ShiftCreate,
  ShiftUpdate,
  ShiftResponse,
  WorkingDayResponse,
} from '@/types/leave';

export const createWorkCalendar = async (
  data: WorkCalendarCreate,
): Promise<WorkCalendarResponse> => {
  const { data: responseData } = await apiClient.post<WorkCalendarResponse>(
    '/work-calendars',
    data,
  );
  return responseData;
};

export const fetchWorkCalendar = async (
  id: string,
): Promise<WorkCalendarResponse> => {
  const { data } = await apiClient.get<WorkCalendarResponse>(
    `/work-calendars/${id}`,
  );
  return data;
};

export const updateWorkCalendar = async (
  id: string,
  data: WorkCalendarUpdate,
): Promise<WorkCalendarResponse> => {
  const { data: responseData } = await apiClient.put<WorkCalendarResponse>(
    `/work-calendars/${id}`,
    data,
  );
  return responseData;
};

export const assignWorkCalendar = async (
  data: AssignmentScope,
): Promise<AssignmentResponse> => {
  const { data: responseData } = await apiClient.post<AssignmentResponse>(
    '/work-calendars/assign',
    data,
  );
  return responseData;
};

export const assignEmployeeWorkCalendar = async (
  data: EmployeeOverridePayload,
): Promise<AssignmentResponse> => {
  const { data: responseData } = await apiClient.post<AssignmentResponse>(
    '/work-calendars/assign/employee',
    data,
  );
  return responseData;
};

export const createShift = async (
  data: ShiftCreate,
): Promise<ShiftResponse> => {
  const { data: responseData } = await apiClient.post<ShiftResponse>(
    '/work-calendars/shifts',
    data,
  );
  return responseData;
};

export const fetchShifts = async (
  calendarId: string,
): Promise<ShiftResponse[]> => {
  const { data } = await apiClient.get<ShiftResponse[]>(
    `/work-calendars/${calendarId}/shifts`,
  );
  return data;
};

export const fetchShift = async (id: string): Promise<ShiftResponse> => {
  const { data } = await apiClient.get<ShiftResponse>(
    `/work-calendars/shifts/${id}`,
  );
  return data;
};

export const updateShift = async (
  id: string,
  data: ShiftUpdate,
): Promise<ShiftResponse> => {
  const { data: responseData } = await apiClient.put<ShiftResponse>(
    `/work-calendars/shifts/${id}`,
    data,
  );
  return responseData;
};

export const deleteShift = async (id: string): Promise<void> => {
  await apiClient.delete(`/work-calendars/shifts/${id}`);
};

export const fetchWorkingDay = async (params: {
  user_id: string;
  date: string;
  department_id?: string;
  business_unit_id?: string;
}): Promise<WorkingDayResponse> => {
  const { data } = await apiClient.get<WorkingDayResponse>('/working-day', {
    params,
  });
  return data;
};
