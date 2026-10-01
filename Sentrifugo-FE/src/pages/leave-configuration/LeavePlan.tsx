import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Search,
  Edit2,
  Power,
  Plus,
  FileText,
  CheckCircle2,
  Circle,
  Upload,
  X,
  Check,
  Users,
  Lock,
  PowerOff,
} from "lucide-react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Stepper } from "@/components/ui/stepper";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import {
  useGetLeavePlansQuery,
  useGetLeavePlanQuery,
  useCreateLeavePlanMutation,
  useUpdateLeavePlanMutation,
  useActivateLeavePlanMutation,
  useDeactivateLeavePlanMutation,
  useUploadAssetMutation,
  useGetAssetQuery,
  useLazyGetAssetDownloadUrlQuery,
  useCreateLeavePlanAssignmentMutation,
  useGetToggleConfigQuery,
} from "@/store/api/lmsApi";
import { ToggleConfigContext, type ToggleKey } from "@/hooks/use-toggle-config";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { PageHeader } from "@/components/shared/PageHeader";
import type { LeavePlanResponse } from "@/types/leave";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
} from "@/store/api/iamApi";
import { PageLoader } from "@/components/shared/PageLoader";
import { useAppSelector, useAppDispatch } from "@/store"
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import { deptLabel, cn } from "@/lib/utils";
import LeavePlanLeaveTypes from "./LeavePlanLeaveTypes";
import LeaveEntitlementForm, {
  type LeaveEntitlementFormHandle,
} from "./leave-entitlement/LeaveEntitlementForm";
import LeavePlanSandwichApproval, {
  type LeavePlanSandwichApprovalHandle,
} from "./LeavePlanSandwichApproval";
import LeavePlanYearEnd, {
  type LeavePlanYearEndHandle,
} from "./LeavePlanYearEnd";
import LeavePlanOverview from "./LeavePlanOverview";
import { Field, FieldLabel } from "@/components/ui/field";
import { toast } from "@/lib/toast";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";

const ACTIVATION_ERROR_MESSAGES: Record<string, string> = {
  MISSING_GRANT_POLICY:        "Please configure the grant policy before activating.",
  MISSING_ENTITLEMENT_CONFIG:  "Please set up the entitlement configuration before activating.",
  MISSING_SANDWICH_POLICY:     "Please configure the sandwich policy before activating.",
  MISSING_APPROVAL_POLICY:     "Please configure the approval policy before activating.",
  MISSING_YEAR_END_POLICY:     "Please configure the year-end processing policy before activating.",
}

