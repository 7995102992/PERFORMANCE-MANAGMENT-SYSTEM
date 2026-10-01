import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import { Users, UserCheck, UserX, AlertTriangle } from "lucide-react";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useLazyGetEmployeesQuery,
} from "@/store/api/iamApi";
import type { EmployeeResponse } from "@/types/iam";
import {
  useGetHolidayPlanQuery,
  useGetHolidayPlansQuery,
  useUpdateHolidayPlanScopeMutation,
  useLazyGetHolidayPlanDependenciesQuery,
  useLazyGetHolidayPlanEmployeesQuery,
  useGetHolidaysQuery,
  lmsApi,
} from "@/store/api/lmsApi";
import { useAppDispatch } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { PageLoader } from "@/components/shared/PageLoader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";

interface FormValues {
  name: string;
  isActive: boolean;
  businessUnitIds: string[];
  departmentIds: string[];
  reminderDays: string;
  notifyEmployees: boolean;
  reprocessLeaves: boolean;
}

function validate(
  v: FormValues,
  depts: Array<{ id: string; businessUnits?: string[] }> = [],
  bus: Array<{ id: string; business_unit_name: string }> = [],
): Partial<Record<string, string>> {
  const errs: Partial<Record<string, string>> = {};
  if (!v.name.trim()) errs.name = "Plan name is required";
  else if (v.name.trim().length > 100)
    errs.name = "Plan name must be 100 characters or less";
  if (v.businessUnitIds.length === 0)
    errs.businessUnitIds = "Select at least one business unit";
  if (v.departmentIds.length === 0)
    errs.departmentIds = "Select at least one department";
  else if (v.businessUnitIds.length > 0) {
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

const EditHolidayPlan = () => {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const dispatch = useAppDispatch();
  const scrollToError = useScrollToError();
  const { planId } = useParams({ strict: false }) as { planId: string };

  const { data: planData, isLoading } = useGetHolidayPlanQuery(planId, {
    skip: !planId,
  });
  const { data: busData = [] } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptsData = [] } = useGetDepartmentsQuery({ is_active: true });
  // Single atomic endpoint: plan + holiday re-scope + employee reconciliation in
  // one transaction (replaces the old updatePlan → syncHolidaysScope → syncEmployees
  // → bulkAssign chain so the three writes can never end up half-applied).
  const [updatePlanScope, { isLoading: isSaving }] =
    useUpdateHolidayPlanScopeMutation();
  const [fetchDependencies] = useLazyGetHolidayPlanDependenciesQuery();
  const [fetchPlanEmployees] = useLazyGetHolidayPlanEmployeesQuery();
  const [fetchEmployees] = useLazyGetEmployeesQuery();
  const { data: holidaysData } = useGetHolidaysQuery(
    { planId },
    { skip: !planId },
  );

  // Resolve the active employees that fall under a set of departments within the
  // currently-selected business units, paginated. Used to build the final desired
  // membership the atomic endpoint reconciles to.
  const fetchUserIdsInScope = async (deptIds: string[]): Promise<string[]> => {
    if (deptIds.length === 0) return [];
    const all: EmployeeResponse[] = [];
    let skip = 0;
    const PAGE = 100;
    while (true) {
      const batch = await fetchEmployees({
        department_ids: deptIds,
        business_unit_ids: values.businessUnitIds,
        is_active: true,
        limit: PAGE,
        skip,
      }).unwrap();
      all.push(...batch);
      if (batch.length < PAGE) break;
      skip += PAGE;
      if (skip >= 10000) break;
    }
    return all
      .map((e) => e.userId ?? e.user_id ?? e.id)
      .filter(Boolean) as string[];
  };
  const existingHolidays = holidaysData?.items ?? [];

  const [values, setValues] = useState<FormValues>({
    name: "",
    isActive: true,
    businessUnitIds: [],
    departmentIds: [],
    reminderDays: "0",
    notifyEmployees: true,
    reprocessLeaves: true,
  });
  const [touched, setTouched] = useState<Partial<Record<string, boolean>>>({});
  const [initialized, setInitialized] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (planData?.name) dispatch(setBreadcrumbDetail(planData.name));
  }, [planData?.name, dispatch]);

  useEffect(
    () => () => {
      dispatch(setBreadcrumbDetail(null));
    },
    [dispatch],
  );

  useEffect(() => {
    if (!planData || initialized) return;
    const buIds = (planData.business_units ?? []).map(
      (bu: any) => bu.id ?? bu._id ?? bu,
    ) as string[];
    const deptIds = (planData.departments ?? []).map(
      (d: any) => d.id ?? d._id ?? d,
    ) as string[];
    const daysBefore = planData.reminder_settings?.days_before ?? 0;
    setValues({
      name: planData.name,
      isActive: planData.is_active ?? true,
      businessUnitIds: buIds,
      departmentIds: deptIds,
      reminderDays: String(daysBefore),
      notifyEmployees: planData.notify_employees ?? true,
      reprocessLeaves: planData.reprocess_leaves ?? true,
    });
    setInitialized(true);
  }, [planData, initialized]);

  const buOptions = useMemo<Option[]>(
    () => busData.map((bu) => ({ label: bu.business_unit_name, value: bu.id })),
    [busData],
  );

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

  const deptOptions = useMemo<Option[]>(
    () => filteredDepts.map((d) => ({ label: deptLabel(d), value: d.id })),
    [filteredDepts],
  );

  useEffect(() => {
    if (buOptions.length === 1 && values.businessUnitIds.length === 0)
      setValues((v) => ({ ...v, businessUnitIds: [buOptions[0].value] }));
  }, [buOptions, values.businessUnitIds.length]);

  useEffect(() => {
    if (deptOptions.length === 1 && values.departmentIds.length === 0)
      setValues((v) => ({ ...v, departmentIds: [deptOptions[0].value] }));
  }, [deptOptions, values.departmentIds.length]);

  // Diff: original BU + dept IDs from server vs current selection
  const originalBuIds = useMemo(
    () =>
      (planData?.business_units ?? []).map(
        (b: any) => b.id ?? b._id ?? b,
      ) as string[],
    [planData],
  );
  const originalDeptIds = useMemo(
    () =>
      (planData?.departments ?? []).map(
        (d: any) => d.id ?? d._id ?? d,
      ) as string[],
    [planData],
  );
  const addedBuIds = useMemo(
    () =>
      initialized
        ? values.businessUnitIds.filter((id) => !originalBuIds.includes(id))
        : [],
    [values.businessUnitIds, originalBuIds, initialized],
  );
  const removedBuIds = useMemo(
    () =>
      initialized
        ? originalBuIds.filter((id) => !values.businessUnitIds.includes(id))
        : [],
    [values.businessUnitIds, originalBuIds, initialized],
  );
  const addedDeptIds = useMemo(
    () =>
      initialized
        ? values.departmentIds.filter((id) => !originalDeptIds.includes(id))
        : [],
    [values.departmentIds, originalDeptIds, initialized],
  );
  const removedDeptIds = useMemo(
    () =>
      initialized
        ? originalDeptIds.filter((id) => !values.departmentIds.includes(id))
        : [],
    [values.departmentIds, originalDeptIds, initialized],
  );

  // Depts originally tied to a removed BU but still selected because they're
  // also linked to a remaining BU. The cascading filter at the BU selector
  // keeps them silently; the save dialog surfaces them so the user can
  // explicitly drop them too if the BU removal was meant to clean up everything.
  const sharedDeptIds = useMemo(() => {
    if (!initialized || removedBuIds.length === 0) return [];
    return values.departmentIds.filter((deptId) => {
      if (!originalDeptIds.includes(deptId)) return false;
      const dept = deptsData.find((d) => d.id === deptId);
      return !!dept?.businessUnits?.some((buId) => removedBuIds.includes(buId));
    });
  }, [
    initialized,
    removedBuIds,
    values.departmentIds,
    originalDeptIds,
    deptsData,
  ]);

  // True only when at least one dept in the plan's post-edit department_ids
  // belongs to a newly added BU. Without this, extending holidays to a new BU
  // is pointless — no employee in that BU is in the plan's dept scope.
  const addedBuHasScopedDepts = useMemo(
    () =>
      addedBuIds.length > 0 &&
      deptsData.some(
        (d) =>
          values.departmentIds.includes(d.id) &&
          d.businessUnits?.some((buId) => addedBuIds.includes(buId)),
      ),
    [addedBuIds, deptsData, values.departmentIds],
  );

  const [empDialogOpen, setEmpDialogOpen] = useState(false);
  const [empDialogChoice, setEmpDialogChoice] = useState<"auto" | "manual">(
    "auto",
  );
  // When a removed BU shares depts with a remaining BU, those depts stay by
  // default. This lets the user opt-in to dropping them too.
  const [dropSharedDepts, setDropSharedDepts] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [deactivationEmployeeCount, setDeactivationEmployeeCount] = useState<
    number | null
  >(null);

  // const dispatch = useAppDispatch()
  const { data: allPlans } = useGetHolidayPlansQuery();
  const [autoAssignPreview, setAutoAssignPreview] = useState<{
    total: number;
    onOtherPlan: number;
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
        const otherPlans = (allPlans ?? []).filter(
          (p) => p._id !== planId && p.is_active !== false,
        );
        const otherPlanUserIds = new Set<string>();
        const subs: { unsubscribe: () => void }[] = [];
        await Promise.all(
          otherPlans.map(async (p) => {
            const sub = dispatch(
              lmsApi.endpoints.getHolidayPlanEmployees.initiate(p._id),
            );
            subs.push(sub);
            try {
              const entries = await sub.unwrap();
              entries.forEach((e) => otherPlanUserIds.add(e.user_id));
            } catch {
              /* skip */
            }
          }),
        );
        subs.forEach((s) => s.unsubscribe());
        if (cancelled) return;
        const total = allEmps.length;
        const onOtherPlan = allEmps.filter((e) =>
          otherPlanUserIds.has(e.userId ?? e.user_id ?? e.id),
        ).length;
        setAutoAssignPreview({
          total,
          onOtherPlan,
          willAssign: total - onOtherPlan,
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

  const isDirty =
    initialized &&
    (values.name !== planData?.name ||
      values.isActive !== (planData?.is_active ?? true) ||
      JSON.stringify([...values.businessUnitIds].sort()) !==
        JSON.stringify(
          (planData?.business_units ?? [])
            .map((bu: any) => bu.id ?? bu._id ?? bu)
            .sort(),
        ) ||
      JSON.stringify([...values.departmentIds].sort()) !==
        JSON.stringify(
          (planData?.departments ?? [])
            .map((d: any) => d.id ?? d._id ?? d)
            .sort(),
        ) ||
      values.reminderDays !==
        String(planData?.reminder_settings?.days_before ?? 0));

  const isDeactivating =
    initialized && !values.isActive && (planData?.is_active ?? true);

  useEffect(() => {
    if (!isDeactivating || !planId) {
      setDeactivationEmployeeCount(null);
      return;
    }
    fetchDependencies(planId)
      .unwrap()
      .then((deps) => setDeactivationEmployeeCount(deps.employees))
      .catch(() => setDeactivationEmployeeCount(null));
  }, [isDeactivating, planId]);

  const errors = validate(values, deptsData, busData);
  const touch = (field: string) => setTouched((t) => ({ ...t, [field]: true }));
  const fieldError = (field: string) =>
    touched[field] ? errors[field] : undefined;

  const releaseNavigationGuard = useNavigationGuard(isDirty);

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
          navigate({ to: "/leave-management/holiday-calendar" });
        },
      });
    } else {
      navigate({ to: "/leave-management/holiday-calendar" });
    }
  };

  const runEditSave = async (choice: "auto" | "manual"): Promise<boolean> => {
    setDialogBusy(true);
    if (isDeactivating) {
      try {
        const deps = await fetchDependencies(planId).unwrap();
        setDeactivationEmployeeCount(deps.employees);
        if (deps.employees > 0) {
          toast.error(
            `Cannot deactivate � ${deps.employees} employee${deps.employees !== 1 ? "s are" : " is"} still assigned.`,
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

    const hasRemovedDepts = effectiveRemovedDeptIds.length > 0;
    const hasAddedDepts = addedDeptIds.length > 0;
    const hasRemovedBus = removedBuIds.length > 0;
    const hasAddedBus = addedBuIds.length > 0;

    // Holiday re-scope cascade (same rules as before): the BE updates every
    // holiday in the plan, extending to added depts/BUs and trimming removed
    // ones, skipping any that trimming would leave with no departments / no
    // business units (reported as "orphaned").
    const shouldExtend = hasAddedDepts;
    const shouldTrim = hasRemovedDepts;
    const shouldExtendBu = hasAddedBus && addedBuHasScopedDepts;
    const shouldTrimBu = hasRemovedBus;
    const cascadeHolidays =
      existingHolidays.length > 0 &&
      (shouldExtend || shouldTrim || shouldExtendBu || shouldTrimBu);

    // Build the final desired employee membership the atomic endpoint reconciles
    // to — or leave it undefined to keep assignments untouched. An employee stays
    // only if BOTH their department AND business unit are still in scope.
    //  • A removal REPLACES membership with the in-scope set of the surviving
    //    departments (so emps whose dept survives but whose BU left fall out).
    //  • With no removal we PRESERVE current members and only ADD the new-dept
    //    employees (auto-assign choice). The BE skips anyone already on another
    //    plan and reports them as skipped.
    //  • Pure rename / "assign manually" => undefined: don't touch assignments.
    let memberUserIds: string[] | undefined;
    setIsProcessing(true);
    try {
      if (hasRemovedDepts || hasRemovedBus) {
        const deptsForSync = effectiveDeptIds.filter(
          (id) => !addedDeptIds.includes(id),
        );
        const set = new Set(await fetchUserIdsInScope(deptsForSync));
        if (hasAddedDepts && choice === "auto") {
          for (const id of await fetchUserIdsInScope(addedDeptIds)) set.add(id);
        }
        memberUserIds = [...set];
      } else if (hasAddedDepts && choice === "auto") {
        const current = await fetchPlanEmployees(planId).unwrap();
        const set = new Set(
          current.map((e) => e.user_id).filter(Boolean) as string[],
        );
        for (const id of await fetchUserIdsInScope(addedDeptIds)) set.add(id);
        memberUserIds = [...set];
      }
    } catch (err) {
      setIsProcessing(false);
      setDialogBusy(false);
      toast.error(err, "Failed to resolve employee assignments");
      return false;
    }

    // ── Single atomic call: plan + holiday re-scope + employee reconciliation ──
    try {
      const days = Number(values.reminderDays);
      const r = await updatePlanScope({
        planId,
        business_unit_ids: values.businessUnitIds,
        department_ids: effectiveDeptIds,
        name: values.name.trim(),
        is_active: values.isActive,
        reminder_settings: { enabled: days > 0, days_before: days },
        notify_employees: values.notifyEmployees,
        reprocess_leaves: values.reprocessLeaves,
        ...(cascadeHolidays && shouldExtend
          ? { holiday_extend_dept_ids: addedDeptIds }
          : {}),
        ...(cascadeHolidays && shouldTrim
          ? { holiday_trim_dept_ids: effectiveRemovedDeptIds }
          : {}),
        ...(cascadeHolidays && shouldExtendBu
          ? { holiday_extend_bu_ids: addedBuIds }
          : {}),
        ...(cascadeHolidays && shouldTrimBu
          ? { holiday_trim_bu_ids: removedBuIds }
          : {}),
        ...(memberUserIds !== undefined
          ? { member_user_ids: memberUserIds }
          : {}),
      }).unwrap();

      // Holiday-scope feedback
      const parts: string[] = [];
      if (r.extended > 0)
        parts.push(`${r.extended} holiday${r.extended !== 1 ? "s" : ""} extended`);
      if (r.trimmed > 0)
        parts.push(`${r.trimmed} holiday${r.trimmed !== 1 ? "s" : ""} trimmed`);
      if (r.bu_extended > 0)
        parts.push(
          `${r.bu_extended} holiday${r.bu_extended !== 1 ? "s" : ""} extended to new BU${addedBuIds.length > 1 ? "s" : ""}`,
        );
      if (r.bu_trimmed > 0)
        parts.push(
          `${r.bu_trimmed} holiday${r.bu_trimmed !== 1 ? "s" : ""} trimmed for removed BU${removedBuIds.length > 1 ? "s" : ""}`,
        );
      if (parts.length) toast.success(parts.join(", "));
      if (r.orphaned > 0)
        toast.error(
          `${r.orphaned} holiday${r.orphaned !== 1 ? "s were" : " was"} not trimmed — would leave no departments. Edit or delete manually.`,
        );
      if (r.bu_orphaned > 0)
        toast.error(
          `${r.bu_orphaned} holiday${r.bu_orphaned !== 1 ? "s were" : " was"} not trimmed — would leave no business units. Edit or delete manually.`,
        );

      // Employee feedback
      if (r.employees_removed > 0)
        toast.success(
          `${r.employees_removed} employee${r.employees_removed !== 1 ? "s" : ""} unassigned (out of scope after business unit / department changes)`,
        );
      if (hasAddedDepts && choice === "auto") {
        if (r.employees_added > 0 && r.employees_skipped > 0) {
          toast.success(
            `${r.employees_added} employee${r.employees_added !== 1 ? "s" : ""} assigned, ${r.employees_skipped} skipped (already on another plan)`,
          );
        } else if (r.employees_added > 0) {
          toast.success(
            `${r.employees_added} employee${r.employees_added !== 1 ? "s" : ""} assigned to plan`,
          );
        } else if (r.employees_skipped > 0) {
          toast.success(
            `${r.employees_skipped} employee${r.employees_skipped !== 1 ? "s" : ""} skipped — already assigned to another plan`,
          );
        } else {
          toast.success(
            "No active employees in the new department(s) — assign manually via Manage Employees",
          );
        }
      } else if (hasAddedDepts && choice === "manual") {
        toast.success(
          "New departments added — assign employees via Manage Employees",
        );
      }
    } catch (err) {
      setIsProcessing(false);
      setDialogBusy(false);
      toast.error(err, "Failed to update holiday plan");
      return false;
    } finally {
      setIsProcessing(false);
    }

    toast.success("Holiday plan updated");
    releaseNavigationGuard();
    navigate({ to: "/leave-management/holiday-calendar" });
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, businessUnitIds: true, departmentIds: true });
    if (Object.keys(errors).length > 0) {
      toast.error("Please fill all required fields");
      requestAnimationFrame(() => scrollToError());
      return;
    }

    if (isDeactivating) {
      let empCount = deactivationEmployeeCount;
      if (empCount == null) {
        try {
          const deps = await fetchDependencies(planId).unwrap();
          empCount = deps.employees;
          setDeactivationEmployeeCount(empCount);
        } catch {
          /* proceed if check fails */
        }
      }
      if (empCount != null && empCount > 0) {
        toast.error(
          `Cannot deactivate — ${empCount} employee${empCount !== 1 ? "s are" : " is"} still assigned. Unassign employees first via Manage Employees.`,
        );
        return;
      }
    }

    if (
      removedDeptIds.length > 0 ||
      addedDeptIds.length > 0 ||
      removedBuIds.length > 0 ||
      addedBuIds.length > 0
    ) {
      setEmpDialogChoice("auto");
      setDropSharedDepts(false);
      setEmpDialogOpen(true);
      return;
    }

    const baseDesc = isDeactivating
      ? `Are you sure you want to deactivate "${values.name.trim()}"? Employees will no longer see holidays from this plan.`
      : `Are you sure you want to update "${values.name.trim()}"?`;

    confirm({
      title: isDeactivating
        ? `Deactivate & Update "${values.name.trim()}"?`
        : "Update Holiday Plan?",
      description: baseDesc,
      ...(isDeactivating ? { variant: "destructive" as const } : {}),
      confirmText: "Update",
      onConfirm: () => {
        void runEditSave("manual");
      },
    });
  };

  if (isLoading) return <PageLoader message="Loading plan�" />;
  if (isProcessing)
    return <PageLoader message="Updating employee assignments�" />;

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Edit Holiday Plan</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Update the plan details for{" "}
          <span className="font-medium text-foreground">{planData?.name}</span>
          {planData?.year && <> ({planData.year})</>}.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        <Card>
          <CardContent className="space-y-5 pt-2">
            <div className="space-y-1 border-b pb-4">
              <h3 className="text-base font-semibold">Plan Details</h3>
              <p className="text-sm text-muted-foreground">
                Name and assignment for this plan.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-start justify-between gap-6">
                <Field className="flex-1" data-invalid={!!fieldError("name")}>
                  <FieldLabel>
                    Plan Name <span className="text-destructive">*</span>
                  </FieldLabel>
                  <Input
                    value={values.name}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, name: e.target.value }))
                    }
                    onBlur={() => touch("name")}
                    aria-invalid={!!fieldError("name")}
                  />
                  {fieldError("name") && (
                    <FieldError errors={[{ message: fieldError("name") }]} />
                  )}
                </Field>

                <div className="shrink-0 flex items-center gap-3 pt-7">
                  <Label className="text-sm font-medium">Status</Label>
                  <Switch
                    checked={values.isActive}
                    onCheckedChange={(v) =>
                      setValues((prev) => ({ ...prev, isActive: v }))
                    }
                  />
                  <Badge variant={values.isActive ? "default" : "secondary"}>
                    {values.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </div>
              {isDeactivating &&
                deactivationEmployeeCount != null &&
                deactivationEmployeeCount > 0 && (
                  <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
                    <p className="text-xs text-destructive">
                      {deactivationEmployeeCount} employee
                      {deactivationEmployeeCount !== 1 ? "s are" : " is"}{" "}
                      currently assigned to this plan. Unassign all employees
                      via <strong>Manage Employees</strong> before deactivating.
                    </p>
                  </div>
                )}
            </div>

            <Field data-invalid={!!fieldError("businessUnitIds")}>
              <FieldLabel>
                Business Units <span className="text-destructive">*</span>
              </FieldLabel>
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
                placeholder="Select business units�"
              />
              {fieldError("businessUnitIds") && (
                <FieldError
                  errors={[{ message: fieldError("businessUnitIds") }]}
                />
              )}
            </Field>

            <Field data-invalid={!!fieldError("departmentIds")}>
              <FieldLabel>
                Departments <span className="text-destructive">*</span>
              </FieldLabel>
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
                    ? "Select a business unit first�"
                    : "Select departments�"
                }
                disabled={values.businessUnitIds.length === 0}
              />
              {fieldError("departmentIds") && (
                <FieldError
                  errors={[{ message: fieldError("departmentIds") }]}
                />
              )}
            </Field>

            {/* Removed departments � employees in those depts will be unlinked. */}
            {removedDeptIds.length > 0 && (
              <div className="rounded-xl border border-warning/20 bg-badge-pending-bg p-3 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {removedDeptIds.length} department
                  {removedDeptIds.length > 1 ? "s" : ""} removed
                </p>
                <p className="text-xs text-badge-pending-text dark:text-badge-pending-text">
                  Employees in the removed department
                  {removedDeptIds.length > 1 ? "s" : ""} will be unlinked when
                  you save, regardless of which business unit they belong to.
                </p>
              </div>
            )}

            {/* Shared depts kept after BU removal — show inline with
                            the OTHER BUs they're linked to, plus a per-dept Remove
                            so the user can decide one-by-one instead of guessing. */}
            {sharedDeptIds.length > 0 && (
              <div className="rounded-xl border border-warning/20 bg-warning/10 p-3 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {sharedDeptIds.length} department
                  {sharedDeptIds.length > 1 ? "s were" : " was"} kept because{" "}
                  {sharedDeptIds.length > 1 ? "they're" : "it's"} also linked to
                  a business unit you didn't remove
                </p>
                <p className="text-xs text-muted-foreground">
                  Review each one — keep it if you still want it, or remove it
                  from this plan.
                </p>
                <ul className="space-y-1.5 pt-1">
                  {sharedDeptIds.map((deptId) => {
                    const dept = deptsData.find((d) => d.id === deptId);
                    if (!dept) return null;
                    const otherBuNames = (dept.businessUnits ?? [])
                      .filter((buId) => values.businessUnitIds.includes(buId))
                      .map(
                        (buId) =>
                          busData.find((b) => b.id === buId)
                            ?.business_unit_name,
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
                            Kept on this plan because it's also part of:{" "}
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
          </CardContent>
        </Card>

        {/* Reminder & Notifications */}
        <Card>
          <CardContent className="space-y-5 pt-2">
            <div className="space-y-1 border-b pb-4">
              <h3 className="text-base font-semibold">
                Reminder & Notifications
              </h3>
              <p className="text-sm text-muted-foreground">
                Email reminders and notification preferences.
              </p>
            </div>

            <Field>
              <FieldLabel>Reminder Email</FieldLabel>
              <SearchableSelect
                options={[
                  { label: "No reminder", value: "0" },
                  { label: "1 day before", value: "1" },
                  { label: "2 days before", value: "2" },
                  { label: "3 days before", value: "3" },
                  { label: "1 week before", value: "7" },
                ]}
                value={values.reminderDays}
                onChange={(val) => {
                  const days: string = val as string;
                  setValues((v) => ({ ...v, reminderDays: days }));
                }}
                placeholder="Select reminder"
                searchable={false}
              />
            </Field>

            <div className="space-y-3">
              <FieldLabel>Notification Options</FieldLabel>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox
                  className="mt-0.5"
                  checked={values.notifyEmployees}
                  onCheckedChange={(checked) =>
                    setValues((v) => ({ ...v, notifyEmployees: !!checked }))
                  }
                />
                <span className="text-sm font-medium">
                  Notify applicable employees
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox
                  className="mt-0.5"
                  checked={values.reprocessLeaves}
                  onCheckedChange={(checked) =>
                    setValues((v) => ({ ...v, reprocessLeaves: !!checked }))
                  }
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">
                    Reprocess leave applications
                  </span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    Leaves already applied for holidays in this plan will be
                    reprocessed and balance adjusted.
                  </span>
                </div>
              </label>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="soft" disabled={!isDirty || isSaving}>
            {isSaving ? "Saving�" : "Update Plan"}
          </Button>
        </div>
      </form>

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
              <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-badge-pending-bg px-3 py-2.5">
                <UserX className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="text-sm text-foreground">
                  <p className="font-medium">
                    {removedBuIds.length > 0 &&
                      `${removedBuIds.length} business unit${removedBuIds.length > 1 ? "s" : ""}`}
                    {removedBuIds.length > 0 &&
                      removedDeptIds.length > 0 &&
                      " and "}
                    {removedDeptIds.length > 0 &&
                      `${removedDeptIds.length} department${removedDeptIds.length > 1 ? "s" : ""}`}
                    {" removed"}
                  </p>
                  <p className="mt-0.5 text-xs">
                    Employees no longer covered by the plan&apos;s scope will be
                    unlinked — anyone whose business unit OR department is no
                    longer in the plan. An employee stays only while both their
                    business unit and department remain in the plan.
                  </p>
                </div>
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
                      business unit stay in the plan. Tick the box below if you
                      wanted to remove the department too.
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
                    from the plan
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
                      htmlFor="hp-dlg-auto"
                      className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                    >
                      <RadioGroupItem
                        value="auto"
                        id="hp-dlg-auto"
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
                      htmlFor="hp-dlg-manual"
                      className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                    >
                      <RadioGroupItem
                        value="manual"
                        id="hp-dlg-manual"
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
                          employee{autoAssignPreview.total !== 1 ? "s" : ""}{" "}
                          found in the new department
                          {addedDeptIds.length > 1 ? "s" : ""}
                        </p>
                        {autoAssignPreview.onOtherPlan > 0 && (
                          <p className="text-warning">
                            {autoAssignPreview.onOtherPlan} already assigned to
                            another plan (will be skipped)
                          </p>
                        )}
                        <p className="text-primary font-medium">
                          {autoAssignPreview.willAssign} will be assigned to
                          this plan
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {/* Existing-holiday scope preview — cascades automatically, no choice. */}
            {existingHolidays.length > 0 &&
              (removedDeptIds.length > 0 ||
                removedBuIds.length > 0 ||
                addedDeptIds.length > 0 ||
                (addedBuIds.length > 0 && addedBuHasScopedDepts)) && (
                <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 space-y-1.5 border-t">
                  <p className="text-xs font-medium text-foreground">
                    Existing holidays in this plan will be updated
                    automatically:
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-1 pl-4 list-disc">
                    {removedDeptIds.length > 0 && (
                      <li>
                        Removed department{removedDeptIds.length > 1 ? "s" : ""}{" "}
                        will be dropped from every holiday's scope.
                      </li>
                    )}
                    {removedBuIds.length > 0 && (
                      <li>
                        Removed business unit
                        {removedBuIds.length > 1 ? "s" : ""} will be dropped
                        from every holiday's scope.
                      </li>
                    )}
                    {addedDeptIds.length > 0 && (
                      <li>
                        Newly added department
                        {addedDeptIds.length > 1 ? "s" : ""} will be included in
                        every existing holiday.
                      </li>
                    )}
                    {addedBuIds.length > 0 && addedBuHasScopedDepts && (
                      <li>
                        Newly added business unit
                        {addedBuIds.length > 1 ? "s" : ""} will be included in
                        every existing holiday.
                      </li>
                    )}
                    <li>
                      Holidays that would be left with no scope will be skipped
                      and reported so you can review them manually.
                    </li>
                  </ul>
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
              onClick={async () => {
                await runEditSave(empDialogChoice);
                // On success runEditSave navigates away; on failure dialog stays open for retry.
              }}
              disabled={dialogBusy}
            >
              {dialogBusy ? "Saving�" : "Confirm & Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default EditHolidayPlan;
