import { apiClient } from '@/lib/axios';
import type {
  LeaveTypeCreate,
  LeaveTypeUpdate,
  LeaveTypeResponse,
} from '@/types/leave';

export const fetchLeaveTypes = async (
  orgId: string,
): Promise<LeaveTypeResponse[]> => {
  const { data } = await apiClient.get<LeaveTypeResponse[]>('/leave-types', {
    params: { org_id: orgId },
  });
  return data;
};

export const fetchLeaveType = async (
  id: string,
): Promise<LeaveTypeResponse> => {
  const { data } = await apiClient.get<LeaveTypeResponse>(
    `/leave-types/${id}`,
  );
  return data;
};

export const createLeaveType = async (
  data: LeaveTypeCreate,
): Promise<LeaveTypeResponse> => {
  const { data: responseData } = await apiClient.post<LeaveTypeResponse>(
    '/leave-types',
    data,
  );
  return responseData;
};

export const updateLeaveType = async (
  id: string,
  data: LeaveTypeUpdate,
): Promise<LeaveTypeResponse> => {
  const { data: responseData } = await apiClient.put<LeaveTypeResponse>(
    `/leave-types/${id}`,
    data,
  );
  return responseData;
};
