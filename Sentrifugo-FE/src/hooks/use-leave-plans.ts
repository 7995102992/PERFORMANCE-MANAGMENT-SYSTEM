import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchLeavePlans,
  fetchLeavePlan,
  createLeavePlan,
  updateLeavePlan,
  fetchLeavePlanAssignments,
  createLeavePlanAssignment,
  fetchEmployeeLeavePlan,
  resolveEmployeeLeavePlan,
} from '@/api/leave-plans';
import type {
  LeavePlanCreate,
  LeavePlanUpdate,
  LeavePlanAssignmentCreate,
} from '@/types/leave';

export const leavePlanKeys = {
  all: ['leave-plans'] as const,
  list: (orgId: string) => [...leavePlanKeys.all, 'list', orgId] as const,
  detail: (id: string) => [...leavePlanKeys.all, 'detail', id] as const,
  assignments: (planId: string) =>
    [...leavePlanKeys.all, 'assignments', planId] as const,
  employeePlan: (employeeId: string) =>
    [...leavePlanKeys.all, 'employee-plan', employeeId] as const,
};

export const useLeavePlans = (orgId: string) =>
  useQuery({
    queryKey: leavePlanKeys.list(orgId),
    queryFn: () => fetchLeavePlans(orgId),
    enabled: !!orgId,
  });

export const useLeavePlan = (id: string) =>
  useQuery({
    queryKey: leavePlanKeys.detail(id),
    queryFn: () => fetchLeavePlan(id),
    enabled: !!id,
  });

export const useCreateLeavePlan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LeavePlanCreate) => createLeavePlan(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leavePlanKeys.all });
    },
  });
};

export const useUpdateLeavePlan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: LeavePlanUpdate }) =>
      updateLeavePlan(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leavePlanKeys.all });
    },
  });
};

export const useLeavePlanAssignments = (planId: string) =>
  useQuery({
    queryKey: leavePlanKeys.assignments(planId),
    queryFn: () => fetchLeavePlanAssignments(planId),
    enabled: !!planId,
  });

export const useCreateLeavePlanAssignment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LeavePlanAssignmentCreate) =>
      createLeavePlanAssignment(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: leavePlanKeys.assignments(variables.leave_plan_id),
      });
    },
  });
};

export const useEmployeeLeavePlan = (employeeId: string) =>
  useQuery({
    queryKey: leavePlanKeys.employeePlan(employeeId),
    queryFn: () => fetchEmployeeLeavePlan(employeeId),
    enabled: !!employeeId,
  });

export const useResolveEmployeeLeavePlan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      user_id: string;
      org_id: string;
      department_id?: string;
      business_unit_id?: string;
    }) => resolveEmployeeLeavePlan(params),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: leavePlanKeys.employeePlan(variables.user_id),
      });
    },
  });
};
