import { apiClient } from '@/lib/axios';
import type {
  EntitlementPolicyCreate,
  EntitlementPolicyUpdate,
  EntitlementPolicyResponse,
  LeaveEntitlementCreate,
  LeaveEntitlementResponse,
  LedgerEntryCreate,
  LedgerEntryResponse,
  LeaveBalanceResponse,
} from '@/types/leave';

export const fetchEntitlementPolicies = async (
  leavePlanId: string,
): Promise<EntitlementPolicyResponse[]> => {
  const { data } = await apiClient.get<EntitlementPolicyResponse[]>(
    '/entitlement-policies',
    { params: { leave_plan_id: leavePlanId } },
  );
  return data;
};

export const fetchEntitlementPolicy = async (
  id: string,
): Promise<EntitlementPolicyResponse> => {
  const { data } = await apiClient.get<EntitlementPolicyResponse>(
    `/entitlement-policies/${id}`,
  );
  return data;
};

export const createEntitlementPolicy = async (
  data: EntitlementPolicyCreate,
): Promise<EntitlementPolicyResponse> => {
  const { data: responseData } =
    await apiClient.post<EntitlementPolicyResponse>(
      '/entitlement-policies',
      data,
    );
  return responseData;
};

export const updateEntitlementPolicy = async (
  id: string,
  data: EntitlementPolicyUpdate,
): Promise<EntitlementPolicyResponse> => {
  const { data: responseData } =
    await apiClient.put<EntitlementPolicyResponse>(
      `/entitlement-policies/${id}`,
      data,
    );
  return responseData;
};

export const fetchEntitlements = async (
  employeeId: string,
): Promise<LeaveEntitlementResponse[]> => {
  const { data } = await apiClient.get<LeaveEntitlementResponse[]>(
    '/entitlements',
    { params: { employee_id: employeeId } },
  );
  return data;
};

export const createEntitlement = async (
  data: LeaveEntitlementCreate,
): Promise<LeaveEntitlementResponse> => {
  const { data: responseData } =
    await apiClient.post<LeaveEntitlementResponse>('/entitlements', data);
  return responseData;
};

export const fetchLedger = async (
  employeeId: string,
  leaveTypeId?: string,
): Promise<LedgerEntryResponse[]> => {
  const { data } = await apiClient.get<LedgerEntryResponse[]>(
    '/entitlements/ledger',
    {
      params: {
        employee_id: employeeId,
        ...(leaveTypeId !== undefined && { leave_type_id: leaveTypeId }),
      },
    },
  );
  return data;
};

export const createLedgerEntry = async (
  data: LedgerEntryCreate,
): Promise<LedgerEntryResponse> => {
  const { data: responseData } = await apiClient.post<LedgerEntryResponse>(
    '/entitlements/ledger',
    data,
  );
  return responseData;
};

export const fetchBalance = async (
  employeeId: string,
  leaveTypeId: string,
): Promise<LeaveBalanceResponse> => {
  const { data } = await apiClient.get<LeaveBalanceResponse>(
    '/entitlements/balance',
    { params: { employee_id: employeeId, leave_type_id: leaveTypeId } },
  );
  return data;
};
