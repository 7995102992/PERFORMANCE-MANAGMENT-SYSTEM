/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useLazyGetEmployeesQuery,
} from "@/store/api/iamApi";
import type { EmployeeResponse } from "@/types/iam";
import {
  useCreateHolidayPlanMutation,
  useUpdateHolidayPlanMutation,
  useSyncHolidayPlanEmployeesMutation,
  useBulkAssignHolidayPlanEmployeesMutation,
  useGetHolidayPlanQuery,
  useGetClassificationsQuery,
  useCreateClassificationMutation,
  useUpdateClassificationMutation,
  useGetHolidaysQuery,
  useCreateHolidayMutation,
  useDeleteHolidayMutation,
  useGetHolidayPlanEmployeesQuery,
  useLazyDownloadHolidayBulkTemplateQuery,
  useValidateHolidayBulkUploadMutation,
  useBulkImportHolidaysFromFileMutation,
} from "@/store/api/lmsApi";
import type { ClassificationResponse } from "@/types/leave";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { Option } from "@/components/shared/SearchableSelect";
import {
  Users,
  UserCheck,
  UserX,
  Edit2,
  Plus,
  Trash2,
  Copy,
  Upload,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PageLoader } from "@/components/shared/PageLoader";
import { FullScreenLoader } from "@/components/shared/FullScreenLoader";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { Stepper, type StepperStep } from "@/components/ui/stepper";
import { ColorPicker } from "@/components/shared/ColorPicker";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import {
  AddEmployeesToPlan,
  type AddEmployeesToPlanHandle,
} from "./AddEmployeesToPlan";
import { ImportHolidaysFromPlan } from "./ImportHolidaysFromPlan";
import { BulkUploadHolidaysDialog } from "@/components/shared/BulkUploadHolidaysDialog";

const currentYear = new Date().getFullYear();
const yearOptions = [currentYear];

const STEPS: StepperStep[] = [
  { id: 0, label: "Plan" },
  { id: 1, label: "Classifications" },
  { id: 2, label: "Holidays" },
  { id: 3, label: "Manage Employees" },
];

interface Step1Values {
  name: string;
  year: string;
  businessUnitIds: string[];
  departmentIds: string[];
  reminderDays: string;
  notifyEmployees: boolean;
  reprocessLeaves: boolean;
  assignmentMode: "auto" | "manual";
}

const EMPTY_STEP1: Step1Values = {
  name: "",
  year: String(currentYear),
  businessUnitIds: [],
  departmentIds: [],
  reminderDays: "0",
  notifyEmployees: true,
  reprocessLeaves: true,
  assignmentMode: "manual",
};

