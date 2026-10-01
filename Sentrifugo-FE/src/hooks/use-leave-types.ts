import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchLeaveTypes, fetchLeaveType, createLeaveType, updateLeaveType } from '@/api/leave-types';
import type { LeaveTypeCreate, LeaveTypeUpdate } from '@/types/leave';

export const leaveTypeKeys = {
  all: ['leave-types'] as const,
  list: (orgId: string) => [...leaveTypeKeys.all, 'list', orgId] as const,
  detail: (id: string) => [...leaveTypeKeys.all, 'detail', id] as const,
};

export const useLeaveTypes = (orgId: string) =>
  useQuery({
    queryKey: leaveTypeKeys.list(orgId),
    queryFn: () => fetchLeaveTypes(orgId),
    enabled: !!orgId,
  });

export const useLeaveType = (id: string) =>
  useQuery({
    queryKey: leaveTypeKeys.detail(id),
    queryFn: () => fetchLeaveType(id),
    enabled: !!id,
  });

export const useCreateLeaveType = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LeaveTypeCreate) => createLeaveType(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leaveTypeKeys.all });
    },
  });
};

export const useUpdateLeaveType = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: LeaveTypeUpdate }) =>
      updateLeaveType(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leaveTypeKeys.all });
    },
  });
};
