import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { FormProvider, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { FinancialYearTag } from "../shared/FinancialYearTag";
import { currentFinancialYear } from "../configuration/config.constants";
import { PageLoader } from "@/components/shared/PageLoader";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { toast } from "@/lib/toast";
import { useAppDispatch } from "@/store";
import {
  useCreatePmsCycleMutation,
  useGetPmsCycleQuery,
  usePublishPmsCycleMutation,
  useUpdatePmsCycleMutation,
} from "@/store/api/pmsApi";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import type { PmsCycleUpsert } from "@/types/pms";
import { ApplicabilityStep } from "./components/ApplicabilityStep";
import { BasicDetailsStep } from "./components/BasicDetailsStep";
import { WizardStepper } from "../shared/WizardStepper";
import { RatingPublishStep } from "./components/RatingPublishStep";
import { TimelineStep } from "./components/TimelineStep";
import {
  buildEmptyCycle,
  PMS_CYCLE_LIST_PATH,
  WIZARD_STEPS,
} from "./cycle.constants";
import { STEP_SCHEMAS } from "./cycle.schema";

/** Page heading and subtitle of each wizard step. */
const HEADINGS = [
  { title: "Basic Details", subtitle: "Cycle name, type and performance period" },
  { title: "Configure Timeline & Milestones", subtitle: "Start and end dates for each stage" },
  { title: "Applicability & Eligibility", subtitle: "Who is covered by this cycle" },
  { title: "Rating Scale & Publish", subtitle: "Rating scale, notifications and publish" },
] as const;

/** Index of the last wizard step (Rating & Publish). */
const LAST_STEP = WIZARD_STEPS.length - 1;

/** A saved cycle has passed every step once, so all steps are shown as done and clickable. */
const ALL_STEPS_DONE = new Set(WIZARD_STEPS.map((s) => s.id));

/** Props for the wizard page. */
interface InitiateAppraisalProps {
  /** View mode: every step is browsable, nothing can be changed or published. */
  readOnly?: boolean;
}

/**
 * One wizard for three routes — `/pms/cycle/new`, `/pms/cycle/:id/edit` and the
 * read-only `/pms/cycle/:id`. A single react-hook-form instance spans all four
 * steps; the resolver validates only the step on screen (see `stepRef`).
 */
const InitiateAppraisal = ({ readOnly = false }: InitiateAppraisalProps) => {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { cycleId } = useParams({ strict: false }) as { cycleId?: string };

  const { data: existing, isLoading: loadingExisting, isError } = useGetPmsCycleQuery(
    cycleId ?? "",
    { skip: !cycleId },
  );
  // Clone: /pms/cycle/new?clone=<id> starts a new cycle from an existing one, with the dates left to pick.
  const cloneId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("clone");
  const { data: cloneSource } = useGetPmsCycleQuery(cloneId ?? "", { skip: !cloneId || !!cycleId });
  const [createCycle, { isLoading: creating }] = useCreatePmsCycleMutation();
  const [updateCycle, { isLoading: updating }] = useUpdatePmsCycleMutation();
  const [publishCycle, { isLoading: publishing }] = usePublishPmsCycleMutation();
  const busy = creating || updating || publishing;

  // Wizard position and the set of steps the user has completed in this session.
  const [step, setStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());
  // A saved cycle already passed every step once, so all of them are browsable.
  const completed = cycleId ? ALL_STEPS_DONE : doneSteps;
  // Id of the persisted cycle — set from the route, or after the first save.
  const savedId = useRef<string | undefined>(cycleId);
  // Which step the resolver validates; a ref so trigger() sees the latest value.
  const stepRef = useRef(0);
  // Period the current `stages` were generated from — dates are re-suggested
  // only when this changes, never over a user's own edits.
  const stagesPeriod = useRef<string>("");
  const hydrated = useRef(false);

  // One form for all four steps. The resolver validates only the step on screen (STEP_SCHEMAS[stepRef]).
  const form = useForm<PmsCycleUpsert>({
    mode: "onChange",
    defaultValues: buildEmptyCycle(),
    resolver: ((values, context, options) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      zodResolver(STEP_SCHEMAS[stepRef.current] as any)(values as any, context, options as any)) as Resolver<PmsCycleUpsert>,
  });
  const { trigger, getValues, reset, control, formState } = form;

  // Warns before leaving with unsaved edits; releaseGuard() turns the warning off before we navigate away on purpose.
  const releaseGuard = useNavigationGuard(formState.isDirty && !readOnly);

  // Remember the period the stages were generated from, so dates are only re-suggested when it changes.
  useEffect(() => {
    if (!hydrated.current && stagesPeriod.current === "") {
      stagesPeriod.current = getValues("basic.period_start");
    }
  }, [getValues]);

  // Load an existing cycle into the form once.
  useEffect(() => {
    if (!existing || hydrated.current) return;
    hydrated.current = true;
    const { basic, stages, applicability, finalize } = existing;
    reset({ basic, stages, applicability, finalize });
    stagesPeriod.current = basic.period_start;
  }, [existing, reset]);

  // Fill a clone once: same applicability and notification choices, new name, no dates.
  useEffect(() => {
    if (!cloneSource || hydrated.current || cycleId) return;
    hydrated.current = true;
    const { basic, stages, applicability, finalize } = cloneSource;
    reset({
      basic: { ...basic, name: `${basic.name} (Copy)`, period_start: "", period_end: "" },
      stages: stages.map((s) => ({ ...s, start_date: "", end_date: "" })),
      applicability: { ...applicability, appraisal: { ...applicability.appraisal, service_as_on: "" } },
      finalize,
    });
  }, [cloneSource, cycleId, reset]);

  // Closed / cancelled cycles are history — send edit links to the read-only view.
  useEffect(() => {
    if (existing && !readOnly && existing.status !== "draft" && existing.status !== "active") {
      navigate({ to: "/pms/cycle/$cycleId", params: { cycleId: existing.id }, replace: true });
    }
  }, [existing, readOnly, navigate]);

  const name = useWatch({ control, name: "basic.name" });
  useEffect(() => {
    dispatch(setBreadcrumbDetail(name?.trim() || existing?.basic.name || "New Appraisal"));
  }, [name, existing?.basic.name, dispatch]);
  useEffect(() => () => void dispatch(setBreadcrumbDetail(null)), [dispatch]);

  /** Leaves the wizard for the cycle list (without the unsaved-changes prompt). */
  const goToList = () => {
    releaseGuard();
    navigate({ to: PMS_CYCLE_LIST_PATH });
  };

  /** Shows step `next`, tells the resolver which schema applies, and scrolls to the top. */
  const goToStep = (next: number) => {
    stepRef.current = next;
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /**
   * Validates the current step and moves forward. No dates are suggested: the user picks every one.
   * Nothing is saved to the API until the final step.
   */
  const handleNext = async () => {
    if (!readOnly) {
      stepRef.current = step;
      if (!(await trigger(undefined, { shouldFocus: true }))) return;
      setDoneSteps((prev) => new Set(prev).add(step));
    }
    goToStep(step + 1);
  };

  /** Create (first save) or update the cycle; resolves to its id. */
  const persist = async (body: PmsCycleUpsert): Promise<string> => {
    if (savedId.current) {
      await updateCycle({ id: savedId.current, body }).unwrap();
      return savedId.current;
    }
    const created = await createCycle(body).unwrap();
    savedId.current = created.id;
    return created.id;
  };

  /**
   * Final button. Validates all four steps, saves, then publishes (draft cycles) - or just saves when the
   * cycle is already active. On success goes to the "Cycle Activated" page.
   */
  const handleFinish = async () => {
    if (readOnly) {
      goToList();
      return;
    }
    for (const id of WIZARD_STEPS.map((s) => s.id)) {
      stepRef.current = id;
      if (!(await trigger(undefined, { shouldFocus: true }))) {
        goToStep(id);
        toast.error("Fix the highlighted fields before publishing");
        return;
      }
    }
    stepRef.current = step;

    try {
      const id = await persist(getValues());
      // A live cycle is only edited — publishing already happened.
      if (existing?.status === "active") {
        toast.success("Cycle updated");
        goToList();
        return;
      }
      await publishCycle(id).unwrap();
      releaseGuard();
      navigate({ to: "/pms/cycle/$cycleId/activated", params: { cycleId: id }, replace: true });
    } catch (e) {
      toast.error(e, "Could not publish the cycle");
    }
  };

  if (cycleId && loadingExisting) return <PageLoader message="Loading cycle…" />;
  if (cycleId && (isError || !existing)) {
    return (
      <RecordNotFound entity="appraisal cycle" backLabel="Back to PMS Cycle" onBack={goToList} />
    );
  }

  // An active cycle is edited with "Save Changes" and is not published again.
  const editingLive = existing?.status === "active" && !readOnly;
  const finishLabel = readOnly
    ? "Back to PMS Cycle"
    : editingLive
      ? "Save Changes"
      : "Publish Cycle";

  // Heading and subtitle of the step on screen, as in the mockups.
  const heading = HEADINGS[step];
  const prefix = cycleId ? (readOnly ? "Appraisal" : "Edit Appraisal") : "Create New Appraisal";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={step === 0 ? `${prefix} – ${heading.title}` : heading.title}
        subtitle={`Step ${step + 1} of ${WIZARD_STEPS.length} · ${heading.subtitle}`}
        action={<FinancialYearTag fy={String(currentFinancialYear())} />}
      />
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-5 sm:px-10">
          <WizardStepper
            steps={WIZARD_STEPS}
            current={step}
            completed={completed}
            onStepClick={goToStep}
          />
          {readOnly && existing && (
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {existing.cycle_code} · View only
            </span>
          )}
        </div>

        <FormProvider {...form}>
          {/* A disabled fieldset disables every control inside it — the view-only mode. */}
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
            <div
              key={step}
              className="px-6 py-6 duration-200 animate-in fade-in-0 slide-in-from-bottom-1 sm:px-10"
            >
              {step === 0 && <BasicDetailsStep />}
              {step === 1 && <TimelineStep />}
              {step === 2 && <ApplicabilityStep />}
              {step === 3 && <RatingPublishStep />}
            </div>
          </fieldset>
        </FormProvider>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4 sm:px-10">
          {step === 0 ? (
            <Button variant="outline" onClick={goToList} disabled={busy}>
              {readOnly ? "Back" : "Cancel"}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => goToStep(step - 1)} disabled={busy}>
              <ArrowLeft /> Previous
            </Button>
          )}

          <div className="flex items-center gap-2">
            {step < LAST_STEP ? (
              <Button onClick={handleNext} disabled={busy}>
                Next <ArrowRight />
              </Button>
            ) : (
              <Button onClick={handleFinish} disabled={busy}>
                {!readOnly && !editingLive && <Rocket />}
                {publishing ? "Publishing…" : finishLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default InitiateAppraisal;
