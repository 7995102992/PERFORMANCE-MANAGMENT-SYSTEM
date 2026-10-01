import React, { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/EmptyState";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Edit2,
  Trash2,
  Users,
  Clock,
  Info,
  UserCheck,
  UserX,
  AlertTriangle,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  useGetWorkCalendarQuery,
  useGetWorkCalendarsQuery,
  useCreateWorkCalendarMutation,
  useUpdateWorkCalendarMutation,
  useGetShiftsQuery,
  useGetShiftAssignmentsQuery,
  useCreateShiftMutation,
  useUpdateShiftMutation,
  useDeleteShiftMutation,
  useSyncWorkCalendarEmployeesMutation,
  useBulkAssignWorkCalendarEmployeesMutation,
  useLazyGetWorkCalendarDependenciesQuery,
  lmsApi,
} from "@/store/api/lmsApi";
import { useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useLazyGetEmployeesQuery,
} from "@/store/api/iamApi";
import type { EmployeeResponse } from "@/types/iam";
import type { ShiftResponse } from "@/types/leave";
import { PageLoader } from "@/components/shared/PageLoader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { AddEmployeesToCalendar } from "./AddEmployeesToCalendar";
import { AssignEmployeesToShifts } from "./AssignEmployeesToShifts";

const WEEK_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];
const WEEK_DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CURRENT_YEAR = new Date().getFullYear();

const DEFAULT_MATRIX: Record<string, number[]> = {
  "1": [1, 1, 1, 1, 1, 0, 0],
  "2": [1, 1, 1, 1, 1, 0, 0],
  "3": [1, 1, 1, 1, 1, 0, 0],
  "4": [1, 1, 1, 1, 1, 0, 0],
  "5": [1, 1, 1, 1, 1, 0, 0],
};

const dayLabel = (d: string) => d.charAt(0) + d.slice(1).toLowerCase();

