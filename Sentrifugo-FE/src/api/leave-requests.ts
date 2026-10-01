import { apiClient } from '@/lib/axios';
import type {
  LeaveRequestCreate,
  LeaveRequestResponse,
  LeaveRequestBalanceResponse,
  LeaveRequestEstimateParams,
  LeaveRequestEstimateResponse,
  ApprovalActionPayload,
  ApprovalFlowCreate,
  ApprovalFlowResponse,
  ApprovalOverrideCreate,
} from '@/types/leave';

export const fetchLeaveRequests = async (
  params?: { employee_id?: string; status?: string },
): Promise<LeaveRequestResponse[]> => {
  const { data } = await apiClient.get<LeaveRequestResponse[]>(
    '/leave-requests',
    { params },
  );
  return data;
};

export const fetchLeaveRequest = async (
  id: string,
): Promise<LeaveRequestResponse> => {
  const { data } = await apiClient.get<LeaveRequestResponse>(
    `/leave-requests/${id}`,
  );
  return data;
};

export const createLeaveRequest = async (
  data: LeaveRequestCreate,
): Promise<LeaveRequestResponse> => {
  const { data: responseData } = await apiClient.post<LeaveRequestResponse>(
    '/leave-requests',
    data,
  );
  return responseData;
};

export const approveLeaveRequest = async (
  id: string,
  data: ApprovalActionPayload,
): Promise<LeaveRequestResponse> => {
  const { data: responseData } = await apiClient.post<LeaveRequestResponse>(
    `/leave-requests/${id}/approve`,
    data,
  );
  return responseData;
};

export const rejectLeaveRequest = async (
  id: string,
  data: ApprovalActionPayload,
): Promise<LeaveRequestResponse> => {
  const { data: responseData } = await apiClient.post<LeaveRequestResponse>(
    `/leave-requests/${id}/reject`,
    data,
  );
  return responseData;
};

export const cancelLeaveRequest = async (
  id: string,
): Promise<LeaveRequestResponse> => {
  const { data } = await apiClient.post<LeaveRequestResponse>(
    `/leave-requests/${id}/cancel`,
  );
  return data;
};

export const fetchLeaveRequestBalance = async (
  leave_type_id: string,
): Promise<LeaveRequestBalanceResponse> => {
  const { data } = await apiClient.get<LeaveRequestBalanceResponse>(
    '/leave-requests/balance',
    { params: { leave_type_id } },
  );
  return data;
};

export const fetchLeaveRequestEstimate = async (
  params: LeaveRequestEstimateParams,
): Promise<LeaveRequestEstimateResponse> => {
  const { data } = await apiClient.get<LeaveRequestEstimateResponse>(
    '/leave-requests/estimate',
    { params },
  );
  return data;
};

export const fetchApprovalFlow = async (
  leavePlanId: string,
): Promise<ApprovalFlowResponse | null> => {
  const { data } = await apiClient.get<ApprovalFlowResponse | null>(
    '/approval-flows',
    { params: { leave_plan_id: leavePlanId } },
  );
  return data;
};

export const createApprovalFlow = async (
  data: ApprovalFlowCreate,
): Promise<ApprovalFlowResponse> => {
  const { data: responseData } = await apiClient.post<ApprovalFlowResponse>(
    '/approval-flows',
    data,
  );
  return responseData;
};

export const createApprovalOverride = async (
  data: ApprovalOverrideCreate,
): Promise<object> => {
  const { data: responseData } = await apiClient.post<object>(
    '/approval-overrides',
    data,
  );
  return responseData;
};