function validateStep1(
  v: Step1Values,
  depts: Array<{ id: string; businessUnits?: string[] }> = [],
  bus: Array<{ id: string; business_unit_name: string }> = [],
): Partial<Record<keyof Step1Values, string>> {
  const errs: Partial<Record<keyof Step1Values, string>> = {};
  if (!v.name.trim()) errs.name = "Plan name is required";
  else if (v.name.trim().length > 100)
    errs.name = "Plan name must be 100 characters or less";
  if (!v.year) errs.year = "Year is required";
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

// ─── Main orchestrator ──────────────────────────────────────────────────────

const AddHolidayPlan = () => {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const dispatch = useAppDispatch();
  // Both routes share this component: /add-plan (no planId) and /:planId/setup
  const { planId: paramPlanId } = useParams({ strict: false }) as {
    planId?: string;
  };
  const search = useSearch({ strict: false }) as { step?: number };

  // URL is the source of truth — survives refresh.
  const initialStep = (() => {
    const fromUrl =
      typeof search.step === "number" ? search.step : Number(search.step);
    if (Number.isFinite(fromUrl) && fromUrl >= 0 && fromUrl <= 3)
      return fromUrl;
    return paramPlanId ? 1 : 0;
  })();

  const [activeStep, setActiveStep] = useState(initialStep);
  const [createdPlanId, setCreatedPlanId] = useState<string>(paramPlanId ?? "");
  // Tracks which steps the user has finished and moved past during *this*
  // wizard session. Driven by Next/Finish clicks, not by remote data presence
  // — otherwise globally-shared things like classifications would always show
  // as complete on a fresh new plan. Steps before the resume point are
  // implicitly done.
  const [completed, setCompleted] = useState<Set<number>>(
    new Set(Array.from({ length: initialStep }, (_, i) => i)),
  );
  // Step 1 form state lives in the parent so it survives Back navigation.
  const [step1Values, setStep1Values] = useState<Step1Values>(EMPTY_STEP1);
  const [step1Touched, setStep1Touched] = useState<
    Partial<Record<keyof Step1Values, boolean>>
  >({});

  // Keep state in sync when the URL changes externally (back/forward nav).
  useEffect(() => {
    if (paramPlanId && paramPlanId !== createdPlanId) {
      setCreatedPlanId(paramPlanId);
    }
  }, [paramPlanId, createdPlanId]);

  const step1Dirty =
    step1Values.name.trim() !== "" ||
    step1Values.businessUnitIds.length > 0 ||
    step1Values.departmentIds.length > 0;
  const partialSetup = !!createdPlanId && completed.size < STEPS.length;
  const releaseNavigationGuard = useNavigationGuard(step1Dirty || partialSetup);

  const goToStep = (step: number) => {
    setActiveStep(step);
    if (createdPlanId) {
      releaseNavigationGuard();
      navigate({
        to: `/leave-management/holiday-calendar/${createdPlanId}/setup`,
        search: { step } as any,
        replace: true,
      });
    }
  };

  // Re-fetch plan data once created — used by steps 3 and 4 to know BU/dept scope.
  const { data: planData } = useGetHolidayPlanQuery(createdPlanId, {
    skip: !createdPlanId,
  });

  // Breadcrumb — reflect plan name once known, clear on unmount.
  useEffect(() => {
    dispatch(setBreadcrumbDetail(planData?.name ?? "New Holiday Plan"));
  }, [planData?.name, dispatch]);

  useEffect(
    () => () => {
      dispatch(setBreadcrumbDetail(null));
    },
    [dispatch],
  );

  const { data: classifications = [] } = useGetClassificationsQuery();
  const { data: holidaysData } = useGetHolidaysQuery(
    { planId: createdPlanId },
    { skip: !createdPlanId },
  );
  const holidays = holidaysData?.items ?? [];
  const { data: assignedEmployees = [] } = useGetHolidayPlanEmployeesQuery(
    createdPlanId,
    {
      skip: !createdPlanId,
      refetchOnMountOrArgChange: true,
    },
  );

  const markComplete = (stepId: number) =>
    setCompleted((s) => {
      const next = new Set(s);
      next.add(stepId);
      return next;
    });

  const handleStepClick = (id: number) => {
    // Allow revisiting any step the user has already advanced past.
    if (id < activeStep || completed.has(id)) goToStep(id);
  };

  const exitToLanding = () => {
    releaseNavigationGuard();
    navigate({ to: "/leave-management/holiday-calendar" });
  };

  const handleExitMidway = () => {
    if (createdPlanId) {
      confirm({
        title: "Leave setup?",
        description:
          "The plan has been created but is not fully set up. You can finish setup later from the Holiday Calendar.",
        confirmText: "Leave",
        onConfirm: exitToLanding,
      });
    } else {
      exitToLanding();
    }
  };

  return (
    <div className="space-y-6">
      <div className="mb-2">
        <h1 className="text-xl">New Holiday Plan</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Set up plan basics, classifications, holidays, and assign employees.
        </p>
      </div>

      <Stepper
        steps={STEPS}
        current={activeStep}
        completed={completed}
        onStepClick={handleStepClick}
        className="mb-6"
      />

      {activeStep === 0 && (
        <Step1Basics
          values={step1Values}
          setValues={setStep1Values}
          touched={step1Touched}
          setTouched={setStep1Touched}
          alreadyCreatedPlanId={createdPlanId}
          currentPlanData={planData}
          currentAssignedUserIds={assignedEmployees.map((e) => e.user_id)}
          onCreated={(id) => {
            setCreatedPlanId(id);
            markComplete(0);
            // Redirect to /:id/setup?step=1 so refresh keeps the user here.
            releaseNavigationGuard();
            navigate({
              to: `/leave-management/holiday-calendar/${id}/setup`,
              search: { step: 1 } as any,
              replace: true,
            });
            setActiveStep(1);
          }}
          onAdvanceWithoutCreate={() => {
            markComplete(0);
            goToStep(1);
          }}
          onCancel={exitToLanding}
        />
      )}

      {activeStep === 1 && createdPlanId && (
        <Step2Classifications
          classifications={classifications}
          onBack={() => goToStep(0)}
          onNext={() => {
            markComplete(1);
            goToStep(2);
          }}
          onExit={handleExitMidway}
        />
      )}

      {activeStep === 2 && createdPlanId && planData && (
        <Step3Holidays
          planId={createdPlanId}
          planData={planData}
          classifications={classifications}
          holidays={holidays}
          onBack={() => goToStep(1)}
          onNext={() => {
            markComplete(2);
            goToStep(3);
          }}
          onExit={handleExitMidway}
        />
      )}

      {activeStep === 3 && createdPlanId && planData && (
        <Step4Employees
          planData={planData}
          assignedCount={assignedEmployees.length}
          onBack={() => goToStep(2)}
          onFinish={() => {
            markComplete(3);
            toast.success("Holiday plan setup complete");
            exitToLanding();
          }}
          onExit={handleExitMidway}
          onExitNoConfirm={exitToLanding}
        />
      )}
    </div>
  );
};

export default AddHolidayPlan;

// ─── Step 1: Plan Basics ────────────────────────────────────────────────────

interface Step1Props {
  values: Step1Values;
  setValues: React.Dispatch<React.SetStateAction<Step1Values>>;
  touched: Partial<Record<keyof Step1Values, boolean>>;
  setTouched: React.Dispatch<
    React.SetStateAction<Partial<Record<keyof Step1Values, boolean>>>
  >;
  alreadyCreatedPlanId: string;
  /** When the user navigated back to step 1, this is the plan as it lives in the BE. */
  currentPlanData?: any;
  /** Current member user_ids on the plan — used to unassign out-of-scope employees when BU/dept changes. */
  currentAssignedUserIds: string[];
  onCreated: (id: string) => void;
  onAdvanceWithoutCreate: () => void;
  onCancel: () => void;
}

function Step1Basics({
  values,
  setValues,
  touched,
  setTouched,
  alreadyCreatedPlanId,
  currentPlanData,
  currentAssignedUserIds,
  onCreated,
  onAdvanceWithoutCreate,
  onCancel,
}: Step1Props) {
  const confirm = useConfirm();
  const scrollToError = useScrollToError();

  const [isAssigning, setIsAssigning] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);

  const { data: busData = [] } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptsData = [] } = useGetDepartmentsQuery({ is_active: true });
  const [createHolidayPlan, { isLoading }] = useCreateHolidayPlanMutation();
  const [updateHolidayPlan, { isLoading: isUpdating }] =
    useUpdateHolidayPlanMutation();
  const [syncEmployees] = useSyncHolidayPlanEmployeesMutation();
  const [bulkAssignEmployees] = useBulkAssignHolidayPlanEmployeesMutation();
  const [fetchEmployees] = useLazyGetEmployeesQuery();

  const buOptions = useMemo<Option[]>(
    () => busData.map((bu) => ({ label: bu.business_unit_name, value: bu.id })),
    [busData],
  );
  const deptOptions = useMemo<Option[]>(() => {
    const filtered =
      values.businessUnitIds.length > 0
        ? deptsData.filter((d) =>
            d.businessUnits?.some((buId) =>
              values.businessUnitIds.includes(buId),
            ),
          )
        : deptsData;
    return filtered.map((d) => ({ label: deptLabel(d), value: d.id }));
  }, [deptsData, values.businessUnitIds]);

  useEffect(() => {
    if (buOptions.length === 1 && values.businessUnitIds.length === 0)
      setValues((v) => ({ ...v, businessUnitIds: [buOptions[0].value] }));
  }, [buOptions, values.businessUnitIds.length]);

  useEffect(() => {
    if (deptOptions.length === 1 && values.departmentIds.length === 0)
      setValues((v) => ({ ...v, departmentIds: [deptOptions[0].value] }));
  }, [deptOptions, values.departmentIds.length]);

  const isDirty =
    values.name.trim() !== "" ||
    values.businessUnitIds.length > 0 ||
    values.departmentIds.length > 0;
  const errors = validateStep1(values, deptsData, busData);
  const touch = (field: keyof Step1Values) =>
    setTouched((t) => ({ ...t, [field]: true }));
  const fieldError = (field: keyof Step1Values) =>
    touched[field] ? errors[field] : undefined;

  const handleCancel = () => {
    if (isDirty) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to leave?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: onCancel,
      });
    } else {
      onCancel();
    }
  };

  const sortedEq = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  };

  /** When the user navigated back to step 1 and edited fields, persist them
   *  (PUT /holiday-plans/:id) and re-sync employees if BU/dept changed so
   *  out-of-scope employees are unassigned. Returns true on success. */
  const persistExistingPlanChanges = async (): Promise<boolean> => {
    if (!alreadyCreatedPlanId || !currentPlanData) return true;

    const days = Number(values.reminderDays);
    const oldBuIds = (currentPlanData.business_units ?? []).map(
      (bu: any) => bu.id ?? bu._id ?? bu,
    ) as string[];
    const oldDeptIds = (currentPlanData.departments ?? []).map(
      (d: any) => d.id ?? d._id ?? d,
    ) as string[];
    const newBuIds = values.businessUnitIds;
    const newDeptIds = values.departmentIds;

    const buChanged = !sortedEq(oldBuIds, newBuIds);
    const deptChanged = !sortedEq(oldDeptIds, newDeptIds);
    const nameChanged = (currentPlanData.name ?? "") !== values.name.trim();
    const yearChanged = (currentPlanData.year ?? 0) !== Number(values.year);
    const oldDays = currentPlanData.reminder_settings?.days_before ?? 0;
    const reminderChanged = oldDays !== days;
    const notifyChanged =
      (currentPlanData.notify_employees ?? null) !== values.notifyEmployees;
    const reprocessChanged =
      (currentPlanData.reprocess_leaves ?? null) !== values.reprocessLeaves;

    if (
      !buChanged &&
      !deptChanged &&
      !nameChanged &&
      !yearChanged &&
      !reminderChanged &&
      !notifyChanged &&
      !reprocessChanged
    ) {
      return true;
    }

    try {
      await updateHolidayPlan({
        id: alreadyCreatedPlanId,
        body: {
          name: values.name.trim(),
          year: Number(values.year),
          business_unit_ids: newBuIds,
          department_ids: newDeptIds,
          reminder_settings: { enabled: days > 0, days_before: days },
          notify_employees: values.notifyEmployees,
          reprocess_leaves: values.reprocessLeaves,
        },
      }).unwrap();
    } catch (err) {
      toast.error(err, "Failed to update plan");
      return false;
    }

    // If BU/dept changed, unassign any currently-assigned employees who are
    // no longer in the new scope.
    if ((buChanged || deptChanged) && currentAssignedUserIds.length > 0) {
      setIsResyncing(true);
      try {
        const inScope: EmployeeResponse[] = [];
        let skip = 0;
        const PAGE = 100;
        while (true) {
          const batch = await fetchEmployees({
            business_unit_ids: newBuIds,
            department_ids: newDeptIds,
            is_active: true,
            limit: PAGE,
            skip,
          }).unwrap();
          inScope.push(...batch);
          if (batch.length < PAGE) break;
          skip += PAGE;
          if (skip >= 10000) break;
        }
        const inScopeUserIds = new Set(
          inScope
            .map((e) => e.userId ?? e.user_id ?? e.id)
            .filter(Boolean) as string[],
        );
        const toKeep = currentAssignedUserIds.filter((uid) =>
          inScopeUserIds.has(uid),
        );
        const dropped = currentAssignedUserIds.length - toKeep.length;
        if (dropped > 0) {
          await syncEmployees({
            planId: alreadyCreatedPlanId,
            body: { user_ids: toKeep },
          }).unwrap();
          toast.success(
            `Plan updated — ${dropped} employee${dropped !== 1 ? "s" : ""} unassigned (out of scope after BU/department changes)`,
          );
        } else {
          toast.success("Plan updated");
        }
      } catch (err) {
        toast.error(
          err,
          "Plan updated but employee re-sync failed — review step 4",
        );
      } finally {
        setIsResyncing(false);
      }
    } else {
      toast.success("Plan updated");
    }
    return true;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({
      name: true,
      year: true,
      businessUnitIds: true,
      departmentIds: true,
    });
    if (Object.keys(errors).length > 0) {
      toast.error("Please fill all required fields");
      requestAnimationFrame(() => scrollToError());
      return;
    }
    // If the plan was already created and the user navigated back, persist
    // any edits (name/year/BU/dept/reminder/etc.) and re-sync employees if
    // BU/dept changed — otherwise removing a dept here would silently leave
    // the now-out-of-scope employees assigned to the plan.
    if (alreadyCreatedPlanId) {
      (async () => {
        const ok = await persistExistingPlanChanges();
        if (ok) onAdvanceWithoutCreate();
      })();
      return;
    }
    confirm({
      title: "Create Holiday Plan?",
      description: `Are you sure you want to create "${values.name.trim()}"?`,
      confirmText: "Create",
      onConfirm: async () => {
        try {
          const days = Number(values.reminderDays);
          const plan = await createHolidayPlan({
            name: values.name.trim(),
            year: Number(values.year),
            business_unit_ids: values.businessUnitIds,
            department_ids: values.departmentIds,
            reminder_settings: { enabled: days > 0, days_before: days },
            notify_employees: values.notifyEmployees,
            reprocess_leaves: values.reprocessLeaves,
          }).unwrap();
          const planId = plan._id ?? (plan as any).id;

          if (planId && values.assignmentMode === "auto") {
            setIsAssigning(true);
            try {
              const allEmployees: EmployeeResponse[] = [];
              let skip = 0;
              const PAGE = 100;
              while (true) {
                const batch = await fetchEmployees({
                  department_ids: values.departmentIds,
                  business_unit_ids: values.businessUnitIds,
                  is_active: true,
                  limit: PAGE,
                  skip,
                }).unwrap();
                allEmployees.push(...batch);
                if (batch.length < PAGE) break;
                skip += PAGE;
              }
              const userIds = allEmployees
                .map((e) => e.userId ?? e.user_id ?? e.id)
                .filter(Boolean) as string[];
              if (userIds.length === 0) {
                toast.success(
                  "Plan created — no active employees found in the selected business units / departments",
                );
              } else {
                // bulkAssign skips employees already on another holiday plan
                // instead of stealing them. Report what was added vs blocked
                // using the count we actually submitted, so the user always
                // knows why some were skipped.
                const r = await bulkAssignEmployees({
                  planId,
                  user_ids: userIds,
                }).unwrap();
                const submitted = userIds.length;
                const added = r.added ?? 0;
                const blocked = submitted - added;
                if (added === submitted) {
                  toast.success(
                    `Plan created — ${added} employee${added !== 1 ? "s" : ""} assigned`,
                  );
                } else if (added > 0) {
                  toast.success(
                    `Plan created — ${added} assigned, ${blocked} skipped (already linked to another holiday plan)`,
                  );
                } else {
                  toast.error(
                    `Plan created — 0 assigned. All ${blocked} employee${blocked !== 1 ? "s are" : " is"} already linked to another holiday plan. Use step 4 to review.`,
                  );
                }
              }
            } catch (err) {
              const msg =
                (err as any)?.data?.detail ||
                (err as any)?.message ||
                "Unknown error";
              toast.error(`Auto-assign failed: ${msg}`);
              toast.success(
                "Plan created — assign employees manually in step 4",
              );
            } finally {
              setIsAssigning(false);
            }
          } else {
            toast.success("Plan created");
          }

          onCreated(planId);
        } catch (err) {
          toast.error(err, "Failed to create holiday plan");
        }
      },
    });
  };

  if (isAssigning)
    return (
      <FullScreenLoader message="Assigning employees… Please wait — do not close or click away." />
    );
  if (isResyncing)
    return (
      <FullScreenLoader message="Updating employee assignments… Please wait — do not close or click away." />
    );

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Basic Details</h3>
            <p className="text-sm text-muted-foreground">
              Name and year for this plan.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <Field data-invalid={!!fieldError("name")}>
              <FieldLabel>
                Plan Name <span className="text-destructive">*</span>
              </FieldLabel>
              <Input
                value={values.name}
                placeholder="e.g., India Holiday Plan 2026"
                aria-invalid={!!fieldError("name")}
                onChange={(e) =>
                  setValues((v) => ({ ...v, name: e.target.value }))
                }
                onBlur={() => touch("name")}
              />
              {fieldError("name") && (
                <FieldError errors={[{ message: fieldError("name") }]} />
              )}
            </Field>
            <Field data-invalid={!!fieldError("year")}>
              <FieldLabel>
                Year <span className="text-destructive">*</span>
              </FieldLabel>
              <Select
                value={values.year}
                onValueChange={(val) => {
                  setValues((v) => ({ ...v, year: val }));
                  touch("year");
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-invalid={!!fieldError("year")}
                >
                  <SelectValue placeholder="Select year" />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldError("year") && (
                <FieldError errors={[{ message: fieldError("year") }]} />
              )}
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Assignment</h3>
            <p className="text-sm text-muted-foreground">
              Select which business units and departments this plan applies to.
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
                const valsArr = vals as string[];
                const validDeptIds = deptsData
                  .filter((d) =>
                    d.businessUnits?.some((buId) => valsArr.includes(buId)),
                  )
                  .map((d) => d.id);
                setValues((v) => ({
                  ...v,
                  businessUnitIds: valsArr,
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
                setValues((v) => ({ ...v, departmentIds: vals as string[] }));
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
          {values.departmentIds.length > 0 && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  Initial Employee Assignment
                </span>
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
                  htmlFor="hp-assign-manual"
                  className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem
                    value="manual"
                    id="hp-assign-manual"
                    className="mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <UserX className="size-3.5" /> Pick employees in step 4
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      You'll choose employees individually in the last step.
                    </p>
                  </div>
                </label>
                <label
                  htmlFor="hp-assign-auto"
                  className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem
                    value="auto"
                    id="hp-assign-auto"
                    className="mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <UserCheck className="size-3.5" /> Auto-assign all in
                      scope now
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      All active employees in the selected BUs/departments are
                      assigned automatically.
                    </p>
                  </div>
                </label>
              </RadioGroup>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 pt-2">
          <div>
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
              onChange={(val) =>
                setValues((v) => ({ ...v, reminderDays: val as string }))
              }
              placeholder="Select reminder"
              searchable={false}
            />
          </Field>
          <div className="space-y-4">
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

      <div className="flex justify-between gap-3">
        <Button type="button" variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="soft"
          disabled={isLoading || isUpdating || isResyncing}
        >
          {isLoading || isUpdating || isResyncing
            ? "Saving…"
            : "Save & Continue"}{" "}
          <ChevronRight />
        </Button>
      </div>
    </form>
  );
}

// ─── Step 2: Classifications ────────────────────────────────────────────────

function Step2Classifications({
  classifications,
  onBack,
  onNext,
  onExit,
}: {
  classifications: ClassificationResponse[];
  onBack: () => void;
  onNext: () => void;
  onExit: () => void;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="space-y-1 border-b pb-4">
            <h3 className="text-base font-semibold">Holiday Classifications</h3>
            <p className="text-sm text-muted-foreground">
              Define the categories you'll tag holidays with (e.g. National,
              Regional, Optional). At least one is required to add holidays.
            </p>
          </div>
          <ClassificationsForm classifications={classifications} />
        </CardContent>
      </Card>

      <StepFooter
        onBack={onBack}
        onExit={onExit}
        onNext={onNext}
        nextLabel="Next: Holidays"
        nextDisabled={classifications.length === 0}
      />
    </div>
  );
}

function ClassificationsForm({
  classifications,
}: {
  classifications: ClassificationResponse[];
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6F5CFF");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");

  const [createClassification, { isLoading: isCreating }] =
    useCreateClassificationMutation();
  const [updateClassification] = useUpdateClassificationMutation();

  const norm = (c: string) => c.trim().toLowerCase();

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      toast.error("Classification name is required");
      return;
    }
    if (classifications.some((c) => norm(c.color) === norm(newColor))) {
      toast.error(
        "A classification with this color already exists. Pick a different color.",
      );
      return;
    }
    try {
      await createClassification({ name: trimmed, color: newColor }).unwrap();
      setNewName("");
      setNewColor("#6F5CFF");
      toast.success("Classification added");
    } catch (err) {
      toast.error(err, "Failed to add classification");
    }
  };

  const startEdit = (c: ClassificationResponse) => {
    setEditId(c.id ?? c._id);
    setEditName(c.name);
    setEditColor(c.color);
  };

  const handleSave = async () => {
    if (!editId) return;
    if (!editName.trim()) {
      toast.error("Classification name is required");
      return;
    }
    if (
      classifications.some(
        (c) => (c.id ?? c._id) !== editId && norm(c.color) === norm(editColor),
      )
    ) {
      toast.error(
        "Another classification already uses this color. Pick a different color.",
      );
      return;
    }
    try {
      await updateClassification({
        id: editId,
        body: { name: editName.trim(), color: editColor },
      }).unwrap();
      setEditId(null);
      toast.success("Classification updated");
    } catch (err) {
      toast.error(err, "Failed to update classification");
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {classifications.map((c) => (
          <div key={c.id ?? c._id} className="flex items-center gap-3">
            {editId === (c.id ?? c._id) ? (
              <>
                <ColorPicker value={editColor} onChange={setEditColor} />
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-9 text-sm flex-1"
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                />
                <Button size="sm" onClick={handleSave}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditId(null)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <div
                  className="size-5 rounded-sm border border-border/50 shrink-0"
                  style={{ backgroundColor: c.color }}
                />
                <span className="text-sm font-medium flex-1">{c.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => startEdit(c)}
                >
                  <Edit2 className="size-3.5" />
                </Button>
              </>
            )}
          </div>
        ))}
        {classifications.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">
            No classifications yet. Add one below to continue.
          </p>
        )}
      </div>
      <div className="border-t border-border pt-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Add Classification
        </p>
        <div className="flex items-center gap-3">
          <ColorPicker value={newColor} onChange={setNewColor} />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g., National, Regional, Optional"
            className="h-9 text-sm flex-1"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={!newName.trim() || isCreating}
          >
            <Plus /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Holidays ───────────────────────────────────────────────────────

function Step3Holidays({
  planId,
  planData,
  classifications,
  holidays,
  onBack,
  onNext,
  onExit,
}: {
  planId: string;
  planData: any;
  classifications: ClassificationResponse[];
  holidays: any[];
  onBack: () => void;
  onNext: () => void;
  onExit: () => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const [triggerDownloadTemplate] = useLazyDownloadHolidayBulkTemplateQuery();
  const [validateBulkUpload] = useValidateHolidayBulkUploadMutation();
  const [bulkImportHolidays] = useBulkImportHolidaysFromFileMutation();
  const [deleteHoliday] = useDeleteHolidayMutation();

  if (showImport) {
    return (
      <ImportHolidaysFromPlan
        targetPlanId={planId}
        targetPlanYear={planData.year}
        onClose={() => setShowImport(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="flex items-start justify-between gap-3 border-b pb-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Add Holidays</h3>
              <p className="text-sm text-muted-foreground">
                Add the holidays observed by this plan. At least one is
                required.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowImport(true)}
              >
                <Copy /> Import from another plan
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBulkOpen(true)}
              >
                <Upload /> Bulk upload
              </Button>
            </div>
          </div>

          <AddHolidayInlineForm
            planId={planId}
            planData={planData}
            classifications={classifications}
          />

          <div className="space-y-2 pt-2">
            <p className="text-xs font-medium text-muted-foreground">
              {holidays.length} holiday{holidays.length === 1 ? "" : "s"} added
            </p>
            {holidays.length > 0 && (
              <div className="rounded-xl border divide-y">
                {holidays.map((h) => (
                  <div
                    key={h._id}
                    className="flex items-center justify-between px-4 py-2.5"
                  >
                    <div className="flex items-center gap-3">
                      <CalendarIcon className="size-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{h.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {h.date}
                        </p>
                      </div>
                      {h.classification?.name && (
                        <Badge
                          className="border-0 ml-2"
                          style={{
                            backgroundColor: `${h.classification.color}18`,
                            color: h.classification.color,
                          }}
                        >
                          {h.classification.name}
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() =>
                        deleteHoliday(h._id)
                          .unwrap()
                          .then(() => toast.success("Holiday removed"))
                          .catch((err) => toast.error(err, "Failed to remove"))
                      }
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <StepFooter
        onBack={onBack}
        onExit={onExit}
        onNext={onNext}
        nextLabel="Next: Manage Employees"
        nextDisabled={holidays.length === 0}
      />

      <BulkUploadHolidaysDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        planYear={planData?.year}
        onDownloadTemplate={async () => {
          try {
            const { data: blob } = await triggerDownloadTemplate(planId);
            if (blob) {
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "holiday-bulk-template.xlsx";
              a.click();
              URL.revokeObjectURL(url);
            }
          } catch (err) {
            toast.error(err, "Failed to download template");
          }
        }}
        onValidate={async (file) =>
          await validateBulkUpload({ planId, file }).unwrap()
        }
        onImport={async (rows) => {
          const res = await bulkImportHolidays({
            planId,
            holidays: rows,
          }).unwrap();
          return { imported: res.imported, skipped: res.skipped };
        }}
        entityName="holiday plan"
      />
    </div>
  );
}

function AddHolidayInlineForm({
  planId,
  planData,
  classifications,
}: {
  planId: string;
  planData: any;
  classifications: ClassificationResponse[];
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState<Date | undefined>();
  const [classificationId, setClassificationId] = useState("");
  const [description, setDescription] = useState("");
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [createHoliday, { isLoading }] = useCreateHolidayMutation();

  const planBuIds = useMemo(
    () =>
      (planData.business_units ?? []).map(
        (bu: any) => bu.id ?? bu._id ?? bu,
      ) as string[],
    [planData.business_units],
  );
  const planDeptIds = useMemo(
    () =>
      (planData.departments ?? []).map(
        (d: any) => d.id ?? d._id ?? d,
      ) as string[],
    [planData.departments],
  );

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dateLabel = date
    ? date
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
        .replace(/ /g, "-")
    : "Pick a date";

  const handleAdd = async () => {
    if (!name.trim()) {
      toast.error("Holiday name is required");
      return;
    }
    if (!date) {
      toast.error("Date is required");
      return;
    }
    if (!classificationId) {
      toast.error("Classification is required");
      return;
    }
    try {
      await createHoliday({
        plan_id: planId,
        name: name.trim(),
        date: fmtDate(date),
        classification_id: classificationId,
        business_unit_ids: planBuIds,
        applicable_department_ids: planDeptIds,
        description: description.trim() || null,
      }).unwrap();
      setName("");
      setDate(undefined);
      setDescription("");
      toast.success("Holiday added");
    } catch (err) {
      toast.error(err, "Failed to add holiday");
    }
  };

  return (
    <div className="rounded-xl border bg-muted/30 p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field>
          <FieldLabel>
            Holiday Name <span className="text-destructive">*</span>
          </FieldLabel>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Independence Day"
            className="h-9 bg-card"
          />
        </Field>
        <Field>
          <FieldLabel>
            Date <span className="text-destructive">*</span>
          </FieldLabel>
          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="h-9 w-full justify-start font-normal bg-card"
              >
                <CalendarIcon className="text-muted-foreground" />
                <span className={date ? "" : "text-muted-foreground"}>
                  {dateLabel}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={date}
                onSelect={(d) => {
                  setDate(d);
                  setDatePickerOpen(false);
                }}
                {...(planData.year
                  ? {
                      fromMonth: new Date(planData.year, 0, 1),
                      toMonth: new Date(planData.year, 11, 31),
                      defaultMonth: new Date(planData.year, 0, 1),
                    }
                  : {})}
              />
            </PopoverContent>
          </Popover>
        </Field>
        <Field>
          <FieldLabel>
            Classification <span className="text-destructive">*</span>
          </FieldLabel>
          <Select value={classificationId} onValueChange={setClassificationId}>
            <SelectTrigger className="w-full h-9 bg-card">
              <SelectValue placeholder="Select classification" />
            </SelectTrigger>
            <SelectContent>
              {classifications.map((c) => (
                <SelectItem key={c.id ?? c._id} value={c.id ?? c._id}>
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                    {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel>Description (optional)</FieldLabel>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description"
          className="h-9 bg-card"
        />
      </Field>
      <div className="flex justify-end pt-1 border-t">
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={isLoading || !name.trim() || !date || !classificationId}
          className="mt-3"
        >
          Add Holiday
        </Button>
      </div>
    </div>
  );
}

// ─── Step 4: Manage Employees ───────────────────────────────────────────────

function Step4Employees({
  planData,
  assignedCount,
  onBack,
  onFinish,
  onExit,
  onExitNoConfirm,
}: {
  planData: any;
  assignedCount: number;
  onBack: () => void;
  onFinish: () => void;
  onExit: () => void;
  onExitNoConfirm: () => void;
}) {
  const confirm = useConfirm();
  const innerRef = useRef<AddEmployeesToPlanHandle>(null);
  const [hasChanges, setHasChanges] = useState(false);

  const handleFinish = async () => {
    if (hasChanges) {
      // triggerSave will call onSaved on success → which is onFinish.
      await innerRef.current?.triggerSave();
      return;
    }
    if (assignedCount === 0) {
      confirm({
        title: "Finish without assigning employees?",
        description:
          "No employees are assigned to this plan. You can add them later from the Holiday Calendar using Manage Employees.",
        confirmText: "Finish anyway",
        onConfirm: onFinish,
      });
      return;
    }
    onFinish();
  };

  const finishLabel = hasChanges
    ? "Save & Finish"
    : assignedCount === 0
      ? "Finish without employees"
      : "Finish Setup";

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-2">
          <div className="space-y-1 border-b pb-4 mb-4">
            <h3 className="text-base font-semibold">Assign Employees</h3>
            <p className="text-sm text-muted-foreground">
              Pick the employees this plan applies to. You can also finish
              without any and add them later.
            </p>
          </div>
          <AddEmployeesToPlan
            ref={innerRef}
            planData={planData}
            onClose={onExitNoConfirm}
            wizardMode
            onSaved={onFinish}
            onHasChangesChange={setHasChanges}
          />
        </CardContent>
      </Card>

      {assignedCount === 0 && !hasChanges && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-badge-pending-bg px-4 py-3">
          <span className="text-sm text-foreground">
            No employees assigned. If all eligible employees are already on
            another plan, finish here and add them later from the Holiday
            Calendar.
          </span>
        </div>
      )}

      <StepFooter
        onBack={onBack}
        onExit={onExit}
        onNext={handleFinish}
        nextLabel={finishLabel}
        nextDisabled={false}
      />
    </div>
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function StepFooter({
  onBack,
  onExit,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  onBack: () => void;
  onExit: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onExit}>
          Save &amp; Exit
        </Button>
        <Button variant="outline" onClick={onBack}>
          <ChevronLeft /> Back
        </Button>
      </div>
      <Button variant="soft" onClick={onNext} disabled={nextDisabled}>
        {nextLabel} <ChevronRight />
      </Button>
    </div>
  );
}