function TimeInput({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  return (
    <Input
      id={id}
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full"
    />
  );
}

interface FormValues {
  calendarName: string;
  isActive: boolean;
  isDefault: boolean;
  businessUnitIds: string[];
  departmentIds: string[];
  weekStartDay: string;
  workWeekStart: string;
  workWeekEnd: string;
  allowHalfDay: boolean;
  weekendMatrix: Record<string, number[]>;
  yearType: "CALENDAR" | "FISCAL";
  startDate: string;
  endDate: string;
  statutoryEnabled: boolean;
  statutoryRuleType: string;
  statutoryDays: string[];
  assignmentMode: "auto" | "manual";
}

function validate(
  v: FormValues,
  depts: Array<{ id: string; businessUnits?: string[] }> = [],
  bus: Array<{ id: string; business_unit_name: string }> = [],
): Partial<Record<string, string>> {
  const errs: Partial<Record<string, string>> = {};
  if (!v.calendarName.trim()) errs.calendarName = "Calendar name is required";
  else if (v.calendarName.trim().length > 100)
    errs.calendarName = "Calendar name must be 100 characters or less";
  if (v.businessUnitIds.length === 0)
    errs.businessUnitIds = "Select at least one business unit";
  if (v.departmentIds.length === 0)
    errs.departmentIds = "Select at least one department";
  else if (v.businessUnitIds.length > 0) {
    // Every selected BU must have at least one selected department under it — a
    // BU with no department is a useless selection (mirrors the BE check).
    const coveredBus = new Set<string>();
    for (const deptId of v.departmentIds) {
      const dept = depts.find((d) => d.id === deptId);
      const buIds = dept?.businessUnits ?? [];
      buIds.forEach((buId) => coveredBus.add(buId));
    }
    const uncovered = v.businessUnitIds.filter((buId) => !coveredBus.has(buId));
    if (uncovered.length > 0) {
      const names = uncovered
        .map((id) => bus.find((b) => b.id === id)?.business_unit_name ?? id)
        .join(", ");
      errs.departmentIds = `Select at least one department for business unit(s): ${names}`;
    }
  }
  return errs;
}

interface Props {
  mode: "create" | "edit";
  wizardMode?: boolean;
  onCreated?: (calendarId: string) => void;
  embeddedCalendarId?: string;
  onClose?: () => void;
}

const WorkCalendarForm = ({
  mode,
  wizardMode = false,
  onCreated,
  embeddedCalendarId,
  onClose,
}: Props) => {
  const navigate = useNavigate();
  const routeParams = useParams({ strict: false }) as {
    calendarId?: string;
  };
  const calendarId = embeddedCalendarId ?? routeParams.calendarId;
  const confirm = useConfirm();
  const scrollToError = useScrollToError();

  const { data: existingCalendar } = useGetWorkCalendarQuery(calendarId ?? "", {
    skip: mode === "create" || !calendarId,
  });
  const [createWorkCalendar, createResult] = useCreateWorkCalendarMutation();
  const [updateWorkCalendar, updateResult] = useUpdateWorkCalendarMutation();
  const [syncEmployees] = useSyncWorkCalendarEmployeesMutation();
  const [bulkAssignEmployees] = useBulkAssignWorkCalendarEmployeesMutation();
  const [fetchEmployees] = useLazyGetEmployeesQuery();
  const [fetchDependencies] = useLazyGetWorkCalendarDependenciesQuery();
  const [isManagingEmployees, setIsManagingEmployees] = useState(false);
  const [isAssigningShifts, setIsAssigningShifts] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const { data: busData = [] } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptsData = [] } = useGetDepartmentsQuery({ is_active: true });

  const [initialized, setInitialized] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<string, boolean>>>({});
  const [isAssigning, setIsAssigning] = useState(false);

  const [values, setValues] = useState<FormValues>({
    calendarName: "",
    isActive: true,
    isDefault: false,
    businessUnitIds: [],
    departmentIds: [],
    weekStartDay: "MONDAY",
    workWeekStart: "MONDAY",
    workWeekEnd: "FRIDAY",
    allowHalfDay: false,
    weekendMatrix: JSON.parse(JSON.stringify(DEFAULT_MATRIX)),
    yearType: "CALENDAR",
    startDate: "01-01",
    endDate: "12-31",
    statutoryEnabled: false,
    statutoryRuleType: "FIXED",
    statutoryDays: [],
    assignmentMode: "auto",
  });

  const [currentCalendarId, setCurrentCalendarId] = useState<string | null>(
    calendarId ?? null,
  );
  const { data: shiftsData } = useGetShiftsQuery(currentCalendarId ?? "", {
    skip: !currentCalendarId,
  });

  const originalBuIds = useMemo<string[]>(() => {
    if (mode !== "edit" || !existingCalendar) return [];
    return (existingCalendar.business_units ?? []).map(
      (b: any) => b.id ?? b._id ?? b,
    );
  }, [mode, existingCalendar]);

  const originalDeptIds = useMemo<string[]>(() => {
    if (mode !== "edit" || !existingCalendar) return [];
    return (existingCalendar.departments ?? []).map(
      (d: any) => d.id ?? d._id ?? d,
    );
  }, [mode, existingCalendar]);

  const addedBuIds = useMemo(
    () => values.businessUnitIds.filter((id) => !originalBuIds.includes(id)),
    [values.businessUnitIds, originalBuIds],
  );

  const removedBuIds = useMemo(
    () => originalBuIds.filter((id) => !values.businessUnitIds.includes(id)),
    [values.businessUnitIds, originalBuIds],
  );

  const addedDeptIds = useMemo(
    () => values.departmentIds.filter((id) => !originalDeptIds.includes(id)),
    [values.departmentIds, originalDeptIds],
  );

  const removedDeptIds = useMemo(
    () => originalDeptIds.filter((id) => !values.departmentIds.includes(id)),
    [values.departmentIds, originalDeptIds],
  );

  // Depts originally tied to a removed BU but still selected because they're
  // also linked to a remaining BU. The cascading filter at the BU selector
  // keeps them silently; the save dialog surfaces them so the user can
  // explicitly drop them too if the BU removal was meant to clean up everything.
  const sharedDeptIds = useMemo(() => {
    if (mode !== "edit" || removedBuIds.length === 0) return [];
    return values.departmentIds.filter((deptId) => {
      if (!originalDeptIds.includes(deptId)) return false;
      const dept = deptsData.find((d) => d.id === deptId);
      return !!dept?.businessUnits?.some((buId) => removedBuIds.includes(buId));
    });
  }, [mode, removedBuIds, values.departmentIds, originalDeptIds, deptsData]);

  const [empDialogOpen, setEmpDialogOpen] = useState(false);
  const [empDialogChoice, setEmpDialogChoice] = useState<"auto" | "manual">(
    "auto",
  );
  // When a removed BU shares depts with a remaining BU, those depts stay by
  // default. This lets the user opt-in to dropping them too.
  const [dropSharedDepts, setDropSharedDepts] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [deactivationDeps, setDeactivationDeps] = useState<{
    employees: number;
    shifts: number;
  } | null>(null);

  const dispatch = useAppDispatch();
  const { data: allCalendars } = useGetWorkCalendarsQuery();
  const [autoAssignPreview, setAutoAssignPreview] = useState<{
    total: number;
    onOtherCal: number;
    willAssign: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (
      !empDialogOpen ||
      empDialogChoice !== "auto" ||
      addedDeptIds.length === 0
    ) {
      setAutoAssignPreview(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setPreviewLoading(true);
      try {
        const allEmps: EmployeeResponse[] = [];
        let skip = 0;
        while (true) {
          const batch = await fetchEmployees({
            department_ids: addedDeptIds,
            business_unit_ids: values.businessUnitIds,
            is_active: true,
            limit: 100,
            skip,
          }).unwrap();
          allEmps.push(...batch);
          if (batch.length < 100) break;
          skip += 100;
          if (skip >= 10000) break;
        }
        if (cancelled) return;
        const otherCals = (allCalendars ?? []).filter(
          (c) => c._id !== calendarId && c.status === "ACTIVE",
        );
        const otherCalUserIds = new Set<string>();
        const subs: { unsubscribe: () => void }[] = [];
        await Promise.all(
          otherCals.map(async (c) => {
            const sub = dispatch(
              lmsApi.endpoints.getWorkCalendarEmployees.initiate(c._id),
            );
            subs.push(sub);
            try {
              const entries = await sub.unwrap();
              entries.forEach((e) => otherCalUserIds.add(e.user_id));
            } catch {
              /* skip */
            }
          }),
        );
        subs.forEach((s) => s.unsubscribe());
        if (cancelled) return;
        const total = allEmps.length;
        const onOtherCal = allEmps.filter((e) =>
          otherCalUserIds.has(e.userId ?? e.user_id ?? e.id),
        ).length;
        setAutoAssignPreview({
          total,
          onOtherCal,
          willAssign: total - onOtherCal,
        });
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [empDialogOpen, empDialogChoice, addedDeptIds, values.businessUnitIds]);

  const isDeactivating =
    mode === "edit" &&
    initialized &&
    !values.isActive &&
    existingCalendar?.is_active === true;

  useEffect(() => {
    if (!isDeactivating || !calendarId) {
      setDeactivationDeps(null);
      return;
    }
    fetchDependencies(calendarId)
      .unwrap()
      .then((deps) => setDeactivationDeps(deps))
      .catch(() => setDeactivationDeps(null));
  }, [isDeactivating, calendarId]);

  // Sync breadcrumb for edit mode; clear on unmount
  useEffect(() => {
    if (mode !== "edit" || wizardMode) return;
    if (existingCalendar?.name)
      dispatch(setBreadcrumbDetail(existingCalendar.name));
  }, [existingCalendar?.name, mode, wizardMode, dispatch]);

  useEffect(() => {
    if (mode !== "edit" || wizardMode) return;
    return () => {
      dispatch(setBreadcrumbDetail(null));
    };
  }, [mode, wizardMode, dispatch]);

  // Prefill in edit mode
  useEffect(() => {
    if (mode !== "edit" || !existingCalendar || initialized) return;
    const buIds = (existingCalendar.business_units ?? []).map(
      (bu: any) => bu.id ?? bu._id ?? bu,
    ) as string[];
    const deptIds = (existingCalendar.departments ?? []).map(
      (d: any) => d.id ?? d._id ?? d,
    ) as string[];
    setValues({
      calendarName: existingCalendar.name ?? "",
      isActive: existingCalendar.is_active ?? true,
      isDefault: existingCalendar.is_default ?? false,
      businessUnitIds: buIds,
      departmentIds: deptIds,
      weekStartDay: existingCalendar.week_config?.week_start_day ?? "MONDAY",
      workWeekStart: existingCalendar.week_config?.work_week_start ?? "MONDAY",
      workWeekEnd: existingCalendar.week_config?.work_week_end ?? "FRIDAY",
      allowHalfDay: existingCalendar.week_config?.allow_half_day ?? false,
      weekendMatrix:
        existingCalendar.weekend_matrix ??
        JSON.parse(JSON.stringify(DEFAULT_MATRIX)),
      yearType: existingCalendar.year_type ?? "CALENDAR",
      startDate: (existingCalendar.start_date ?? "").replace(/^\d{4}-/, ""),
      endDate: (existingCalendar.end_date ?? "").replace(/^\d{4}-/, ""),
      statutoryEnabled: existingCalendar.statutory_config?.enabled ?? false,
      statutoryRuleType:
        existingCalendar.statutory_config?.rule_type ?? "FIXED",
      statutoryDays: existingCalendar.statutory_config?.statutory_days ?? [],
      assignmentMode: "auto",
    });
    setInitialized(true);
  }, [mode, existingCalendar, initialized]);

  // Auto-populate BU if single
  useEffect(() => {
    if (
      mode === "create" &&
      busData.length === 1 &&
      values.businessUnitIds.length === 0
    ) {
      setValues((v) => ({ ...v, businessUnitIds: [busData[0].id] }));
    }
  }, [busData, values.businessUnitIds.length, mode]);

  const isDirty =
    mode === "create"
      ? values.calendarName.trim() !== "" ||
        values.businessUnitIds.length > 0 ||
        values.departmentIds.length > 0
      : existingCalendar != null &&
        (() => {
          const cal = existingCalendar;
          const serverBuIds = (cal.business_units ?? [])
            .map((bu: any) => bu.id ?? bu._id ?? bu)
            .sort()
            .join();
          const serverDeptIds = (cal.departments ?? [])
            .map((d: any) => d.id ?? d._id ?? d)
            .sort()
            .join();
          const serverStartMD = (cal.start_date ?? "").replace(/^\d{4}-/, "");
          const serverEndMD = (cal.end_date ?? "").replace(/^\d{4}-/, "");
          return (
            values.calendarName !== (cal.name ?? "") ||
            values.isActive !== (cal.is_active ?? true) ||
            values.isDefault !== (cal.is_default ?? false) ||
            [...values.businessUnitIds].sort().join() !== serverBuIds ||
            [...values.departmentIds].sort().join() !== serverDeptIds ||
            values.weekStartDay !==
              (cal.week_config?.week_start_day ?? "MONDAY") ||
            values.workWeekStart !==
              (cal.week_config?.work_week_start ?? "MONDAY") ||
            values.workWeekEnd !==
              (cal.week_config?.work_week_end ?? "FRIDAY") ||
            values.allowHalfDay !==
              (cal.week_config?.allow_half_day ?? false) ||
            JSON.stringify(values.weekendMatrix) !==
              JSON.stringify(cal.weekend_matrix ?? DEFAULT_MATRIX) ||
            values.yearType !== (cal.year_type ?? "CALENDAR") ||
            values.startDate !== serverStartMD ||
            values.endDate !== serverEndMD ||
            values.statutoryEnabled !==
              (cal.statutory_config?.enabled ?? false) ||
            values.statutoryRuleType !==
              (cal.statutory_config?.rule_type ?? "FIXED") ||
            JSON.stringify([...values.statutoryDays].sort()) !==
              JSON.stringify(
                [...(cal.statutory_config?.statutory_days ?? [])].sort(),
              )
          );
        })();
  const releaseNavigationGuard = useNavigationGuard(isDirty);
  const errors = validate(values, deptsData, busData);
  const touch = (field: string) => setTouched((t) => ({ ...t, [field]: true }));
  const fieldError = (field: string) =>
    touched[field] ? errors[field] : undefined;
  const set = <K extends keyof FormValues>(field: K, val: FormValues[K]) =>
    setValues((v) => ({ ...v, [field]: val }));

  // Filter departments by selected BUs
  const filteredDepts = useMemo(
    () =>
      values.businessUnitIds.length > 0
        ? deptsData.filter((d) =>
            d.businessUnits?.some((buId) =>
              values.businessUnitIds.includes(buId),
            ),
          )
        : deptsData,
    [deptsData, values.businessUnitIds],
  );

  const buOptions = useMemo(
    () => busData.map((bu) => ({ label: bu.business_unit_name, value: bu.id })),
    [busData],
  );

  const deptOptions = useMemo(
    () => filteredDepts.map((d) => ({ label: deptLabel(d), value: d.id })),
    [filteredDepts],
  );

  // Auto-select when only one option is available (skip in edit mode until prefill completes)
  useEffect(() => {
    if (mode === "edit" && !initialized) return;
    if (buOptions.length === 1 && values.businessUnitIds.length === 0)
      setValues((v) => ({ ...v, businessUnitIds: [buOptions[0].value] }));
  }, [buOptions, values.businessUnitIds.length, mode, initialized]);

  useEffect(() => {
    if (mode === "edit" && !initialized) return;
    if (deptOptions.length === 1 && values.departmentIds.length === 0)
      setValues((v) => ({ ...v, departmentIds: [deptOptions[0].value] }));
  }, [deptOptions, values.departmentIds.length, mode, initialized]);

  // Compute which day indices fall within the work week
  const workWeekDayIndices = useMemo(() => {
    const startIdx = WEEK_DAYS.indexOf(values.workWeekStart);
    const endIdx = WEEK_DAYS.indexOf(values.workWeekEnd);
    if (startIdx === -1 || endIdx === -1) return new Set<number>();
    const indices = new Set<number>();
    if (startIdx <= endIdx) {
      for (let i = startIdx; i <= endIdx; i++) indices.add(i);
    } else {
      for (let i = startIdx; i < 7; i++) indices.add(i);
      for (let i = 0; i <= endIdx; i++) indices.add(i);
    }
    return indices;
  }, [values.workWeekStart, values.workWeekEnd]);

  const isWorkDay = (dayIdx: number) => workWeekDayIndices.has(dayIdx);

  // When work week boundaries change, set non-work days to Off and reset newly-added work days to Full Day
  useEffect(() => {
    setValues((prev) => {
      const newMatrix = { ...prev.weekendMatrix };
      for (const week of Object.keys(newMatrix)) {
        newMatrix[week] = newMatrix[week].map((val, idx) =>
          isWorkDay(idx) ? (val === 0 ? 1 : val) : 0,
        );
      }
      return { ...prev, weekendMatrix: newMatrix };
    });
  }, [workWeekDayIndices]);

  // Keep weekStartDay in sync with workWeekStart
  useEffect(() => {
    set("weekStartDay", values.workWeekStart);
  }, [values.workWeekStart]);

  // When half-day is toggled off, clean up dropdown values (2, 3) back to Full Day (0)
  useEffect(() => {
    if (!values.allowHalfDay) {
      setValues((prev) => {
        const newMatrix = { ...prev.weekendMatrix };
        for (const week of Object.keys(newMatrix)) {
          newMatrix[week] = newMatrix[week].map((val, idx) =>
            isWorkDay(idx) ? (val > 1 ? 1 : val) : 0,
          );
        }
        return { ...prev, weekendMatrix: newMatrix };
      });
    }
  }, [values.allowHalfDay]);

  const toggleWeekendDay = (week: string, dayIdx: number) => {
    setValues((prev) => {
      const current = prev.weekendMatrix[week]?.[dayIdx] ?? 1;
      const next = prev.allowHalfDay
        ? current === 1
          ? 2
          : current === 2
            ? 0
            : 1
        : current === 1
          ? 0
          : 1;
      return {
        ...prev,
        weekendMatrix: {
          ...prev.weekendMatrix,
          [week]: prev.weekendMatrix[week].map((val, i) =>
            i === dayIdx ? next : val,
          ),
        },
      };
    });
  };

  const setColumnValue = (dayIdx: number, val: number) => {
    setValues((prev) => {
      const newMatrix = { ...prev.weekendMatrix };
      for (const week of Object.keys(newMatrix)) {
        newMatrix[week] = newMatrix[week].map((v, i) =>
          i === dayIdx ? val : v,
        );
      }
      return { ...prev, weekendMatrix: newMatrix };
    });
  };

  const setWeekendDayValue = (week: string, dayIdx: number, val: number) => {
    setValues((prev) => ({
      ...prev,
      weekendMatrix: {
        ...prev.weekendMatrix,
        [week]: prev.weekendMatrix[week].map((v, i) =>
          i === dayIdx ? val : v,
        ),
      },
    }));
  };

  const toggleStatutoryDay = (day: string) => {
    setValues((prev) => ({
      ...prev,
      statutoryDays: prev.statutoryDays.includes(day)
        ? prev.statutoryDays.filter((d) => d !== day)
        : [...prev.statutoryDays, day],
    }));
  };

  // Auto-set dates when year type changes (month-day only, no year lock)
  const handleYearTypeChange = (type: "CALENDAR" | "FISCAL") => {
    if (type === "CALENDAR") {
      setValues((v) => ({
        ...v,
        yearType: type,
        startDate: "01-01",
        endDate: "12-31",
      }));
    } else {
      setValues((v) => ({
        ...v,
        yearType: type,
        startDate: "04-01",
        endDate: "03-31",
      }));
    }
  };

  // Mirrors the holiday-plan auto-assign flow (which is confirmed working):
  // fetch employees client-side by BU + dept, then call bulk-assign by user IDs.
  // The /assign-by-departments endpoint returns added=0 in cases where employees
  // do exist, so we route around it.
  const autoAssignEmployees = async (
    calendarId: string,
    deptIds: string[],
  ): Promise<{ added: number; total: number }> => {
    if (deptIds.length === 0) return { added: 0, total: 0 };
    const allEmployees: EmployeeResponse[] = [];
    let skip = 0;
    const PAGE = 100;
    const MAX_PAGES = 100; // 10,000 employees ceiling
    let pages = 0;
    while (true) {
      if (pages >= MAX_PAGES) {
        console.warn("autoAssignEmployees: page ceiling hit", { pages, skip });
        break;
      }
      // Scope is BU + dept: an employee is eligible only if they're in one of
      // these departments AND one of the calendar's business units. This matters
      // for departments shared across BUs — we must not pull the other BU's
      // employees in via a shared department.
      const batch = await fetchEmployees({
        department_ids: deptIds,
        business_unit_ids: values.businessUnitIds,
        is_active: true,
        limit: PAGE,
        skip,
      }).unwrap();
      allEmployees.push(...batch);
      if (batch.length < PAGE) break;
      skip += PAGE;
      pages += 1;
    }
    const userIds = allEmployees
      .map((e) => e.userId ?? e.user_id ?? e.id)
      .filter(Boolean) as string[];
    if (userIds.length === 0) return { added: 0, total: 0 };
    const r = await bulkAssignEmployees({
      calendarId,
      user_ids: userIds,
    }).unwrap();
    return { added: r.added ?? 0, total: r.total ?? userIds.length };
  };

  const runEditSave = async (choice: "auto" | "manual"): Promise<boolean> => {
    setDialogBusy(true);
    if (isDeactivating && calendarId) {
      try {
        const deps = await fetchDependencies(calendarId).unwrap();
        setDeactivationDeps(deps);
        if (deps.employees > 0 || deps.shifts > 0) {
          const parts: string[] = [];
          if (deps.employees > 0)
            parts.push(
              `${deps.employees} employee${deps.employees !== 1 ? "s" : ""}`,
            );
          if (deps.shifts > 0)
            parts.push(`${deps.shifts} shift${deps.shifts !== 1 ? "s" : ""}`);
          toast.error(
            `Cannot deactivate — ${parts.join(" and ")} still assigned.`,
          );
          setDialogBusy(false);
          return false;
        }
      } catch {
        /* proceed if check fails */
      }
    }
    // When the user opts to drop shared depts (depts that survived a BU
    // removal because they're also linked to a remaining BU), strip them
    // from the save payload AND treat them as removed for downstream sync.
    const willDropShared = dropSharedDepts && sharedDeptIds.length > 0;
    const effectiveDeptIds = willDropShared
      ? values.departmentIds.filter((id) => !sharedDeptIds.includes(id))
      : values.departmentIds;
    const effectiveRemovedDeptIds = willDropShared
      ? [...removedDeptIds, ...sharedDeptIds]
      : removedDeptIds;

    try {
      await updateWorkCalendar({
        id: calendarId ?? "",
        body: { ...buildPayload(), department_ids: effectiveDeptIds },
      }).unwrap();
    } catch (err) {
      toast.error(err, "Failed to update work calendar");
      setDialogBusy(false);
      return false;
    }
    toast.success("Work calendar updated");

    const hasRemovedDepts = effectiveRemovedDeptIds.length > 0;
    const hasRemovedBus = removedBuIds.length > 0;
    const hasAddedDepts = addedDeptIds.length > 0;

    setIsProcessing(true);
    try {
      // Step 1: Sync removals. The desired set = employees in the remaining
      // departments AND the remaining business units. Removing a BU now
      // unassigns that BU's employees even when a department is shared with a
      // BU that stays — BU + dept together define scope, so the other BU's
      // employees never linger via a shared department.
      if (hasRemovedDepts || hasRemovedBus) {
        const deptsForSync = effectiveDeptIds.filter(
          (id) => !addedDeptIds.includes(id),
        );
        const remainingEmployees: EmployeeResponse[] = [];
        if (deptsForSync.length > 0) {
          let skip = 0;
          const PAGE = 100;
          while (true) {
            const batch = await fetchEmployees({
              department_ids: deptsForSync,
              business_unit_ids: values.businessUnitIds,
              is_active: true,
              limit: PAGE,
              skip,
            }).unwrap();
            remainingEmployees.push(...batch);
            if (batch.length < PAGE) break;
            skip += PAGE;
            if (skip >= 10000) break;
          }
        }
        const remainingUserIds = remainingEmployees
          .map((e) => e.userId ?? e.user_id ?? e.id)
          .filter(Boolean) as string[];
        const r = await syncEmployees({
          calendarId: calendarId ?? "",
          body: { user_ids: remainingUserIds },
        }).unwrap();
        const removed = r.removed ?? 0;
        if (removed > 0) {
          toast.success(
            `${removed} employee${removed !== 1 ? "s" : ""} unlinked from removed department${removed !== 1 ? "s" : ""}`,
          );
        }
      }

      // Step 2: Auto-assign employees from newly added depts
      if (hasAddedDepts && choice === "auto") {
        const { added, total } = await autoAssignEmployees(
          calendarId ?? "",
          addedDeptIds,
        );
        const skipped = total - added;
        if (total === 0) {
          toast.success(
            "No active employees in the new department(s) — assign manually via Manage Employees",
          );
        } else if (added === total) {
          toast.success(
            `${added} employee${added !== 1 ? "s" : ""} assigned to calendar`,
          );
        } else if (added > 0) {
          toast.success(
            `${added} employee${added !== 1 ? "s" : ""} assigned, ${skipped} skipped (already on another calendar)`,
          );
        } else {
          toast.success(
            `${skipped} employee${skipped !== 1 ? "s" : ""} skipped — already assigned to another calendar`,
          );
        }
      } else if (hasAddedDepts && choice === "manual") {
        toast.success(
          "New departments added — assign employees via Manage Employees",
        );
      }
    } catch (err) {
      toast.error(
        err,
        "Calendar saved but employee sync failed — re-sync from Manage Employees",
      );
    } finally {
      setIsProcessing(false);
    }

    // Wizard intercepts edit-mode navigation too so the user stays in the
    // wizard flow after editing step 1 details. Release the form's own nav
    // guard FIRST so it doesn't block the hand-off with a "Discard changes?".
    releaseNavigationGuard();
    if (wizardMode && onCreated && calendarId) {
      // Release this form's own guard before handing back to the wizard —
      // the wizard owns the guard for the rest of the flow. Without this the
      // form's still-armed blocker fires a spurious "Discard / Stay" dialog
      // when the wizard advances to the next step.
      releaseNavigationGuard();
      onCreated(calendarId);
      return true;
    }

    releaseNavigationGuard();
    onClose ? onClose() : navigate({ to: "/leave-management/work-calendar" });
    return true;
  };

  const buildPayload = () => {
    // For fiscal year the end month-day is before the start (e.g. 03-31 < 04-01),
    // so end_date belongs to the following calendar year. Use real m/d comparison
    // so edits like 12-01 -> 11-30 (Dec→Nov wrap) work correctly.
    const [sm, sd] = values.startDate.split("-").map(Number);
    const [em, ed] = values.endDate.split("-").map(Number);
    const isFiscalWrap = em < sm || (em === sm && ed < sd);
    const endYear = isFiscalWrap ? CURRENT_YEAR + 1 : CURRENT_YEAR;
    return {
      name: values.calendarName,
      year_type: values.yearType,
      start_date: `${CURRENT_YEAR}-${values.startDate}`,
      end_date: `${endYear}-${values.endDate}`,
      is_active: values.isActive,
      is_default: values.isDefault,
      business_unit_ids: values.businessUnitIds,
      department_ids: values.departmentIds,
      week_config: {
        week_start_day: values.weekStartDay,
        work_week_start: values.workWeekStart,
        work_week_end: values.workWeekEnd,
        allow_half_day: values.allowHalfDay,
      },
      weekend_matrix: values.weekendMatrix,
      // Always send statutory_config so toggling Off clears the stored field on the BE.
      statutory_config: values.statutoryEnabled
        ? {
            enabled: true,
            rule_type: values.statutoryRuleType,
            statutory_days: values.statutoryDays,
          }
        : null,
    };
  };

  // Runs the create + department auto-assignment AFTER the confirm dialog has
  // closed, so the full-page "Assigning employees…" loader is fully visible and
  // never covered by a "Please wait…" modal sitting on top of it. Releases the
  // form's own navigation guard before the wizard hand-off so it can't fire a
  // stray "Discard changes?" prompt on the programmatic navigation.
  const runCreateAndAutoAssign = async (departmentIds: string[]) => {
    setIsAssigning(true);
    let newId = "";
    try {
      const res = await createWorkCalendar(buildPayload()).unwrap();
      newId = res?._id ?? "";
      if (newId) setCurrentCalendarId(newId);
    } catch (err) {
      setIsAssigning(false);
      toast.error(err, "Failed to create work calendar");
      return;
    }
    if (!newId) {
      setIsAssigning(false);
      toast.error("Failed to create work calendar");
      return;
    }
    try {
      const { added, total } = await autoAssignEmployees(newId, departmentIds);
      if (total === 0) {
        toast.success(
          "Work calendar created — no active employees in the selected departments",
        );
      } else if (added === total) {
        toast.success(
          `Work calendar created — ${added} employee${added !== 1 ? "s" : ""} assigned`,
        );
      } else if (added > 0) {
        toast.success(
          `Work calendar created — ${added} of ${total} assigned (rest already on another calendar)`,
        );
      } else {
        toast.success(
          `Work calendar created — all ${total} matching employee${total !== 1 ? "s are" : " is"} already on another calendar`,
        );
      }
    } catch (err) {
      const msg =
        (err as any)?.data?.detail || (err as any)?.message || "Unknown error";
      toast.error(`Employee auto-assignment failed: ${msg}`);
      toast.success(
        "Work calendar was created. Assign employees manually via Manage Employees.",
      );
    }
    // Advance once assignment settles. Keep the loader up through the wizard
    // hand-off (onCreated unmounts this form) so there's no flash of the form.
    releaseNavigationGuard();
    if (wizardMode && onCreated) {
      onCreated(newId);
      return;
    }
    setIsAssigning(false);
    navigate({ to: "/leave-management/work-calendar" });
  };

  const handleSave = async () => {
    setTouched({
      calendarName: true,
      businessUnitIds: true,
      departmentIds: true,
    });
    if (Object.keys(errors).length > 0) {
      toast.error("Please fill all required fields");
      requestAnimationFrame(() => scrollToError());
      return;
    }
    const action = mode === "create" ? "Create" : "Update";

    if (isDeactivating && calendarId) {
      let deps = deactivationDeps;
      if (deps == null) {
        try {
          deps = await fetchDependencies(calendarId).unwrap();
          setDeactivationDeps(deps);
        } catch {
          /* proceed if check fails */
        }
      }
      if (deps != null && (deps.employees > 0 || deps.shifts > 0)) {
        const parts: string[] = [];
        if (deps.employees > 0)
          parts.push(
            `${deps.employees} employee${deps.employees !== 1 ? "s" : ""}`,
          );
        if (deps.shifts > 0)
          parts.push(`${deps.shifts} shift${deps.shifts !== 1 ? "s" : ""}`);
        toast.error(
          `Cannot deactivate — ${parts.join(" and ")} still assigned. Unassign all employees and remove shifts before deactivating.`,
        );
        return;
      }
    }

    if (
      mode === "edit" &&
      (removedDeptIds.length > 0 ||
        addedDeptIds.length > 0 ||
        removedBuIds.length > 0 ||
        addedBuIds.length > 0)
    ) {
      setEmpDialogChoice("auto");
      setDropSharedDepts(false);
      setEmpDialogOpen(true);
      return;
    }

    confirm({
      title: `${action} Work Calendar?`,
      description: isDeactivating
        ? `Are you sure you want to deactivate "${values.calendarName.trim()}"? Employees will no longer use this calendar.`
        : `Are you sure you want to ${action.toLowerCase()} "${values.calendarName.trim()}"?`,
      ...(isDeactivating ? { variant: "destructive" as const } : {}),
      confirmText: action,
      onConfirm: async () => {
        // Auto-assign create: close THIS confirm dialog immediately (return
        // before any await) and run the create + slow auto-assignment behind
        // the page loader, so the modal never sits on top of the loader.
        // Fire-and-forget — runCreateAndAutoAssign owns its own error handling.
        if (
          mode === "create" &&
          values.assignmentMode === "auto" &&
          values.departmentIds.length > 0
        ) {
          void runCreateAndAutoAssign(values.departmentIds);
          return;
        }
        // Hoisted so the wizard-advance check at the end can read the id we
        // got back from createWorkCalendar (state from setCurrentCalendarId
        // isn't readable in the same closure — it only lands after a re-render).
        let createdId = "";
        try {
          if (mode === "create") {
            const res = await createWorkCalendar(buildPayload()).unwrap();
            const newId = res?._id;
            if (newId) {
              createdId = newId;
              setCurrentCalendarId(newId);
            }
            toast.success(
              values.assignmentMode === "manual"
                ? "Work calendar created — assign employees via Manage Employees"
                : "Work calendar created",
            );
          } else {
            await updateWorkCalendar({
              id: calendarId!,
              body: buildPayload(),
            }).unwrap();
            toast.success("Work calendar updated");
          }
          // Wizard intercepts the post-save navigation so it can advance to step 2.
          // For create: the new id came from the POST response.
          // For edit: the id is the calendar we just updated (from URL params).
          // Release the form's own nav guard FIRST so it doesn't block the
          // wizard's hand-off navigation with a stray "Discard changes?".
          releaseNavigationGuard();
          if (wizardMode && onCreated) {
            const id = mode === "create" ? createdId : (calendarId ?? "");
            if (id) {
              onCreated(id);
              return;
            }
          }
          releaseNavigationGuard();
          onClose
            ? onClose()
            : navigate({ to: "/leave-management/work-calendar" });
        } catch (err) {
          toast.error(
            err,
            `Failed to ${mode === "create" ? "create" : "update"} work calendar`,
          );
        }
      },
    });
  };

  const handleCancel = () => {
    if (isDirty) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to leave?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: () => {
          releaseNavigationGuard();
          onClose
            ? onClose()
            : navigate({ to: "/leave-management/work-calendar" });
        },
      });
    } else {
      onClose ? onClose() : navigate({ to: "/leave-management/work-calendar" });
    }
  };

  const isSaving = createResult.isLoading || updateResult.isLoading;

  if (isAssigning) {
    return <FullScreenLoader message="Assigning employees to calendar…" />;
  }

  if (isProcessing) {
    return <FullScreenLoader message="Updating employee assignments…" />;
  }

  if (isManagingEmployees && currentCalendarId && existingCalendar) {
    return (
      <AddEmployeesToCalendar
        calendarData={existingCalendar}
        onClose={() => setIsManagingEmployees(false)}
      />
    );
  }

  if (isAssigningShifts && currentCalendarId && existingCalendar) {
    return (
      <AssignEmployeesToShifts
        calendarData={existingCalendar}
        onClose={() => setIsAssigningShifts(false)}
      />
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={mode === "edit" ? "Edit Work Calendar" : "Add Work Calendar"}
        subtitle="Configure working days, shifts, and statutory rules."
        action={
          mode === "edit" && currentCalendarId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsManagingEmployees(true)}
              disabled={!values.isActive}
              title={
                !values.isActive
                  ? "Activate this calendar to manage employees"
                  : undefined
              }
            >
              <Users /> Manage Employees
            </Button>
          ) : undefined
        }
      />

      {mode === "edit" && !values.isActive && initialized && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-badge-pending-bg px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <p className="text-sm text-foreground">
            This work calendar is inactive. Employee management and shift
            assignments are disabled.
          </p>
        </div>
      )}

      {/* 1. Basic Info */}
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Basic Info</h3>
            <p className="text-sm text-muted-foreground">
              Name and visibility settings.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Field data-invalid={!!fieldError("calendarName")}>
              <FieldLabel>
                Calendar Name <span className="text-destructive">*</span>
              </FieldLabel>
              <Input
                value={values.calendarName}
                onChange={(e) => set("calendarName", e.target.value)}
                onBlur={() => touch("calendarName")}
                placeholder="e.g. Standard 5-Day Calendar 2025"
                aria-invalid={!!fieldError("calendarName")}
              />
              {fieldError("calendarName") && (
                <FieldError
                  errors={[{ message: fieldError("calendarName") }]}
                />
              )}
            </Field>
            <div className="space-y-2 pb-1">
              <div className="flex gap-8 items-end">
                {mode === "edit" && (
                  <div className="flex items-center gap-3">
                    <Label className="text-sm font-medium">Active</Label>
                    <Switch
                      checked={values.isActive}
                      onCheckedChange={(v) => set("isActive", v)}
                    />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <Label className="text-sm font-medium">Default</Label>
                  <Switch
                    checked={values.isDefault}
                    onCheckedChange={(v) => set("isDefault", v)}
                  />
                </div>
              </div>
              {isDeactivating &&
                deactivationDeps != null &&
                (deactivationDeps.employees > 0 ||
                  deactivationDeps.shifts > 0) && (
                  <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
                    <p className="text-xs text-destructive">
                      {deactivationDeps.employees > 0 && (
                        <>
                          {deactivationDeps.employees} employee
                          {deactivationDeps.employees !== 1
                            ? "s are"
                            : " is"}{" "}
                          currently assigned.{" "}
                        </>
                      )}
                      {deactivationDeps.shifts > 0 && (
                        <>
                          {deactivationDeps.shifts} shift
                          {deactivationDeps.shifts !== 1 ? "s are" : " is"}{" "}
                          configured.{" "}
                        </>
                      )}
                      Unassign all employees and remove shifts before
                      deactivating.
                    </p>
                  </div>
                )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. Assignment — BU + Departments */}
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Assignment</h3>
            <p className="text-sm text-muted-foreground">
              Select which business units and departments this calendar applies
              to.
            </p>
          </div>
          <Field data-invalid={!!fieldError("businessUnitIds")}>
            <div className="flex items-center justify-between">
              <FieldLabel>
                Business Units <span className="text-destructive">*</span>
              </FieldLabel>
              {buOptions.length > 1 && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => {
                    const allBuIds = buOptions.map((o) => o.value);
                    const allSelected =
                      allBuIds.length > 0 &&
                      allBuIds.every((id) =>
                        values.businessUnitIds.includes(id),
                      );
                    if (allSelected) {
                      setValues((v) => ({
                        ...v,
                        businessUnitIds: [],
                        departmentIds: [],
                      }));
                    } else {
                      const validDeptIds = deptsData
                        .filter((d) =>
                          d.businessUnits?.some((buId) =>
                            allBuIds.includes(buId),
                          ),
                        )
                        .map((d) => d.id);
                      setValues((v) => ({
                        ...v,
                        businessUnitIds: allBuIds,
                        departmentIds: v.departmentIds.filter((id) =>
                          validDeptIds.includes(id),
                        ),
                      }));
                    }
                    touch("businessUnitIds");
                  }}
                >
                  {buOptions.length > 0 &&
                  buOptions.every((o) =>
                    values.businessUnitIds.includes(o.value),
                  )
                    ? "Clear all"
                    : "Select all"}
                </button>
              )}
            </div>
            <SearchableSelect
              multi
              options={buOptions}
              value={values.businessUnitIds}
              onChange={(vals) => {
                const buIds: string[] = vals as string[];
                const validDeptIds = deptsData
                  .filter((d) =>
                    d.businessUnits?.some((buId) => buIds.includes(buId)),
                  )
                  .map((d) => d.id);
                setValues((v) => ({
                  ...v,
                  businessUnitIds: buIds,
                  departmentIds: v.departmentIds.filter((id) =>
                    validDeptIds.includes(id),
                  ),
                }));
                touch("businessUnitIds");
              }}
              placeholder="Select business units…"
            />
            {fieldError("businessUnitIds") && (
              <FieldError
                errors={[{ message: fieldError("businessUnitIds") }]}
              />
            )}
          </Field>
          <Field data-invalid={!!fieldError("departmentIds")}>
            <div className="flex items-center justify-between">
              <FieldLabel>
                Departments <span className="text-destructive">*</span>
              </FieldLabel>
              {deptOptions.length > 1 && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => {
                    const allDeptIds = deptOptions.map((o) => o.value);
                    const allSelected =
                      allDeptIds.length > 0 &&
                      allDeptIds.every((id) =>
                        values.departmentIds.includes(id),
                      );
                    setValues((v) => ({
                      ...v,
                      departmentIds: allSelected ? [] : allDeptIds,
                    }));
                    touch("departmentIds");
                  }}
                >
                  {deptOptions.length > 0 &&
                  deptOptions.every((o) =>
                    values.departmentIds.includes(o.value),
                  )
                    ? "Clear all"
                    : "Select all"}
                </button>
              )}
            </div>
            <SearchableSelect
              multi
              options={deptOptions}
              value={values.departmentIds}
              onChange={(vals) => {
                const deptIds: string[] = vals as string[];
                setValues((v) => ({ ...v, departmentIds: deptIds }));
                touch("departmentIds");
              }}
              placeholder={
                values.businessUnitIds.length === 0
                  ? "Select a business unit first…"
                  : "Select departments…"
              }
              disabled={values.businessUnitIds.length === 0}
            />
            {fieldError("departmentIds") && (
              <FieldError errors={[{ message: fieldError("departmentIds") }]} />
            )}
          </Field>

          {mode === "edit" && removedDeptIds.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-badge-pending-bg px-4 py-3">
              <UserX className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="text-sm text-foreground">
                <p className="font-medium">Departments removed</p>
                <p className="mt-0.5 text-xs">
                  Employees in the removed departments will be unassigned from
                  this work calendar (regardless of which business unit they
                  belong to) and their shift assignments will be cleared.
                </p>
              </div>
            </div>
          )}

          {/* Shared depts kept after BU removal — show inline with the OTHER BUs
              they're linked to, plus a per-dept Remove so the user can decide
              one-by-one instead of guessing. */}
          {mode === "edit" && sharedDeptIds.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 space-y-2">
              <p className="text-sm font-medium text-foreground">
                {sharedDeptIds.length} department
                {sharedDeptIds.length > 1 ? "s were" : " was"} kept because{" "}
                {sharedDeptIds.length > 1 ? "they're" : "it's"} also linked to a
                business unit you didn't remove
              </p>
              <p className="text-xs text-muted-foreground">
                Review each one — keep it if you still want it, or remove it
                from this calendar.
              </p>
              <ul className="space-y-1.5 pt-1">
                {sharedDeptIds.map((deptId) => {
                  const dept = deptsData.find((d) => d.id === deptId);
                  if (!dept) return null;
                  const otherBuNames = (dept.businessUnits ?? [])
                    .filter((buId) => values.businessUnitIds.includes(buId))
                    .map(
                      (buId) =>
                        busData.find((b) => b.id === buId)?.business_unit_name,
                    )
                    .filter(Boolean) as string[];
                  return (
                    <li
                      key={deptId}
                      className="flex items-start justify-between gap-3 rounded-md border border-warning/20 bg-card p-2.5"
                    >
                      <div className="text-xs">
                        <p className="font-medium text-foreground">
                          {deptLabel(dept)}
                        </p>
                        <p className="text-muted-foreground mt-0.5">
                          Kept on this calendar because it's also part of:{" "}
                          <span className="font-medium text-foreground">
                            {otherBuNames.join(", ") || "—"}
                          </span>
                        </p>
                      </div>
                      <button
                        type="button"
                        className="text-xs font-medium text-destructive hover:underline shrink-0 mt-0.5"
                        onClick={() => {
                          setValues((v) => ({
                            ...v,
                            departmentIds: v.departmentIds.filter(
                              (id) => id !== deptId,
                            ),
                          }));
                          touch("departmentIds");
                        }}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {mode === "create" && values.departmentIds.length > 0 && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Employee Assignment</span>
              </div>
              <RadioGroup
                value={values.assignmentMode}
                onValueChange={(v) =>
                  setValues((prev) => ({
                    ...prev,
                    assignmentMode: v as "auto" | "manual",
                  }))
                }
                className="space-y-2"
              >
                <label
                  htmlFor="wc-assign-auto"
                  className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem
                    value="auto"
                    id="wc-assign-auto"
                    className="mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <UserCheck className="size-3.5" />
                      Auto assign all employees
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      All active employees under the selected departments will
                      be assigned immediately. You can manage them later.
                    </p>
                  </div>
                </label>
                <label
                  htmlFor="wc-assign-manual"
                  className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem
                    value="manual"
                    id="wc-assign-manual"
                    className="mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <UserX className="size-3.5" />
                      Skip — I'll add employees later
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      No employees will be assigned now. Use{" "}
                      <strong>Manage Employees</strong> after creation.
                    </p>
                  </div>
                </label>
              </RadioGroup>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Week Definition */}
      <Card>
        <CardContent className="space-y-6 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Week Definition</h3>
            <p className="text-sm text-muted-foreground">
              Configure week boundaries.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {[
              { label: "Work Week Starts On", key: "workWeekStart" as const },
              { label: "Work Week Ends On", key: "workWeekEnd" as const },
            ].map((field) => (
              <Field key={field.label}>
                <FieldLabel>{field.label}</FieldLabel>
                <SearchableSelect
                  options={WEEK_DAYS.map((d) => ({
                    label: dayLabel(d),
                    value: d,
                  }))}
                  value={values[field.key]}
                  onChange={(v) => set(field.key, v as string)}
                  placeholder={field.label}
                  searchable={false}
                />
              </Field>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 4. Define Workweek — Half-day toggle + Matrix */}
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Define Workweek</h3>
            <p className="text-sm text-muted-foreground">
              Configure weekends and half working days.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-3">
            <span className="text-sm font-medium">Allow Half Working Day</span>
            <Switch
              checked={values.allowHalfDay}
              onCheckedChange={(v) => set("allowHalfDay", v)}
            />
          </div>

          <WeekendMatrix
            matrix={values.weekendMatrix}
            allowHalfDay={values.allowHalfDay}
            workDayIndices={workWeekDayIndices}
            onToggle={toggleWeekendDay}
            onSetValue={setWeekendDayValue}
            onSetColumn={setColumnValue}
          />
          {!values.allowHalfDay && (
            <p className="text-xs text-muted-foreground">
              Uncheck the days that are{" "}
              <span className="font-semibold">off / weekend</span> for each
              week.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 5. Calendar Year Definition */}
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">
              Calendar Year Definition
            </h3>
            <p className="text-sm text-muted-foreground">
              Select whether this calendar follows a fiscal or calendar year.
            </p>
          </div>
          <RadioGroup
            value={values.yearType}
            onValueChange={(v) =>
              handleYearTypeChange(v as "CALENDAR" | "FISCAL")
            }
            className="flex gap-6"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="CALENDAR" id="year-calendar" />
              <Label htmlFor="year-calendar" className="cursor-pointer">
                Calendar Year (Jan – Dec)
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="FISCAL" id="year-fiscal" />
              <Label htmlFor="year-fiscal" className="cursor-pointer">
                Fiscal Year (Apr – Mar)
              </Label>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      {/* 7. Shift Management — hidden in wizard mode (step 3 handles it). */}
      {wizardMode ? null : mode === "create" ? (
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-sm text-primary">
            <strong>Employee Management</strong> and{" "}
            <strong>Shift Management</strong> will be available after the
            calendar is created. You can configure them by editing the calendar.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-5 pt-2">
            <div className="flex items-center justify-between border-b pb-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold">Shift Management</h3>
                <p className="text-sm text-muted-foreground">
                  Configure work shifts for this calendar.
                </p>
              </div>
              {currentCalendarId && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIsAssigningShifts(true)}
                    disabled={!values.isActive}
                    title={
                      !values.isActive
                        ? "Activate this calendar to assign shifts"
                        : undefined
                    }
                  >
                    <Users /> Assign to Shifts
                  </Button>
                  {values.isActive && (
                    <ShiftAddButton calendarId={currentCalendarId} />
                  )}
                </div>
              )}
            </div>
            {currentCalendarId && <ShiftList calendarId={currentCalendarId} />}
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-2">
        <Button variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
        <Button variant="soft" onClick={handleSave} disabled={isSaving}>
          {isSaving
            ? "Saving…"
            : mode === "edit"
              ? "Update Calendar"
              : wizardMode
                ? "Save & Continue"
                : "Save Calendar"}
        </Button>
      </div>

      <Dialog
        open={empDialogOpen}
        onOpenChange={(open) => !dialogBusy && setEmpDialogOpen(open)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm assignment changes</DialogTitle>
            <DialogDescription>
              You've changed the business units or departments. Confirm how
              employee assignments should be updated.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {(removedBuIds.length > 0 || removedDeptIds.length > 0) && (
              <div className="rounded-xl border border-warning/30 bg-badge-pending-bg px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-3">
                  <UserX className="mt-0.5 size-4 shrink-0 text-warning" />
                  <p className="text-sm font-medium text-foreground">
                    {removedBuIds.length > 0 &&
                      `${removedBuIds.length} business unit${removedBuIds.length > 1 ? "s" : ""}`}
                    {removedBuIds.length > 0 &&
                      removedDeptIds.length > 0 &&
                      " and "}
                    {removedDeptIds.length > 0 &&
                      `${removedDeptIds.length} department${removedDeptIds.length > 1 ? "s" : ""}`}
                    {" removed — the following will happen automatically:"}
                  </p>
                </div>
                {removedDeptIds.length > 0 ? (
                  <ul className="text-xs text-foreground space-y-0.5 pl-7 list-disc">
                    <li>
                      Employees in the removed department
                      {removedDeptIds.length > 1 ? "s" : ""} will be unassigned
                      — regardless of which business unit they belong to.
                    </li>
                    <li>
                      Their shift assignments on this calendar will be cleared.
                    </li>
                    <li>
                      Employees in shared departments that stayed are NOT
                      affected, even if their business unit was removed.
                    </li>
                  </ul>
                ) : (
                  <ul className="text-xs text-foreground space-y-0.5 pl-7 list-disc">
                    <li>
                      No employees will be unassigned — every department this BU
                      contributed is shared with a business unit you kept.
                    </li>
                  </ul>
                )}
              </div>
            )}
            {sharedDeptIds.length > 0 && (
              <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="text-sm">
                    <p className="font-medium text-foreground">
                      {sharedDeptIds.length} department
                      {sharedDeptIds.length > 1 ? "s are" : " is"} shared with a
                      business unit you kept
                    </p>
                    <p className="text-xs text-foreground mt-0.5">
                      {sharedDeptIds
                        .map((id) => {
                          const d = deptsData.find((x) => x.id === id);
                          return d ? deptLabel(d) : undefined;
                        })
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    <p className="text-xs text-foreground mt-1">
                      By default we keep these so employees from the remaining
                      business unit stay on the calendar. Tick the box below if
                      you wanted to remove the department too.
                    </p>
                  </div>
                </div>
                <label className="flex items-start gap-2 cursor-pointer pl-6">
                  <Checkbox
                    className="mt-0.5"
                    checked={dropSharedDepts}
                    onCheckedChange={(checked) => setDropSharedDepts(!!checked)}
                  />
                  <span className="text-xs font-medium text-foreground">
                    Also remove{" "}
                    {sharedDeptIds.length > 1
                      ? "these departments"
                      : "this department"}{" "}
                    from the calendar
                  </span>
                </label>
              </div>
            )}
            {(addedBuIds.length > 0 || addedDeptIds.length > 0) && (
              <div className="space-y-3">
                <p className="text-sm">
                  <span className="font-medium text-foreground">
                    {addedBuIds.length > 0 &&
                      `${addedBuIds.length} business unit${addedBuIds.length > 1 ? "s" : ""}`}
                    {addedBuIds.length > 0 &&
                      addedDeptIds.length > 0 &&
                      " and "}
                    {addedDeptIds.length > 0 &&
                      `${addedDeptIds.length} department${addedDeptIds.length > 1 ? "s" : ""}`}
                    {" added."}
                  </span>
                  {addedDeptIds.length > 0 &&
                    " How should employees from the new department(s) be assigned?"}
                </p>
                {addedDeptIds.length > 0 && (
                  <RadioGroup
                    value={empDialogChoice}
                    onValueChange={(v) =>
                      setEmpDialogChoice(v as "auto" | "manual")
                    }
                    className="space-y-2"
                  >
                    <label
                      htmlFor="wc-dlg-auto"
                      className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                    >
                      <RadioGroupItem
                        value="auto"
                        id="wc-dlg-auto"
                        className="mt-0.5"
                      />
                      <div>
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <UserCheck className="size-3.5" />
                          Assign automatically
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          All active employees from the newly added departments
                          will be assigned.
                        </p>
                      </div>
                    </label>
                    <label
                      htmlFor="wc-dlg-manual"
                      className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                    >
                      <RadioGroupItem
                        value="manual"
                        id="wc-dlg-manual"
                        className="mt-0.5"
                      />
                      <div>
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <UserX className="size-3.5" />
                          Assign manually later
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Save changes only. Use{" "}
                          <strong>Manage Employees</strong> to assign employees
                          later.
                        </p>
                      </div>
                    </label>
                  </RadioGroup>
                )}
                {empDialogChoice === "auto" && addedDeptIds.length > 0 && (
                  <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 mt-3">
                    {previewLoading ? (
                      <p className="text-xs text-muted-foreground">
                        Checking employee counts…
                      </p>
                    ) : autoAssignPreview ? (
                      <div className="text-xs space-y-1">
                        <p>
                          <span className="font-semibold text-foreground">
                            {autoAssignPreview.total}
                          </span>{" "}
                          employee
                          {autoAssignPreview.total !== 1 ? "s" : ""} found in
                          the new department
                          {addedDeptIds.length > 1 ? "s" : ""}
                        </p>
                        {autoAssignPreview.onOtherCal > 0 && (
                          <p className="text-warning">
                            {autoAssignPreview.onOtherCal} already assigned to
                            another calendar (will be skipped)
                          </p>
                        )}
                        <p className="text-primary font-medium">
                          {autoAssignPreview.willAssign} will be assigned to
                          this calendar
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEmpDialogOpen(false)}
              disabled={dialogBusy}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={async () => {
                await runEditSave(empDialogChoice);
                // On success runEditSave navigates away (unmount closes the dialog);
                // on failure dialogBusy was reset and the dialog stays open for retry.
              }}
              disabled={dialogBusy}
            >
              {dialogBusy ? "Saving…" : "Confirm & Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// ─── Weekend Matrix (memoized) ──────────────────────────────────────────────

const HALF_DAY_LABELS: Record<number, string> = {
  1: "Full",
  2: "1st Half",
  3: "2nd Half",
  0: "Off",
};
const HALF_DAY_CYCLE = [1, 2, 3, 0];

const WeekendMatrix = React.memo(function WeekendMatrix({
  matrix,
  allowHalfDay,
  workDayIndices,
  onToggle,
  onSetValue,
  onSetColumn,
}: {
  matrix: Record<string, number[]>;
  allowHalfDay: boolean;
  workDayIndices: Set<number>;
  onToggle: (week: string, dayIdx: number) => void;
  onSetValue: (week: string, dayIdx: number, val: number) => void;
  onSetColumn: (dayIdx: number, val: number) => void;
}) {
  const WEEKS = ["1", "2", "3", "4", "5"];

  const getColumnState = (dayIdx: number): number | "mixed" => {
    const vals = WEEKS.map((w) => matrix[w]?.[dayIdx] ?? 1);
    return vals.every((v) => v === vals[0]) ? vals[0] : "mixed";
  };

  return (
    <div className="overflow-x-auto rounded-xl border overflow-x-auto bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40 border-b">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground w-20">
              Week
            </th>
            {WEEK_DAYS_SHORT.map((d, dayIdx) => {
              const isWork = workDayIndices.has(dayIdx);
              return (
                <th
                  key={d}
                  className="px-1 py-2 font-medium text-muted-foreground"
                >
                  <div className="flex flex-col items-center gap-1">
                    <span>{d}</span>
                    {isWork && !allowHalfDay && (
                      <Checkbox
                        checked={getColumnState(dayIdx) === 1}
                        onCheckedChange={(checked) =>
                          onSetColumn(dayIdx, checked ? 1 : 0)
                        }
                        className="size-3.5"
                      />
                    )}
                    {isWork &&
                      allowHalfDay &&
                      (() => {
                        const colState = getColumnState(dayIdx);
                        const label =
                          colState === "mixed"
                            ? "Mixed"
                            : (HALF_DAY_LABELS[colState] ?? "Full");
                        return (
                          <button
                            type="button"
                            className={`inline-flex items-center justify-center rounded text-[9px] font-medium h-5 px-1.5 transition-colors ${
                              colState === 1
                                ? "bg-primary/10 text-primary"
                                : colState === 0
                                  ? "bg-muted text-muted-foreground"
                                  : colState === "mixed"
                                    ? "bg-muted text-muted-foreground"
                                    : "bg-badge-pending-bg text-badge-pending-text"
                            }`}
                            onClick={() => {
                              const current =
                                colState === "mixed" ? 1 : colState;
                              const idx = HALF_DAY_CYCLE.indexOf(current);
                              onSetColumn(
                                dayIdx,
                                HALF_DAY_CYCLE[
                                  (idx + 1) % HALF_DAY_CYCLE.length
                                ],
                              );
                            }}
                          >
                            {label}
                          </button>
                        );
                      })()}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {WEEKS.map((week) => (
            <tr key={week} className="border-b last:border-b-0">
              <td className="px-3 py-2 text-muted-foreground">Week {week}</td>
              {[0, 1, 2, 3, 4, 5, 6].map((dayIdx) => {
                const val = matrix[week]?.[dayIdx] ?? 1;
                const isWork = workDayIndices.has(dayIdx);
                return (
                  <td
                    key={dayIdx}
                    className={`px-1 py-1.5 ${!isWork ? "bg-muted/50" : ""}`}
                  >
                    <div className="flex items-center justify-center">
                      {!isWork ? (
                        <span className="text-xs text-muted-foreground">
                          Off
                        </span>
                      ) : allowHalfDay ? (
                        <button
                          type="button"
                          className={`inline-flex items-center justify-center rounded-md text-[11px] font-medium h-7 px-2 min-w-[68px] transition-colors ${
                            val === 1
                              ? "bg-primary/10 text-primary"
                              : val === 0
                                ? "bg-muted text-muted-foreground"
                                : "bg-badge-pending-bg text-badge-pending-text"
                          }`}
                          onClick={() => {
                            const idx = HALF_DAY_CYCLE.indexOf(val);
                            onSetValue(
                              String(week),
                              dayIdx,
                              HALF_DAY_CYCLE[(idx + 1) % HALF_DAY_CYCLE.length],
                            );
                          }}
                        >
                          {HALF_DAY_LABELS[val] ?? "Full"}
                        </button>
                      ) : (
                        <Checkbox
                          checked={val === 1}
                          onCheckedChange={() => onToggle(week, dayIdx)}
                        />
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ─── Shift Inline Components ────────────────────────────────────────────────

// Gross shift span in minutes (wrapping past midnight), before break is deducted.
function shiftSpanMinutes(start: string, end: string) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins;
}

function ShiftDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onSave,
  name,
  setName,
  startTime,
  setStartTime,
  endTime,
  setEndTime,
  breakMin,
  setBreakMin,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  confirmLabel: string;
  onSave: () => void;
  name: string;
  setName: (v: string) => void;
  startTime: string;
  setStartTime: (v: string) => void;
  endTime: string;
  setEndTime: (v: string) => void;
  breakMin: number;
  setBreakMin: (v: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Configure shift name, timing, and break duration.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <Field>
            <FieldLabel>Shift Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning Shift"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel>Start Time</FieldLabel>
              <TimeInput value={startTime} onChange={setStartTime} />
            </Field>
            <Field>
              <FieldLabel>End Time</FieldLabel>
              <TimeInput value={endTime} onChange={setEndTime} />
            </Field>
          </div>
          <Field>
            <FieldLabel>Break Duration (minutes)</FieldLabel>
            <Input
              type="number"
              min={0}
              max={1440}
              value={breakMin === 0 ? "" : breakMin}
              onChange={(e) => {
                const v = e.target.value.replace(/^0+(?=\d)/, "");
                setBreakMin(v === "" ? 0 : Number(v));
              }}
              placeholder="e.g. 30"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="soft" onClick={onSave}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShiftAddButton({ calendarId }: { calendarId: string }) {
  const [createShift] = useCreateShiftMutation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [breakMin, setBreakMin] = useState(0);

  const handleOpen = () => {
    setName("");
    setStartTime("09:00");
    setEndTime("17:00");
    setBreakMin(0);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Shift name is required");
      return;
    }
    if (!startTime || !endTime) {
      toast.error("Start and end time are required");
      return;
    }
    if (startTime === endTime) {
      toast.error("Start and end time must be different");
      return;
    }
    if (breakMin >= shiftSpanMinutes(startTime, endTime)) {
      toast.error("Break duration must be less than the shift's working hours");
      return;
    }
    try {
      await createShift({
        calendar_id: calendarId,
        name: name.trim(),
        start_time: startTime,
        end_time: endTime,
        break_minutes: breakMin,
      }).unwrap();
      toast.success("Shift added");
      setDialogOpen(false);
    } catch (err) {
      toast.error(err, "Failed to create shift");
    }
  };

  return (
    <>
      <Button size="sm" onClick={handleOpen}>
        <Plus /> Add Shift
      </Button>
      <ShiftDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Add Shift"
        confirmLabel="Save Shift"
        onSave={handleSave}
        name={name}
        setName={setName}
        startTime={startTime}
        setStartTime={setStartTime}
        endTime={endTime}
        setEndTime={setEndTime}
        breakMin={breakMin}
        setBreakMin={setBreakMin}
      />
    </>
  );
}

export function ShiftList({ calendarId }: { calendarId: string }) {
  const confirm = useConfirm();
  const { data: shifts = [], isLoading } = useGetShiftsQuery(calendarId);
  // refetchOnMountOrArgChange so the assignment count in the delete confirm
  // is never stale after a recent bulk-assign / sync from another flow.
  const { data: shiftAssignments = [] } = useGetShiftAssignmentsQuery(
    calendarId,
    { refetchOnMountOrArgChange: true },
  );
  const [updateShift] = useUpdateShiftMutation();
  const [deleteShift] = useDeleteShiftMutation();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingShift, setEditingShift] = useState<ShiftResponse | null>(null);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [breakMin, setBreakMin] = useState(0);

  const openEdit = (s: ShiftResponse) => {
    setEditingShift(s);
    setName(s.name);
    setStartTime(s.start_time);
    setEndTime(s.end_time);
    setBreakMin(s.break_minutes ?? 0);
    setEditDialogOpen(true);
  };

  const handleUpdate = async () => {
    if (!editingShift || !name.trim()) {
      toast.error("Shift name is required");
      return;
    }
    if (!startTime || !endTime) {
      toast.error("Start and end time are required");
      return;
    }
    if (startTime === endTime) {
      toast.error("Start and end time must be different");
      return;
    }
    if (breakMin >= shiftSpanMinutes(startTime, endTime)) {
      toast.error("Break duration must be less than the shift's working hours");
      return;
    }
    try {
      await updateShift({
        id: editingShift._id,
        body: {
          name: name.trim(),
          start_time: startTime,
          end_time: endTime,
          break_minutes: breakMin,
        },
      }).unwrap();
      toast.success("Shift updated");
      setEditDialogOpen(false);
    } catch (err) {
      toast.error(err, "Failed to update shift");
    }
  };

  const handleDelete = (s: ShiftResponse) => {
    const assignedCount = shiftAssignments.filter(
      (a) => a.shift_id === s._id,
    ).length;
    const cascadeLine =
      assignedCount > 0
        ? `${assignedCount} employee${assignedCount !== 1 ? "s are" : " is"} currently assigned to this shift and will be unlinked.`
        : "Any employees later assigned to this shift would lose their assignment.";
    confirm({
      title: `Delete "${s.name}"?`,
      description: `${cascadeLine} This shift will be permanently removed and cannot be recovered.`,
      variant: "destructive",
      confirmText: "Delete",
      onConfirm: async () => {
        try {
          await deleteShift(s._id).unwrap();
          toast.success(
            assignedCount > 0
              ? `Shift deleted — ${assignedCount} employee${assignedCount !== 1 ? "s" : ""} unlinked from this shift`
              : "Shift deleted",
          );
        } catch (err) {
          toast.error(err, "Failed to delete shift");
        }
      },
    });
  };

  const formatTime = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  const calcHours = (start: string, end: string, brk: number) => {
    const mins = shiftSpanMinutes(start, end) - brk;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  if (isLoading) return <PageLoader message="Loading shifts…" />;

  if (shifts.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No shifts configured"
        description="Add a shift using the button above."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {shifts.map((s: ShiftResponse) => (
          <div
            key={s._id}
            className="group rounded-xl border border-border p-4 space-y-3 hover:border-primary/30 transition-colors"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{s.name}</p>
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => openEdit(s)}
                >
                  <Edit2 className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(s)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="size-3.5" />
              <span>
                {formatTime(s.start_time)} — {formatTime(s.end_time)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="text-[10px]">
                {calcHours(s.start_time, s.end_time, s.break_minutes ?? 0)}{" "}
                working
              </Badge>
              {s.break_minutes != null && s.break_minutes > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {s.break_minutes} min break
                </Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      <ShiftDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        title="Edit Shift"
        confirmLabel="Update Shift"
        onSave={handleUpdate}
        name={name}
        setName={setName}
        startTime={startTime}
        setStartTime={setStartTime}
        endTime={endTime}
        setEndTime={setEndTime}
        breakMin={breakMin}
        setBreakMin={setBreakMin}
      />
    </>
  );
}

export default WorkCalendarForm;
