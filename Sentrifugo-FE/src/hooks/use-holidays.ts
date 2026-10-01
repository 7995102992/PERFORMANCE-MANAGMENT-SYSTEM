import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchHolidayPlans,
  fetchHolidayPlan,
  createHolidayPlan,
  updateHolidayPlan,
  deleteHolidayPlan,
  fetchHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
} from '@/api/holiday-plans';
import type {
  HolidayPlanCreate,
  HolidayPlanUpdate,
  HolidayCreate,
  HolidayUpdate,
} from '@/types/leave';

export const holidayPlanKeys = {
  all: ['holiday-plans'] as const,
  list: (orgId: string, year?: number) =>
    [...holidayPlanKeys.all, 'list', orgId, ...(year != null ? [year] : [])] as const,
  detail: (id: string) => [...holidayPlanKeys.all, 'detail', id] as const,
};

export const holidayKeys = {
  all: ['holidays'] as const,
  list: (planId: string) => [...holidayKeys.all, 'list', planId] as const,
};

export const useHolidayPlans = (orgId: string, year?: number) =>
  useQuery({
    queryKey: holidayPlanKeys.list(orgId, year),
    queryFn: () => fetchHolidayPlans(orgId, year),
    enabled: !!orgId,
  });

export const useHolidayPlan = (id: string) =>
  useQuery({
    queryKey: holidayPlanKeys.detail(id),
    queryFn: () => fetchHolidayPlan(id),
    enabled: !!id,
  });

export const useCreateHolidayPlan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: HolidayPlanCreate) => createHolidayPlan(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: holidayPlanKeys.all });
    },
  });
};

export const useUpdateHolidayPlan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: HolidayPlanUpdate }) =>
      updateHolidayPlan(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: holidayPlanKeys.all });
    },
  });
};

export const useDeleteHolidayPlan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteHolidayPlan(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: holidayPlanKeys.all });
    },
  });
};

export const useHolidays = (planId: string) =>
  useQuery({
    queryKey: holidayKeys.list(planId),
    queryFn: () => fetchHolidays(planId),
    enabled: !!planId,
  });

export const useCreateHoliday = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: HolidayCreate) => createHoliday(data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: holidayKeys.list(variables.plan_id),
      });
    },
  });
};

export const useUpdateHoliday = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: HolidayUpdate }) =>
      updateHoliday(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: holidayKeys.all });
    },
  });
};

export const useDeleteHoliday = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteHoliday(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: holidayKeys.all });
    },
  });
};
