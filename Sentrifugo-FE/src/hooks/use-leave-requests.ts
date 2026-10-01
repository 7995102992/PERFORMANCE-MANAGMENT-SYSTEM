import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchLeaveRequests,
  fetchLeaveRequest,
  createLeaveRequest,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
  fetchApprovalFlow,
  createApprovalFlow,
  createApprovalOverride,
} from '@/api/leave-requests';
import type {
  LeaveRequestCreate,
  ApprovalActionPayload,
  ApprovalFlowCreate,
  ApprovalOverrideCreate,
} from '@/types/leave';

export const leaveRequestKeys = {
  all: ['leave-requests'] as const,
  list: (params?: { employee_id?: string; status?: string }) =>
    [...leaveRequestKeys.all, 'list', params] as const,
  detail: (id: string) => [...leaveRequestKeys.all, 'detail', id] as const,
  approvalFlow: (leavePlanId: string) =>
    ['approval-flows', leavePlanId] as const,
};

export const useLeaveRequests = (params?: {
  employee_id?: string;
  status?: string;
}) =>
  useQuery({
    queryKey: leaveRequestKeys.list(params),
    queryFn: () => fetchLeaveRequests(params),
  });

export const useLeaveRequest = (id: string) =>
  useQuery({
    queryKey: leaveRequestKeys.detail(id),
    queryFn: () => fetchLeaveRequest(id),
    enabled: !!id,
  });

export const useCreateLeaveRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LeaveRequestCreate) => createLeaveRequest(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leaveRequestKeys.all });
    },
  });
};

export const useApproveLeaveRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ApprovalActionPayload }) =>
      approveLeaveRequest(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: leaveRequestKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: leaveRequestKeys.all });
    },
  });
};

export const useRejectLeaveRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ApprovalActionPayload }) =>
      rejectLeaveRequest(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: leaveRequestKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: leaveRequestKeys.all });
    },
  });
};

export const useCancelLeaveRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelLeaveRequest(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: leaveRequestKeys.detail(id) });
      qc.invalidateQueries({ queryKey: leaveRequestKeys.all });
    },
  });
};

export const useApprovalFlow = (leavePlanId: string) =>
  useQuery({
    queryKey: leaveRequestKeys.approvalFlow(leavePlanId),
    queryFn: () => fetchApprovalFlow(leavePlanId),
    enabled: !!leavePlanId,
  });

export const useCreateApprovalFlow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ApprovalFlowCreate) => createApprovalFlow(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: leaveRequestKeys.approvalFlow(variables.leave_plan_id),
      });
    },
  });
};

export const useCreateApprovalOverride = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ApprovalOverrideCreate) => createApprovalOverride(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: leaveRequestKeys.detail(variables.leave_request_id),
      });
    },
  });
};