function getActivationErrorMessage(err: any): string {
  const code: string | undefined = err?.data?.code
  if (!code) return "Failed to activate the leave plan. Please try again."
  if (code in ACTIVATION_ERROR_MESSAGES) return ACTIVATION_ERROR_MESSAGES[code]
  if (code === "BU_CONFLICT_ON_ACTIVATION") {
    const detail = err?.data?.message ? ` ${err.data.message}` : ""
    return `One or more business units are already assigned to an active plan.${detail}`
  }
  if (code === "DEPARTMENT_CONFLICT_ON_ACTIVATION") {
    const detail = err?.data?.message ? ` ${err.data.message}` : ""
    return `One or more departments are already assigned to an active plan.${detail}`
  }
  return err?.data?.message ?? "Failed to activate the leave plan. Please try again."
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthNumberToName = (month?: number) =>
  month && month >= 1 && month <= 12 ? MONTH_NAMES[month - 1] : "January";
const monthNameToNumber = (name: string) => {
  const i = MONTH_NAMES.indexOf(name);
  return i >= 0 ? i + 1 : 1;
};

const STEPS = [
  { id: 0, label: "Create Leave Plan" },
  { id: 1, label: "Assign Leave Types" },
  { id: 2, label: "Entitlement Configuration" },
  { id: 3, label: "Sandwich & Approval Configuration" },
  { id: 4, label: "Year End Leave Processing Overview" },
  { id: 5, label: "Overview & Summary" },
];

const planColHelper = createColumnHelper<{
  id: string;
  _id: string;
  name: string;
  start: string;
  businessUnits: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  status: string;
  is_active: boolean;
  calendar_start_month?: number;
  progress: number;
}>();

export default function LeavePlan() {
  const search = useSearch({ strict: false }) as {
    planId?: string;
    step?: number;
  };
  const navigate = useNavigate();
  const planIdFromUrl = search.planId;
  const stepFromUrl = typeof search.step === "number" ? search.step : 0;

  const confirm = useConfirm();
  const dispatch = useAppDispatch();

  const orgId = useAppSelector((s) => s.auth.user?.organisation_id ?? "");
  const { data: busData } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptsData } = useGetDepartmentsQuery({ is_active: true });
  const { data: leavePlansRaw, isLoading } = useGetLeavePlansQuery(orgId, {
    skip: !orgId,
  });
  const [createPlan, createResult] = useCreateLeavePlanMutation();
  const [updatePlan, updateResult] = useUpdateLeavePlanMutation();
  const [activatePlanFromList, activateFromListResult] = useActivateLeavePlanMutation();
  const [deactivatePlan] = useDeactivateLeavePlanMutation();
  const [activateDialogItem, setActivateDialogItem] = useState<{ id: string; name: string } | null>(null);

  const data = useMemo(() => {
    const plans = Array.isArray(leavePlansRaw) ? leavePlansRaw : [];
    return plans.map((p: LeavePlanResponse) => ({
      id: p._id,
      _id: p._id,
      name: p.name,
      start: monthNumberToName(p.calendar_start_month),
      businessUnits: p.business_units ?? [],
      departments: p.departments ?? [],
      status: p.status ?? (p.is_active ? "active" : "pending_configuration"),
      is_active: p.is_active ?? false,
      calendar_start_month: p.calendar_start_month,
      progress: p.progress ?? 0,
    }));
  }, [leavePlansRaw]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openStepper = (item: any) => {
    const progress: number = item?.progress ?? 0;
    dispatch(setBreadcrumbDetail(item?.name ?? 'New Leave Plan'));
    navigate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      to: "/leave-configuration/leave-plan" as any,
      search: {
        planId: item?._id ?? "new",
        step: Math.min(progress, STEPS.length - 1),
      } as any,
    });
  };

  const handleBackToList = () => {
    dispatch(setBreadcrumbDetail(null));
    navigate({
      to: "/leave-configuration/leave-plan" as any,
      search: {} as any,
    });
  };

  const handleConfirmActivate = async () => {
    if (!activateDialogItem) return;
    try {
      await activatePlanFromList(activateDialogItem.id).unwrap();
      toast.success("Leave plan activated successfully.");
      setActivateDialogItem(null);
    } catch (err) {
      toast.error(getActivationErrorMessage(err));
    }
  };

  const handleDeactivate = (item: { id: string; name: string }) => {
    confirm({
      title: `Deactivate "${item.name}"?`,
      description:
        "This will deactivate the leave plan. Employees currently on this plan may be affected.",
      variant: "destructive",
      confirmText: "Deactivate",
      onConfirm: async () => { await deactivatePlan(item.id).unwrap(); },
    });
  };

  if (planIdFromUrl !== undefined) {
    return (
      <StepperView
        planIdParam={planIdFromUrl}
        initialStep={stepFromUrl}
        onBack={handleBackToList}
        orgId={orgId}
        busData={busData}
        deptsData={deptsData}
        createPlan={createPlan}
        updatePlan={updatePlan}
        createResult={createResult}
        updateResult={updateResult}
        navigate={navigate}
      />
    );
  }

  return (
    <>
    <ListView
      data={data}
      isLoading={isLoading}
      busData={busData}
      deptsData={deptsData}
      onEdit={(item: { _id: string; progress: number }) => openStepper(item)}
      onAdd={() => openStepper(null)}
      onActivate={(item: { id: string; name: string }) => setActivateDialogItem(item)}
      onDeactivate={(item: { id: string; name: string }) => handleDeactivate(item)}
    />

    <Dialog open={!!activateDialogItem} onOpenChange={(open) => { if (!open) setActivateDialogItem(null) }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-warning shrink-0" />
            <DialogTitle>Activate this leave plan?</DialogTitle>
          </div>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Activating the plan makes it live and assigns it to the configured
            business units and departments.
          </p>
          <p className="font-medium text-foreground">
            Once activated, you will not be able to make any configuration
            changes to this plan.
          </p>
          <p>
            Choose <span className="font-medium">Keep as Pending</span> if you
            still need to make changes before going live.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setActivateDialogItem(null)} disabled={activateFromListResult.isLoading}>
            Keep as Pending
          </Button>
          <Button variant="soft" onClick={handleConfirmActivate} disabled={activateFromListResult.isLoading}>
            {activateFromListResult.isLoading ? "Activating…" : "Activate Plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

// ─── Stepper ──────────────────────────────────────────────────────────────────

function StepperView({
  planIdParam,
  initialStep,
  onBack,
  orgId,
  busData,
  deptsData,
  createPlan,
  updatePlan,
  createResult,
  updateResult,
  navigate,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}: any) {
  const isNew = planIdParam === "new";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isLast = initialStep === STEPS.length - 1; // computed from live activeStep below

  const stepperDispatch = useAppDispatch();

  const { data: fetchedPlan } = useGetLeavePlanQuery(planIdParam, {
    skip: isNew || !planIdParam,
  });

  const { data: toggleConfigData } = useGetToggleConfigQuery(planIdParam, {
    skip: isNew || !planIdParam,
  });

  const toggleContextValue = useMemo(() => ({
    config: toggleConfigData ?? null,
    isToggleOn: (key: ToggleKey) => toggleConfigData?.[key] ?? false,
  }), [toggleConfigData]);

  const entitlementFormRef = useRef<LeaveEntitlementFormHandle>(null);
  const sandwichFormRef = useRef<LeavePlanSandwichApprovalHandle>(null);
  const yearEndFormRef = useRef<LeavePlanYearEndHandle>(null);

  const [activeStep, setActiveStep] = useState<number>(initialStep);
  const [planId, setPlanId] = useState<string | undefined>(
    isNew ? undefined : planIdParam,
  );
  const [planName, setPlanName] = useState<string>("");
  const [planStart, setPlanStart] = useState<string>("January");
  const [planAssetIds, setPlanAssetIds] = useState<string[]>([]);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(
    new Set(Array.from({ length: initialStep }, (_, i) => i)),
  );

  const [assignmentBuIds, setAssignmentBuIds] = useState<string[]>([]);
  const [assignmentDeptIds, setAssignmentDeptIds] = useState<string[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [createAssignment] = useCreateLeavePlanAssignmentMutation();
  const [uploadAsset] = useUploadAssetMutation();
  const [activatePlan, activateResult] = useActivateLeavePlanMutation();

  const isPlanActive = !isNew && fetchedPlan?.is_active === true;
  const isLastStep = activeStep === STEPS.length - 1;
  const isSavingPlan = createResult.isLoading || updateResult.isLoading || activateResult.isLoading;
  const [showActivateDialog, setShowActivateDialog] = useState(false);
  const [showStep0Errors, setShowStep0Errors] = useState(false);
  const [stepDirty, setStepDirty] = useState(false);
  const confirm = useConfirm();

  // Step 1 (Create Leave Plan) requires a name plus at least one business unit
  // and one department. Mirrors the backend's LeavePlanCreate validation.
  const step0Valid =
    planName.trim().length > 0 &&
    assignmentBuIds.length > 0 &&
    assignmentDeptIds.length > 0;

  // Active step changed → the previous step's form unmounted, so any dirty
  // state it reported belongs to a component that no longer exists.
  useEffect(() => { setStepDirty(false) }, [activeStep]);

  // Plan-active mode locks editing — never treat it as dirty.
  const effectiveDirty = !isPlanActive && stepDirty;
  // Switching steps stays on the same plan (same pathname + same planId, only
  // the `step` search param changes) — those are guarded by the wizard's own
  // discard confirm, so the page-level guard must ignore them. Leaving the plan
  // (Back to List drops planId, or a different route) is still guarded.
  const releaseNavigationGuard = useNavigationGuard(
    effectiveDirty,
    ({ current, next }) =>
      current.pathname === next.pathname &&
      (current.search as { planId?: string })?.planId ===
        (next.search as { planId?: string })?.planId,
  );

  // Baseline snapshot of step-0 fields, used for dirty detection. Updated when
  // the plan is freshly loaded and when step 0 is successfully saved.
  const step0BaselineRef = useRef<string>(JSON.stringify({
    name: "", start: "January", buIds: [], deptIds: [], assetIds: [] as string[],
  }));

  useEffect(() => {
    if (!fetchedPlan) return;
    stepperDispatch(setBreadcrumbDetail(fetchedPlan.name));
    setPlanName(fetchedPlan.name);
    setPlanStart(monthNumberToName(fetchedPlan.calendar_start_month));
    setPlanAssetIds(fetchedPlan.asset_ids ?? []);
    setAssignmentBuIds(fetchedPlan.business_unit_ids ?? []);
    setAssignmentDeptIds(fetchedPlan.department_ids ?? []);
    step0BaselineRef.current = JSON.stringify({
      name: fetchedPlan.name ?? "",
      start: monthNumberToName(fetchedPlan.calendar_start_month),
      buIds: fetchedPlan.business_unit_ids ?? [],
      deptIds: fetchedPlan.department_ids ?? [],
      assetIds: fetchedPlan.asset_ids ?? [],
    });
    const progress: number = fetchedPlan.progress ?? 0;
    setCompletedSteps(new Set(Array.from({ length: progress }, (_, i) => i)));
  }, [fetchedPlan]);

  // Step-0 dirty detection — compare current state to the baseline snapshot.
  useEffect(() => {
    if (activeStep !== 0) return;
    const current = JSON.stringify({
      name: planName ?? "",
      start: planStart,
      buIds: assignmentBuIds,
      deptIds: assignmentDeptIds,
      assetIds: planAssetIds,
    });
    const dirty = current !== step0BaselineRef.current || !!pendingFile;
    setStepDirty(dirty);
  }, [activeStep, planName, planStart, assignmentBuIds, assignmentDeptIds, planAssetIds, pendingFile]);

  const markComplete = (step: number) =>
    setCompletedSteps((prev) => new Set([...prev, step]));

  const syncUrl = (step: number, pid?: string) => {
    // Internal step navigation — the stepper's own goPrev/handleStepClick
    // already prompt for unsaved changes, so bypass the page-level navigation
    // guard. Otherwise the guard's blocker fires on this navigate() and a
    // spurious (or duplicate) "Discard / Stay" dialog pops up mid-stepper.
    releaseNavigationGuard();
    navigate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      to: "/leave-configuration/leave-plan" as any,
      search: { planId: pid ?? planId ?? planIdParam, step },
      replace: true,
    });
  };

  const goNext = async () => {
    if (isPlanActive) {
      if (isLastStep) {
        releaseNavigationGuard();
        onBack();
      } else {
        const newStep = activeStep + 1;
        setActiveStep(newStep);
        syncUrl(newStep);
      }
      return;
    }

    if (activeStep === 0 && !step0Valid) {
      setShowStep0Errors(true);
      toast.error("Enter a plan name and select at least one business unit and department.");
      return;
    }

    if (activeStep === 2) {
      const ok = await entitlementFormRef.current?.triggerSubmit();
      if (!ok) return;
    }
    if (activeStep === 3) {
      const ok = await sandwichFormRef.current?.triggerSubmit();
      if (!ok) return;
    }
    if (activeStep === 4) {
      const ok = await yearEndFormRef.current?.triggerSubmit();
      if (!ok) return;
    }

    const nextProgress = activeStep + 1;
    let currentPlanId = planId;
    try {
      if (activeStep === 0) {
        if (planId) {
          await updatePlan({
            id: planId,
            body: {
              name: planName,
              calendar_start_month: monthNameToNumber(planStart),
              asset_ids: planAssetIds,
              business_unit_ids: assignmentBuIds,
              department_ids: assignmentDeptIds,
              progress: nextProgress,
            },
          }).unwrap();
        } else {
          const result = await createPlan({
            org_id: orgId,
            name: planName,
            calendar_start_month: monthNameToNumber(planStart),
            asset_ids: planAssetIds,
            business_unit_ids: assignmentBuIds,
            department_ids: assignmentDeptIds,
          }).unwrap();
          currentPlanId = result._id;
          setPlanId(currentPlanId);
          toast.success("Leave plan created successfully.");

          await updatePlan({
            id: currentPlanId!,
            body: { progress: nextProgress },
          }).unwrap();
        }
        if (pendingFile && currentPlanId) {
          try {
            const asset = await uploadAsset(pendingFile).unwrap();
            const assetId = asset._id || asset.id;
            await updatePlan({ id: currentPlanId, body: { asset_ids: [assetId!] } }).unwrap();
            setPlanAssetIds([assetId!]);
            setPendingFile(null);
          } catch {
            toast.error('Failed to upload policy document');
          }
        }
        if (assignmentBuIds.length > 0) {
          for (const buId of assignmentBuIds) {
            const deptsForBu = assignmentDeptIds.filter((dId) => {
              const dept = deptsData?.find((d: any) => d.id === dId);
              return dept?.businessUnits?.includes(buId);
            });
            const isWholeBu = deptsForBu.length === 0;
            try {
              await createAssignment({
                leave_plan_id: currentPlanId!,
                scope_type: "BU",
                business_unit_id: buId,
                apply_to_whole_bu: isWholeBu,
                ...(isWholeBu ? {} : { department_ids: deptsForBu }),
                priority: 1,
              }).unwrap();
            } catch (err: any) {
              const errCode = err?.data?.code ?? err?.data?.error;
              if (errCode === 'INVALID_BUSINESS_UNIT') {
                // The LMS backend has no record of this BU (not synced to its
                // mirror), so it can't name it — build the message from the
                // BU list already loaded here instead of showing a raw id.
                const buName = busData?.find((b: any) => b.id === buId)?.business_unit_name;
                toast.error(
                  buName
                    ? `Business unit '${buName}' not found in leave management`
                    : err,
                  'Business unit not found',
                );
                throw err;
              }
              if (
                err?.status === 409 &&
                (errCode === 'DEPARTMENT_ALREADY_ASSIGNED' ||
                  err?.data?.message === 'DEPARTMENT_ALREADY_ASSIGNED')
              ) {
                toast.error('One or more departments are already assigned to another leave plan.');
                throw err;
              }
              if (err?.status !== 409) throw err;
            }
          }
        }
      } else if (planId) {
        await updatePlan({
          id: planId,
          body: { progress: nextProgress },
        }).unwrap();
      }
    } catch (err: any) {
      // Step forms surface their own validation/zod errors with toast.error
      // inside triggerSubmit. Anything that bubbles out here is the step-0
      // create/update, the assignment create, or the progress update — show
      // it so the user knows why Save & Continue silently stayed put. The
      // codes below already toasted a specific message before re-throwing,
      // so skip the generic toast for them to avoid double-toasting.
      const code = err?.data?.code ?? err?.data?.error ?? err?.data?.message;
      if (!["DEPARTMENT_ALREADY_ASSIGNED", "INVALID_BUSINESS_UNIT"].includes(code)) {
        toast.error(err, "Failed to save leave plan");
      }
      return;
    }

    markComplete(activeStep);
    if (activeStep === 0) {
      step0BaselineRef.current = JSON.stringify({
        name: planName ?? "",
        start: planStart,
        buIds: assignmentBuIds,
        deptIds: assignmentDeptIds,
        assetIds: planAssetIds,
      });
    }
    setStepDirty(false);
    if (isLastStep) {
      setShowActivateDialog(true);
    } else {
      const newStep = activeStep + 1;
      setActiveStep(newStep);
      syncUrl(newStep, currentPlanId);
    }
  };

  const handleKeepPending = () => {
    setShowActivateDialog(false);
    toast.success("Leave plan saved. You can activate it later.");
    releaseNavigationGuard();
    onBack();
  };

  const handleActivate = async () => {
    if (!planId) return;
    try {
      await activatePlan(planId).unwrap();
      setShowActivateDialog(false);
      toast.success("Leave plan activated successfully.");
      releaseNavigationGuard();
      onBack();
    } catch (err) {
      toast.error(getActivationErrorMessage(err));
    }
  };

  const goPrev = () => {
    if (activeStep > 0) {
      const proceed = () => {
        const newStep = activeStep - 1;
        setActiveStep(newStep);
        syncUrl(newStep);
      };
      if (effectiveDirty) {
        confirm({
          title: "Discard changes?",
          description: "You have unsaved changes on this step. Going back will discard them.",
          variant: "destructive",
          confirmText: "Discard",
          cancelText: "Stay",
          onConfirm: proceed,
        });
      } else {
        proceed();
      }
    } else {
      // useNavigationGuard already catches programmatic navigate calls when
      // dirty, so no extra prompt is needed here — releaseNavigationGuard
      // only fires for the "no unsaved changes" path.
      if (!effectiveDirty) releaseNavigationGuard();
      onBack();
    }
  };

  const handleStepClick = (id: number) => {
    if (id === activeStep) return;
    const proceed = () => {
      setActiveStep(id);
      syncUrl(id);
    };
    if (effectiveDirty) {
      confirm({
        title: "Discard changes?",
        description: "You have unsaved changes on this step. Switching steps will discard them.",
        variant: "destructive",
        confirmText: "Discard",
        cancelText: "Stay",
        onConfirm: proceed,
      });
    } else {
      proceed();
    }
  };

  return (
    <div className="flex flex-col min-h-full">
      {/* Horizontal stepper */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border px-4 sm:px-6 py-3">
        <Stepper
          steps={STEPS}
          current={activeStep}
          completed={completedSteps}
          onStepClick={handleStepClick}
        />
      </div>

      {/* Content */}
      <ToggleConfigContext.Provider value={toggleContextValue}>
      <div className="flex-1 p-4 sm:p-6 space-y-6">
        <PageHeader
          title={STEPS[activeStep].label}
          subtitle={stepDescription(activeStep)}
        />

        {isPlanActive && (
          <div className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/5 px-4 py-3 text-sm text-warning">
            <Lock className="size-4 shrink-0" />
            <span>This plan is active. Configuration is locked and cannot be modified.</span>
          </div>
        )}

        <fieldset disabled={isPlanActive} className="contents">
          {activeStep === 0 && (
            <PlanInfoStep
              planId={planId}
              pendingFile={pendingFile}
              setPendingFile={setPendingFile}
              name={planName}
              setName={setPlanName}
              start={planStart}
              setStart={setPlanStart}
              busData={busData}
              deptsData={deptsData}
              buIds={assignmentBuIds}
              setBuIds={setAssignmentBuIds}
              deptIds={assignmentDeptIds}
              setDeptIds={setAssignmentDeptIds}
              assetIds={planAssetIds}
              onAssetIdsChange={setPlanAssetIds}
              showErrors={showStep0Errors}
            />
          )}
          {activeStep === 1 && <LeavePlanLeaveTypes planId={planId} />}
          {activeStep === 2 && (
            <LeaveEntitlementForm ref={entitlementFormRef} planId={planId} onDirtyChange={setStepDirty} />
          )}
          {activeStep === 3 && (
            <LeavePlanSandwichApproval ref={sandwichFormRef} planId={planId} onDirtyChange={setStepDirty} />
          )}
          {activeStep === 4 && (
            <LeavePlanYearEnd ref={yearEndFormRef} planId={planId} onDirtyChange={setStepDirty} />
          )}
        </fieldset>
        {activeStep === 5 && <LeavePlanOverview planId={planId} />}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={goPrev} disabled={isSavingPlan}>
            {activeStep === 0 ? "Back to List" : "Back"}
          </Button>
          <div
            onClick={() => {
              if (!isSavingPlan) goNext();
            }}
          >
            <Button
              variant="soft"
              disabled={isSavingPlan}
            >
              {isSavingPlan
                ? "Saving…"
                : isLastStep
                  ? isPlanActive ? "Close" : "Finish"
                  : isPlanActive ? "Next" : "Save & Continue"}
            </Button>
          </div>
        </div>
      </div>
      </ToggleConfigContext.Provider>

      {/* Activation confirmation dialog */}
      <Dialog open={showActivateDialog} onOpenChange={setShowActivateDialog}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-5 text-warning shrink-0" />
              <DialogTitle>Activate this leave plan?</DialogTitle>
            </div>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Activating the plan makes it live and assigns it to the configured
              business units and departments.
            </p>
            <p className="font-medium text-foreground">
              Once activated, you will not be able to make any configuration
              changes to this plan.
            </p>
            <p>
              Choose <span className="font-medium">Keep as Pending</span> if you
              still need to make changes before going live.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleKeepPending} disabled={activateResult.isLoading}>
              Keep as Pending
            </Button>
            <Button variant="soft" onClick={handleActivate} disabled={activateResult.isLoading}>
              {activateResult.isLoading ? "Activating…" : "Activate Plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function stepDescription(step: number) {
  return [
    "Set the plan name, calendar year start, and assign it to business units or departments.",
    "Select which leave types (system or custom) are included in this plan. Each leave type carries its own allowance, accrual frequency, and carry-forward rules.",
    "Configure the joining rule, extra-leave allowance, mid-year joiners, probation credit, negative balance, request limits, and other entitlement policies.",
    "Set sandwich leave rules and configure the multi-level approval workflow.",
    "Review how each leave type's unused balance is carried forward, paid out, or expired at year-end.",
    "Review the complete leave plan configuration, assignments, and employee impact.",
  ][step];
}

// ─── Step 0: Plan info form ───────────────────────────────────────────────────

function PlanInfoStep({ planId, assetIds, onAssetIdsChange, pendingFile, setPendingFile, name, setName, start, setStart, busData, deptsData, buIds, setBuIds, deptIds, setDeptIds, showErrors }: any) {
  const [uploadAsset, uploadResult] = useUploadAssetMutation();
  const currentAssetId = (assetIds as string[] | undefined)?.[0];
  const { data: docMeta } = useGetAssetQuery(currentAssetId!, { skip: !currentAssetId });
  const [updatePlan] = useUpdateLeavePlanMutation();
  const [getDownloadUrl] = useLazyGetAssetDownloadUrlQuery();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const hasDoc = !!currentAssetId || !!pendingFile;

  const processFile = useCallback(async (file: File) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(file.type)) {
      toast.error('Only PDF and DOC/DOCX files are allowed');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File size must not exceed 10 MB');
      return;
    }
    if (!planId) {
      setPendingFile(file);
      return;
    }
    try {
      const asset = await uploadAsset(file).unwrap();
      const assetId = asset._id || asset.id;
      await updatePlan({ id: planId, body: { asset_ids: [assetId!] } }).unwrap();
      onAssetIdsChange([assetId!]);
      toast.success('Policy document uploaded');
    } catch {
      toast.error('Failed to upload policy document');
    }
  }, [uploadAsset, planId, onAssetIdsChange, updatePlan, setPendingFile]);

  useEffect(() => {
    let counter = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      counter++;
      if (e.dataTransfer?.types.includes('Files')) setIsDraggingOver(true);
    };
    const onDragLeave = () => {
      counter--;
      if (counter <= 0) { counter = 0; setIsDraggingOver(false); }
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      counter = 0;
      setIsDraggingOver(false);
      const file = e.dataTransfer?.files[0];
      if (file) processFile(file);
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [processFile]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await processFile(file);
  };

  const handleViewDoc = async () => {
    if (pendingFile) {
      const url = URL.createObjectURL(pendingFile);
      window.open(url, '_blank');
      return;
    }
    if (!currentAssetId) return;
    try {
      const { data } = await getDownloadUrl(currentAssetId);
      if (data?.url) window.open(data.url, '_blank');
    } catch {
      toast.error('Failed to get document URL');
    }
  };

  const handleDeleteDoc = async () => {
    if (pendingFile) {
      setPendingFile(null);
      return;
    }
    if (!planId) return;
    try {
      await updatePlan({ id: planId, body: { asset_ids: [] } }).unwrap();
      onAssetIdsChange([]);
      toast.success('Policy document removed');
    } catch {
      toast.error('Failed to remove policy document');
    }
  };

  const filteredDepts = useMemo(
    () =>
      (buIds ?? []).length > 0
        ? (deptsData ?? []).filter((d: any) =>
            d.businessUnits?.some((b: string) => buIds.includes(b)),
          )
        : (deptsData ?? []),
    [deptsData, buIds],
  );

  const toggleBu = (id: string) => {
    setBuIds((prev: string[]) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      return next;
    });
    setDeptIds([]);
  };

  const toggleDept = (id: string) => {
    setDeptIds((prev: string[]) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Plan Information</CardTitle>
          <CardDescription>Name the plan and set when its leave year starts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Field data-invalid={showErrors && !name.trim()}>
              <FieldLabel>
                Leave Plan Name
                <span className="text-destructive ml-0.5">*</span>
              </FieldLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Annual Leave Policy 2024"
              />
              {showErrors && !name.trim() && (
                <p className="text-xs text-destructive mt-1">Leave plan name is required</p>
              )}
            </Field>
            <Field>
              <FieldLabel>Calendar Start Month</FieldLabel>
              <Select value={start} onValueChange={setStart}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel>Leave Policy Document</FieldLabel>
            {hasDoc ? (
              <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                <FileText className="size-5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <button
                    type="button"
                    className="text-sm font-medium truncate text-primary hover:underline cursor-pointer block max-w-full"
                    onClick={handleViewDoc}
                  >
                    {pendingFile ? pendingFile.name : docMeta?.original_filename}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {pendingFile
                      ? `${(pendingFile.size / 1024).toFixed(1)} KB · Will upload on save`
                      : `${((docMeta?.size ?? 0) / 1024).toFixed(1)} KB`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  onClick={handleDeleteDoc}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ) : (
              <label
                htmlFor="policy-upload"
                className={`w-full border-[1.5px] border-dashed rounded-lg h-24 transition-colors flex flex-col items-center justify-center cursor-pointer ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border bg-muted/20 hover:bg-muted/40"
                }`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  id="policy-upload"
                  className="hidden"
                  accept=".pdf,.doc,.docx"
                  onChange={handleFileChange}
                  disabled={uploadResult.isLoading}
                />
                <Upload className={`size-5 mb-1.5 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
                <p className="text-sm text-muted-foreground">
                  {uploadResult.isLoading
                    ? "Uploading…"
                    : isDragging
                      ? "Drop file here"
                      : "Drag & drop or click to browse"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  PDF/DOC, Max 10MB
                </p>
              </label>
            )}
          </Field>

          {/* Full-screen drag overlay */}
          {isDraggingOver && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
              <div className="rounded-2xl border-2 border-dashed border-primary px-16 py-12 flex flex-col items-center gap-3">
                <Upload className="size-12 text-primary" />
                <p className="text-lg font-semibold text-primary">Drop to upload</p>
                <p className="text-sm text-muted-foreground">PDF · DOC · DOCX · Max 5 MB</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Assignment</CardTitle>
          <CardDescription>Assign this plan to business units or departments.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <Field>
                <FieldLabel>
                  Business Units
                  <span className="text-destructive ml-0.5">*</span>
                </FieldLabel>
                <div className={cn(
                  "rounded-lg border p-3 space-y-2.5 max-h-48 overflow-y-auto",
                  showErrors && buIds.length === 0 ? "border-destructive" : "border-border",
                )}>
                  {!busData || busData.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2 text-center">
                      No business units found
                    </p>
                  ) : (
                    <>
                      {busData.length > 1 && (
                        <label className="flex items-center gap-3 cursor-pointer border-b border-border pb-2.5 mb-1">
                          <Checkbox
                            checked={
                              busData.length > 0 &&
                              busData.every((b: any) => buIds.includes(b.id))
                            }
                            onCheckedChange={(checked) => {
                              setBuIds(
                                checked ? busData.map((b: any) => b.id) : [],
                              );
                              setDeptIds([]);
                            }}
                          />
                          <span className="text-sm font-medium">
                            Select All
                          </span>
                        </label>
                      )}
                      {busData.map((bu: any) => (
                        <label
                          key={bu.id}
                          className="flex items-center gap-3 cursor-pointer"
                        >
                          <Checkbox
                            checked={buIds.includes(bu.id)}
                            onCheckedChange={() => toggleBu(bu.id)}
                          />
                          <span className="text-sm">
                            {bu.business_unit_name}
                          </span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
                {showErrors && buIds.length === 0 && (
                  <p className="text-xs text-destructive mt-1">Select at least one business unit</p>
                )}
              </Field>
              <Field>
                <FieldLabel>
                  Departments
                  <span className="text-destructive ml-0.5">*</span>
                </FieldLabel>
                {buIds.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-3 px-3 rounded-lg border border-dashed border-border text-center">
                    Select a business unit first
                  </p>
                ) : (
                  <div className={cn(
                    "rounded-lg border p-3 space-y-2.5 max-h-48 overflow-y-auto",
                    showErrors && deptIds.length === 0 ? "border-destructive" : "border-border",
                  )}>
                    {filteredDepts.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2 text-center">
                        No departments found
                      </p>
                    ) : (
                      <>
                        <label className="flex items-center gap-3 cursor-pointer border-b border-border pb-2.5 mb-1">
                          <Checkbox
                            checked={
                              filteredDepts.length > 0 &&
                              filteredDepts.every((d: any) =>
                                deptIds.includes(d.id),
                              )
                            }
                            onCheckedChange={(checked) => {
                              setDeptIds(
                                checked
                                  ? filteredDepts.map((d: any) => d.id)
                                  : [],
                              );
                            }}
                          />
                          <span className="text-sm font-medium">
                            Select All
                          </span>
                        </label>
                        {filteredDepts.map((d: any) => (
                          <label
                            key={d.id}
                            className="flex items-center gap-3 cursor-pointer"
                          >
                            <Checkbox
                              checked={deptIds.includes(d.id)}
                              onCheckedChange={() => toggleDept(d.id)}
                            />
                            <span className="text-sm">{deptLabel(d)}</span>
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                )}
                {showErrors && buIds.length > 0 && deptIds.length === 0 && (
                  <p className="text-xs text-destructive mt-1">Select at least one department</p>
                )}
              </Field>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── List view ────────────────────────────────────────────────────────────────

const MAX_CHIPS = 2

function NameChips({ items }: { items: { id: string; name: string }[] }) {
  if (items.length === 0) return <span className="text-muted-foreground text-sm">—</span>
  const visible = items.slice(0, MAX_CHIPS)
  const overflow = items.length - MAX_CHIPS
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((item) => (
        <Badge key={item.id} variant="secondary" className="text-xs font-normal">
          {item.name}
        </Badge>
      ))}
      {overflow > 0 && (
        <span className="text-xs text-muted-foreground">+{overflow}</span>
      )}
    </div>
  )
}

function ListView({
  data,
  isLoading,
  busData,
  deptsData,
  onEdit,
  onAdd,
  onActivate,
  onDeactivate,
}: any) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [buFilter, setBuFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  const filteredDeptOptions = useMemo(() => {
    const list = deptsData ?? [];
    if (!buFilter) return list;
    return list.filter((d: any) => d.businessUnits?.includes(buFilter));
  }, [deptsData, buFilter]);

  const filteredData = useMemo(() => {
    let result = data;
    if (buFilter) {
      result = result.filter((p: any) =>
        p.businessUnits?.some((b: { id: string }) => b.id === buFilter),
      );
    }
    if (deptFilter) {
      result = result.filter((p: any) =>
        p.departments?.some((d: { id: string }) => d.id === deptFilter),
      );
    }
    return result;
  }, [data, buFilter, deptFilter]);

  const hasActiveFilters = !!buFilter || !!deptFilter;

  const columns = useMemo(
    () => [
      planColHelper.accessor("name", {
        header: "Plan Name",
        cell: (info) => (
          <span
            className="font-medium text-primary cursor-pointer hover:underline"
            onClick={() => onEdit(info.row.original)}
          >
            {info.getValue()}
          </span>
        ),
      }),
      planColHelper.accessor("start", {
        header: "Calendar Starts on",
        cell: (info) => (
          <Badge className="bg-muted text-muted-foreground font-normal">
            {info.getValue()}
          </Badge>
        ),
      }),
      planColHelper.accessor("businessUnits", {
        header: "Business Units",
        cell: (info) => <NameChips items={info.getValue()} />,
      }),
      planColHelper.accessor("departments", {
        header: "Departments",
        cell: (info) => <NameChips items={info.getValue()} />,
      }),
      planColHelper.accessor("status", {
        header: "Status",
        cell: (info) => {
          const status = info.getValue();
          if (status === "active") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                <CheckCircle2 size={13} /> Active
              </span>
            );
          }
          if (status === "pending_configuration") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
                <Circle size={13} /> Pending Configuration
              </span>
            );
          }
          return (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Circle size={13} /> Inactive
            </span>
          );
        },
      }),
      planColHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const isActive = row.original.is_active;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => onEdit(row.original)}
              >
                <Edit2 className="size-4" />
              </Button>
              {isActive ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-warning hover:text-warning"
                  title="Deactivate plan"
                  onClick={() => onDeactivate(row.original)}
                >
                  <PowerOff className="size-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-success hover:text-success"
                  title="Activate plan"
                  onClick={() => onActivate(row.original)}
                >
                  <Power className="size-4" />
                </Button>
              )}
            </div>
          );
        },
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Leave Plans"
        subtitle="Create and manage your organisation's leave plans."
        action={
          <Button variant="default" onClick={onAdd}>
            <Plus className="size-4 mr-1.5" /> Add Leave Plan
          </Button>
        }
      />

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search leave plans..."
            className="pl-9"
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
          />
        </div>
        <Select
          value={buFilter || "all"}
          onValueChange={(v) => {
            setBuFilter(v === "all" ? "" : v);
            setDeptFilter("");
          }}
        >
          <SelectTrigger className="w-44 h-9 text-sm">
            <SelectValue placeholder="All Business Units" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Business Units</SelectItem>
            {(busData ?? []).map((bu: any) => (
              <SelectItem key={bu.id} value={bu.id}>
                {bu.business_unit_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={deptFilter || "all"}
          onValueChange={(v) => setDeptFilter(v === "all" ? "" : v)}
          disabled={!buFilter}
        >
          <SelectTrigger className="w-44 h-9 text-sm">
            <SelectValue placeholder={buFilter ? "All Departments" : "Select BU first"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {filteredDeptOptions.map((d: any) => (
              <SelectItem key={d.id} value={d.id}>
                {d.departmentName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setBuFilter("");
              setDeptFilter("");
            }}
          >
            <X className="mr-1 size-3.5" /> Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <PageLoader message="Loading leave plans…" />
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 rounded-lg border">
          <div className="size-16 rounded-full bg-muted flex items-center justify-center">
            <FileText className="size-7 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="font-semibold">No leave plans configured</p>
            <p className="text-sm text-muted-foreground">
              Add a leave plan to get started
            </p>
          </div>
          <Button variant="default" onClick={onAdd}>
            <Plus className="size-4 mr-1.5" /> Add Leave Plan
          </Button>
        </div>
      ) : table.getRowModel().rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 rounded-lg border">
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <FileText className="size-5 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="font-medium text-sm">No leave plans match your filters</p>
            <p className="text-xs text-muted-foreground">
              Try clearing search or filters
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                {table
                  .getHeaderGroups()
                  .map((hg) =>
                    hg.headers.map((h) => (
                      <TableHead key={h.id} className="text-foreground h-10">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </TableHead>
                    )),
                  )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="text-muted-foreground">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
