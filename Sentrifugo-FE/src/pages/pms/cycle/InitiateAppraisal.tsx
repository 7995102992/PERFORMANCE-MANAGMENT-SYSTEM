import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { FormProvider, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
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
  buildDefaultStages,
  buildEmptyCycle,
  PMS_CYCLE_LIST_PATH,
  WIZARD_STEPS,
} from "./cycle.constants";
import { STEP_SCHEMAS } from "./cycle.schema";

const LAST_STEP = WIZARD_STEPS.length - 1;

const STEP_HEADERS = [
  { title: "Create New Appraisal – Basic Details", subtitle: "Cycle name, type and performance period" },
  { title: "Configure Timeline & Milestones", subtitle: "Start and end dates for each stage" },
  { title: "Applicability & Eligibility", subtitle: "Who is covered by this cycle" },
  { title: "Rating Scale & Publish", subtitle: "Rating scale, notifications and publish" },
];

const ALL_STEPS_DONE = new Set(WIZARD_STEPS.map((s) => s.id));

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
  const [createCycle, { isLoading: creating }] = useCreatePmsCycleMutation();
  const [updateCycle, { isLoading: updating }] = useUpdatePmsCycleMutation();
  const [publishCycle, { isLoading: publishing }] = usePublishPmsCycleMutation();
  const busy = creating || updating || publishing;

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

  const form = useForm<PmsCycleUpsert>({
    mode: "onChange",
    defaultValues: buildEmptyCycle(),
    resolver: ((values, context, options) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      zodResolver(STEP_SCHEMAS[stepRef.current] as any)(values as any, context, options as any)) as Resolver<PmsCycleUpsert>,
  });
  const { trigger, getValues, setValue, reset, control, formState } = form;

  const releaseGuard = useNavigationGuard(formState.isDirty && !readOnly);

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

  const goToList = () => {
    releaseGuard();
    navigate({ to: PMS_CYCLE_LIST_PATH });
  };

  const goToStep = (next: number) => {
    stepRef.current = next;
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleNext = async () => {
    if (!readOnly) {
      stepRef.current = step;
      if (!(await trigger(undefined, { shouldFocus: true }))) return;
      setDoneSteps((prev) => new Set(prev).add(step));

      if (step === 0) {
        const start = getValues("basic.period_start");
        if (start !== stagesPeriod.current) {
          setValue("stages", buildDefaultStages(start), { shouldDirty: true });
          stagesPeriod.current = start;
        }
      }
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

  const header = STEP_HEADERS[step];
  const title =
    step === 0 && cycleId
      ? `${readOnly ? "Appraisal Cycle" : "Edit Appraisal"} – Basic Details`
      : header.title;
  const editingLive = existing?.status === "active" && !readOnly;
  const finishLabel = readOnly
    ? "Back to PMS Cycle"
    : editingLive
      ? "Save Changes"
      : "Publish Cycle";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={title}
        subtitle={`Step ${step + 1} of ${WIZARD_STEPS.length} · ${header.subtitle}`}
        meta={
          readOnly && existing ? (
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {existing.cycle_code} · View only
            </span>
          ) : undefined
        }
      />

      <div className="rounded-xl border bg-card">
        <div className="border-b px-6 py-5 sm:px-10">
          <WizardStepper
            steps={WIZARD_STEPS}
            current={step}
            completed={completed}
            onStepClick={goToStep}
          />
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
