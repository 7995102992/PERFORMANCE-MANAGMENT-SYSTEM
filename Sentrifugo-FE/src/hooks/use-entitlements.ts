import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchEntitlementPolicies,
  fetchEntitlementPolicy,
  createEntitlementPolicy,
  updateEntitlementPolicy,
  fetchEntitlements,
  createEntitlement,
  fetchLedger,
  createLedgerEntry,
  fetchBalance,
} from '@/api/entitlements';
import type {
  EntitlementPolicyCreate,
  EntitlementPolicyUpdate,
  LeaveEntitlementCreate,
  LedgerEntryCreate,
} from '@/types/leave';

export const entitlementPolicyKeys = {
  all: ['entitlement-policies'] as const,
  list: (leavePlanId: string) =>
    [...entitlementPolicyKeys.all, 'list', leavePlanId] as const,
  detail: (id: string) =>
    [...entitlementPolicyKeys.all, 'detail', id] as const,
};

export const entitlementKeys = {
  all: ['entitlements'] as const,
  list: (employeeId: string) =>
    [...entitlementKeys.all, 'list', employeeId] as const,
};

export const ledgerKeys = {
  all: ['ledger'] as const,
  list: (employeeId: string, leaveTypeId?: string) =>
    [
      ...ledgerKeys.all,
      'list',
      employeeId,
      ...(leaveTypeId != null ? [leaveTypeId] : []),
    ] as const,
};

export const balanceKeys = {
  all: ['leave-balance'] as const,
  detail: (employeeId: string, leaveTypeId: string) =>
    [...balanceKeys.all, 'detail', employeeId, leaveTypeId] as const,
};

export const useEntitlementPolicies = (leavePlanId: string) =>
  useQuery({
    queryKey: entitlementPolicyKeys.list(leavePlanId),
    queryFn: () => fetchEntitlementPolicies(leavePlanId),
    enabled: !!leavePlanId,
  });

export const useEntitlementPolicy = (id: string) =>
  useQuery({
    queryKey: entitlementPolicyKeys.detail(id),
    queryFn: () => fetchEntitlementPolicy(id),
    enabled: !!id,
  });

export const useCreateEntitlementPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: EntitlementPolicyCreate) =>
      createEntitlementPolicy(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: entitlementPolicyKeys.list(variables.leave_plan_id),
      });
    },
  });
};

export const useUpdateEntitlementPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: EntitlementPolicyUpdate;
    }) => updateEntitlementPolicy(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: entitlementPolicyKeys.all });
    },
  });
};

export const useEntitlements = (employeeId: string) =>
  useQuery({
    queryKey: entitlementKeys.list(employeeId),
    queryFn: () => fetchEntitlements(employeeId),
    enabled: !!employeeId,
  });

export const useCreateEntitlement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LeaveEntitlementCreate) => createEntitlement(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: entitlementKeys.list(variables.employee_id),
      });
      qc.invalidateQueries({ queryKey: balanceKeys.all });
    },
  });
};

export const useLedger = (employeeId: string, leaveTypeId?: string) =>
  useQuery({
    queryKey: ledgerKeys.list(employeeId, leaveTypeId),
    queryFn: () => fetchLedger(employeeId, leaveTypeId),
    enabled: !!employeeId,
  });

export const useCreateLedgerEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LedgerEntryCreate) => createLedgerEntry(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ledgerKeys.list(variables.employee_id, variables.leave_type_id),
      });
      qc.invalidateQueries({
        queryKey: balanceKeys.detail(
          variables.employee_id,
          variables.leave_type_id,
        ),
      });
    },
  });
};

export const useLeaveBalance = (employeeId: string, leaveTypeId: string) =>
  useQuery({
    queryKey: balanceKeys.detail(employeeId, leaveTypeId),
    queryFn: () => fetchBalance(employeeId, leaveTypeId),
    enabled: !!employeeId && !!leaveTypeId,
  });
