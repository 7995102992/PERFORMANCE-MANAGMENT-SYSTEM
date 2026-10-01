import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import {
  useGetWorkCalendarQuery,
  useGetWorkCalendarEmployeesQuery,
  useGetShiftsQuery,
  useGetShiftAssignmentsQuery,
} from "@/store/api/lmsApi";
import { Stepper, type StepperStep } from "@/components/ui/stepper";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import WorkCalendarForm, {
  ShiftAddButton,
  ShiftList,
} from "./WorkCalendarForm";
import {
  AddEmployeesToCalendar,
  type AddEmployeesToCalendarHandle,
} from "./AddEmployeesToCalendar";
import {
  AssignEmployeesToShifts,
  type AssignEmployeesToShiftsHandle,
} from "./AssignEmployeesToShifts";

const STEPS: StepperStep[] = [
  { id: 0, label: "Create Work Calendar" },
  { id: 1, label: "Manage Employees" },
  { id: 2, label: "Create Shifts" },
  { id: 3, label: "Manage Employee Shifts" },
];

const AddWorkCalendarWizard = () => {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const dispatch = useAppDispatch();
  // Both routes share this component: /add (no calendarId) and /:calendarId/setup
  const { calendarId: paramCalendarId } = useParams({ strict: false }) as {
    calendarId?: string;
  };
  const search = useSearch({ strict: false }) as { step?: number };

  // URL is the source of truth — survives refresh.
  const initialStep = (() => {
    const fromUrl =
      typeof search.step === "number" ? search.step : Number(search.step);
    if (Number.isFinite(fromUrl) && fromUrl >= 0 && fromUrl <= 3)
      return fromUrl;
    return paramCalendarId ? 1 : 0;
  })();

  const [activeStep, setActiveStep] = useState(initialStep);
  const [createdCalendarId, setCreatedCalendarId] = useState<string>(
    paramCalendarId ?? "",
  );
  // Steps before the resume point are implicitly done.
  const [completed, setCompleted] = useState<Set<number>>(
    new Set(Array.from({ length: initialStep }, (_, i) => i)),
  );

  // Keep state in sync when the URL changes externally (back/forward nav).
  useEffect(() => {
    if (paramCalendarId && paramCalendarId !== createdCalendarId) {
      setCreatedCalendarId(paramCalendarId);
    }
  }, [paramCalendarId, createdCalendarId]);

  const partialSetup = !!createdCalendarId && completed.size < STEPS.length;
  const releaseNavigationGuard = useNavigationGuard(partialSetup);

  const goToStep = (step: number) => {
    setActiveStep(step);
    if (createdCalendarId) {
      releaseNavigationGuard();
      navigate({
        to: `/leave-management/work-calendar/${createdCalendarId}/setup`,
        search: { step } as any,
        replace: true,
      });
    }
  };

  // Plan data + counts for soft validation of Next buttons.
  const { data: calendarData } = useGetWorkCalendarQuery(createdCalendarId, {
    skip: !createdCalendarId,
  });

  // Breadcrumb — set once calendar name is known, clear on exit.
  useEffect(() => {
    dispatch(setBreadcrumbDetail(calendarData?.name ?? "New Work Calendar"));
  }, [calendarData?.name, dispatch]);

  useEffect(
    () => () => {
      dispatch(setBreadcrumbDetail(null));
    },
    [dispatch],
  );
  const { data: calEmployees = [] } = useGetWorkCalendarEmployeesQuery(
    createdCalendarId,
    {
      skip: !createdCalendarId,
      refetchOnMountOrArgChange: true,
    },
  );
  const { data: shifts = [] } = useGetShiftsQuery(createdCalendarId, {
    skip: !createdCalendarId,
  });
  const { data: shiftAssignments = [] } = useGetShiftAssignmentsQuery(
    createdCalendarId,
    {
      skip: !createdCalendarId,
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
    if (id < activeStep || completed.has(id)) goToStep(id);
  };

  const exitToLanding = () => {
    releaseNavigationGuard();
    navigate({ to: "/leave-management/work-calendar" });
  };

  const handleExitMidway = () => {
    if (createdCalendarId) {
      confirm({
        title: "Leave setup?",
        description:
          "The work calendar has been created but is not fully set up. You can finish setup later from the Work Calendar page.",
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
        <h1 className="text-xl">New Work Calendar</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Set up the calendar, assign employees, define shifts, and pick
          employee shifts.
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
        // If the user navigated back after the calendar exists, render
        // in edit mode so Save & Continue updates instead of creating a
        // duplicate. WorkCalendarForm reads the calendarId from URL
        // params (we route on /:calendarId/setup once created).
        <WorkCalendarForm
          mode={createdCalendarId ? "edit" : "create"}
          wizardMode
          onCreated={(id) => {
            const isFirstCreate = !createdCalendarId;
            if (isFirstCreate) setCreatedCalendarId(id);
            markComplete(0);
            if (isFirstCreate) {
              releaseNavigationGuard();
              navigate({
                to: `/leave-management/work-calendar/${id}/setup`,
                search: { step: 1 } as any,
                replace: true,
              });
            }
            setActiveStep(1);
          }}
        />
      )}

      {activeStep === 1 && createdCalendarId && calendarData && (
        <Step2Employees
          calendarData={calendarData}
          assignedCount={calEmployees.length}
          onBack={() => goToStep(0)}
          onNext={() => {
            markComplete(1);
            goToStep(2);
          }}
          onExit={handleExitMidway}
          onExitNoConfirm={exitToLanding}
        />
      )}

      {activeStep === 2 && createdCalendarId && (
        <Step3Shifts
          calendarId={createdCalendarId}
          shiftCount={shifts.length}
          onBack={() => goToStep(1)}
          onNext={() => {
            markComplete(2);
            goToStep(3);
          }}
          onExit={handleExitMidway}
        />
      )}

      {activeStep === 3 && createdCalendarId && calendarData && (
        <Step4ShiftAssignments
          calendarData={calendarData}
          assignedShiftCount={shiftAssignments.length}
          onBack={() => goToStep(2)}
          onFinish={() => {
            markComplete(3);
            toast.success("Work calendar setup complete");
            exitToLanding();
          }}
          onExit={handleExitMidway}
          onExitNoConfirm={exitToLanding}
        />
      )}
    </div>
  );
};

export default AddWorkCalendarWizard;

// ─── Step 2: Employees ───────────────────────────────────────────────────────

function Step2Employees({
  calendarData,
  assignedCount,
  onBack,
  onNext,
  onExit,
  onExitNoConfirm,
}: {
  calendarData: any;
  assignedCount: number;
  onBack: () => void;
  onNext: () => void;
  onExit: () => void;
  onExitNoConfirm: () => void;
}) {
  const confirm = useConfirm();
  const innerRef = useRef<AddEmployeesToCalendarHandle>(null);
  const [hasChanges, setHasChanges] = useState(false);

  const handleNext = async () => {
    if (hasChanges) {
      // triggerSave will call onSaved on success → advances us.
      await innerRef.current?.triggerSave();
      return;
    }
    if (assignedCount === 0) {
      confirm({
        title: "Continue without assigning employees?",
        description:
          "No employees are assigned to this calendar. You can add them later from the Work Calendar page.",
        confirmText: "Continue anyway",
        onConfirm: onNext,
      });
      return;
    }
    onNext();
  };

  const nextLabel = hasChanges
    ? "Save & Continue"
    : assignedCount === 0
      ? "Continue without employees"
      : "Next: Create Shifts";

  return (
    <div className="space-y-6">
      <AddEmployeesToCalendar
        ref={innerRef}
        calendarData={calendarData}
        onClose={onExitNoConfirm}
        wizardMode
        onSaved={onNext}
        onHasChangesChange={setHasChanges}
      />

      {assignedCount === 0 && !hasChanges && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-badge-pending-bg px-4 py-3">
          <span className="text-sm text-foreground">
            No employees assigned. If all eligible employees are already on
            another calendar, continue and add them later.
          </span>
        </div>
      )}

      <StepFooter
        onBack={onBack}
        onExit={onExit}
        onNext={handleNext}
        nextLabel={nextLabel}
        nextDisabled={false}
      />
    </div>
  );
}

// ─── Step 3: Shifts ──────────────────────────────────────────────────────────

function Step3Shifts({
  calendarId,
  shiftCount,
  onBack,
  onNext,
  onExit,
}: {
  calendarId: string;
  shiftCount: number;
  onBack: () => void;
  onNext: () => void;
  onExit: () => void;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-5 pt-2">
          <div className="flex items-start justify-between gap-3 border-b pb-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Clock className="size-4 text-muted-foreground" /> Shift
                Management
              </h3>
              <p className="text-sm text-muted-foreground">
                Define the shifts that employees on this calendar can be
                assigned to.
              </p>
            </div>
            <div className="shrink-0">
              <ShiftAddButton calendarId={calendarId} />
            </div>
          </div>
          <ShiftList calendarId={calendarId} />
        </CardContent>
      </Card>

      <StepFooter
        onBack={onBack}
        onExit={onExit}
        onNext={onNext}
        nextLabel="Next: Manage Employee Shifts"
        nextDisabled={shiftCount === 0}
      />
    </div>
  );
}

// ─── Step 4: Shift Assignments ───────────────────────────────────────────────

function Step4ShiftAssignments({
  calendarData,
  assignedShiftCount,
  onBack,
  onFinish,
  onExit,
  onExitNoConfirm,
}: {
  calendarData: any;
  assignedShiftCount: number;
  onBack: () => void;
  onFinish: () => void;
  onExit: () => void;
  onExitNoConfirm: () => void;
}) {
  const confirm = useConfirm();
  const innerRef = useRef<AssignEmployeesToShiftsHandle>(null);
  const [hasChanges, setHasChanges] = useState(false);

  const handleFinish = async () => {
    if (hasChanges) {
      // triggerSave will call onSaved on success → which is onFinish.
      await innerRef.current?.triggerSave();
      return;
    }
    if (assignedShiftCount === 0) {
      confirm({
        title: "Finish without assigning shifts?",
        description:
          "No employees have been assigned to a shift. You can assign them later from the Work Calendar page.",
        confirmText: "Finish anyway",
        onConfirm: onFinish,
      });
      return;
    }
    onFinish();
  };

  const finishLabel = hasChanges
    ? "Save & Finish"
    : assignedShiftCount === 0
      ? "Finish without shift assignments"
      : "Finish Setup";

  return (
    <div className="space-y-6">
      <AssignEmployeesToShifts
        ref={innerRef}
        calendarData={calendarData}
        onClose={onExitNoConfirm}
        wizardMode
        onSaved={onFinish}
        onHasChangesChange={setHasChanges}
      />

      {assignedShiftCount === 0 && !hasChanges && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-badge-pending-bg px-4 py-3">
          <span className="text-sm text-foreground">
            No employee shift assignments yet. Drag an employee card onto a
            shift column above, or finish here and assign later.
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

// ─── Footer ──────────────────────────────────────────────────────────────────

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
