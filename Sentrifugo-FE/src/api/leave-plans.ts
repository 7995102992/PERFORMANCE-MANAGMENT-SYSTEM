import { apiClient } from '@/lib/axios';
import type {
  LeavePlanCreate,
  LeavePlanUpdate,
  LeavePlanResponse,
  LeavePlanAssignmentCreate,
  LeavePlanAssignmentResponse,
  EmployeeLeavePlanResponse,
} from '@/types/leave';

export const fetchLeavePlans = async (
  orgId: string,
): Promise<LeavePlanResponse[]> => {
  const { data } = await apiClient.get<LeavePlanResponse[]>('/leave-plans', {
    params: { org_id: orgId },
  });
  return data;
};

export const fetchLeavePlan = async (
  id: string,
): Promise<LeavePlanResponse> => {
  const { data } = await apiClient.get<LeavePlanResponse>(
    `/leave-plans/${id}`,
  );
  return data;
};

export const createLeavePlan = async (
  data: LeavePlanCreate,
): Promise<LeavePlanResponse> => {
  const { data: responseData } = await apiClient.post<LeavePlanResponse>(
    '/leave-plans',
    data,
  );
  return responseData;
};

export const updateLeavePlan = async (
  id: string,
  data: LeavePlanUpdate,
): Promise<LeavePlanResponse> => {
  const { data: responseData } = await apiClient.put<LeavePlanResponse>(
    `/leave-plans/${id}`,
    data,
  );
  return responseData;
};

export const createLeavePlanAssignment = async (
  data: LeavePlanAssignmentCreate,
): Promise<LeavePlanAssignmentResponse> => {
  const { data: responseData } =
    await apiClient.post<LeavePlanAssignmentResponse>(
      '/leave-plan-assignments',
      data,
    );
  return responseData;
};

export const fetchLeavePlanAssignments = async (
  planId: string,
): Promise<LeavePlanAssignmentResponse[]> => {
  const { data } = await apiClient.get<LeavePlanAssignmentResponse[]>(
    `/leave-plans/${planId}/assignments`,
  );
  return data;
};

export const resolveEmployeeLeavePlan = async (params: {
  user_id: string;
  org_id: string;
  department_id?: string;
  business_unit_id?: string;
}): Promise<EmployeeLeavePlanResponse | null> => {
  const { data } = await apiClient.post<EmployeeLeavePlanResponse | null>(
    '/employee-leave-plans/resolve',
    null,
    { params },
  );
  return data;
};

export const fetchEmployeeLeavePlan = async (
  employeeId: string,
): Promise<EmployeeLeavePlanResponse | null> => {
  const { data } = await apiClient.get<EmployeeLeavePlanResponse | null>(
    `/employee-leave-plans/${employeeId}`,
  );
  return data;
};
