import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { FormProvider, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { RecordNotFound } from "@/components/shared/RecordNotFound";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { toast } from "@/lib/toast";
import { useAppDispatch } from "@/store";
import {
  useCreatePmsTemplateMutation,
  useGetPmsCompetenciesQuery,
  useGetPmsKpisQuery,
  useGetPmsKrasQuery,
  useGetPmsTemplateQuery,
  useUpdatePmsTemplateMutation,
} from "@/store/api/pmsApi";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";
import type { PmsTemplateStatus } from "@/types/pms-config";
import { WizardStepper } from "../../shared/WizardStepper";
import { GOAL_TEMPLATES_PATH } from "../config.constants";
import { TemplateBasicStep } from "./components/TemplateBasicStep";
import { TemplateCompetencyStep } from "./components/TemplateCompetencyStep";
import { TemplateKraKpiStep } from "./components/TemplateKraKpiStep";
import { TEMPLATE_STEP_SCHEMAS } from "./template.schema";
import type { TemplateFormValues } from "./template.types";
import { buildFormValues, toApiBody } from "./template.utils";

const STEPS = [
  { id: 0, label: "Basic Info" },
  { id: 1, label: "KRA & KPI" },
  { id: 2, label: "Competencies" },
];
const LAST_STEP = STEPS.length - 1;
const ALL_DONE = new Set(STEPS.map((s) => s.id));

const HEADERS = [
  { title: "Create / Edit Template – Basic Info", subtitle: "Template details" },
  { title: "KRA & KPI Configuration", subtitle: "Select KRAs and configure their KPIs" },
  { title: "Competency Configuration", subtitle: "Competencies assessed at year end" },
];

/**
 * Screens 2.2 → 2.4. One wizard for `/new`, `/:id/edit` and the read-only
 * `/:id`. Each "Save & Next" persists, so a half-built template survives as a
 * draft; the status the user picked on step 1 is applied by the final save.
 */
const GoalTemplateWizard = ({ readOnly = false }: { readOnly?: boolean }) => {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { templateId } = useParams({ strict: false }) as { templateId?: string };

  const { data: existing, isLoading: loadingTemplate, isError } = useGetPmsTemplateQuery(
    templateId ?? "",
    { skip: !templateId },
  );
  const { data: kras, isLoading: l1 } = useGetPmsKrasQuery();
  const { data: kpis, isLoading: l2 } = useGetPmsKpisQuery();
  const { data: competencies, isLoading: l3 } = useGetPmsCompetenciesQuery();
  const [createTemplate, { isLoading: creating }] = useCreatePmsTemplateMutation();
  const [updateTemplate, { isLoading: updating }] = useUpdatePmsTemplateMutation();
  const busy = creating || updating;

  const [step, setStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());
  const completed = templateId ? ALL_DONE : doneSteps;
  const savedId = useRef<string | undefined>(templateId);
  const stepRef = useRef(0);
  const hydrated = useRef(false);

  const form = useForm<TemplateFormValues>({
    mode: "onChange",
    resolver: ((values, context, options) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      zodResolver(TEMPLATE_STEP_SCHEMAS[stepRef.current] as any)(values as any, context, options as any)) as Resolver<TemplateFormValues>,
  });
  const { trigger, getValues, reset, control, formState } = form;
  const releaseGuard = useNavigationGuard(formState.isDirty && !readOnly);

  // Build the form once the masters (and the template, when editing) are in.
  const ready = !!kras && !!kpis && !!competencies && (!templateId || !!existing);
  useEffect(() => {
    if (!ready || hydrated.current) return;
    hydrated.current = true;
    reset(buildFormValues({ kras, kpis, competencies }, existing));
  }, [ready, kras, kpis, competencies, existing, reset]);

  const name = useWatch({ control, name: "basic.name" });
  useEffect(() => {
    dispatch(setBreadcrumbDetail(name?.trim() || existing?.basic.name || "New Template"));
  }, [name, existing?.basic.name, dispatch]);
  useEffect(() => () => void dispatch(setBreadcrumbDetail(null)), [dispatch]);

  const goToList = () => {
    releaseGuard();
    navigate({ to: GOAL_TEMPLATES_PATH });
  };

  const goToStep = (next: number) => {
    stepRef.current = next;
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Create on first save, update after. */
  const persist = async (status: PmsTemplateStatus) => {
    const body = toApiBody(getValues(), status);
    if (savedId.current) {
      await updateTemplate({ id: savedId.current, body }).unwrap();
    } else {
      savedId.current = (await createTemplate(body).unwrap()).id;
    }
  };

  // A template that is already live must not flip back to draft on an interim save.
  const interimStatus = (): PmsTemplateStatus =>
    existing && existing.basic.status !== "draft" ? getValues("basic.status") : "draft";

  const validateStep = async (id: number) => {
    stepRef.current = id;
    return trigger(undefined, { shouldFocus: true });
  };

  const handleSaveAndNext = async () => {
    if (!readOnly) {
      if (!(await validateStep(step))) return;
      try {
        await persist(interimStatus());
      } catch (e) {
        toast.error(e, "Could not save the template");
        return;
      }
      setDoneSteps((prev) => new Set(prev).add(step));
      reset(getValues());
    }
    goToStep(step + 1);
  };

  const handleSaveDraft = async () => {
    if (!(await validateStep(0))) {
      goToStep(0);
      toast.error("Complete the basic info to save a draft");
      stepRef.current = 0;
      return;
    }
    stepRef.current = step;
    try {
      await persist("draft");
      toast.success("Draft saved");
      goToList();
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  const handleFinish = async () => {
    if (readOnly) return goToList();
    for (const s of STEPS) {
      if (!(await validateStep(s.id))) {
        goToStep(s.id);
        toast.error("Fix the highlighted fields before saving");
        return;
      }
    }
    stepRef.current = step;
    try {
      await persist(getValues("basic.status"));
      toast.success("Template saved");
      goToList();
    } catch (e) {
      toast.error(e, "Could not save the template");
    }
  };

  if (templateId && (isError || (!loadingTemplate && !existing))) {
    return <RecordNotFound entity="goal template" backLabel="Back to Goal Templates" onBack={goToList} />;
  }
  if (!ready || l1 || l2 || l3 || (templateId && loadingTemplate)) {
    return <PageLoader message="Loading template…" />;
  }

  const header = HEADERS[step];
  const title =
    step === 0 && templateId && readOnly ? "Goal Template – Basic Info" : header.title;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={title}
        subtitle={`Step ${step + 1} of ${STEPS.length} · ${header.subtitle}`}
        meta={
          readOnly ? (
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              View only
            </span>
          ) : undefined
        }
      />

      <div className="rounded-xl border bg-card">
        <div className="border-b px-6 py-5 sm:px-10">
          <WizardStepper steps={STEPS} current={step} completed={completed} onStepClick={goToStep} />
        </div>

        <FormProvider {...form}>
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
            <div
              key={step}
              className="px-6 py-6 duration-200 animate-in fade-in-0 slide-in-from-bottom-1 sm:px-10"
            >
              {step === 0 && <TemplateBasicStep />}
              {step === 1 && <TemplateKraKpiStep />}
              {step === 2 && <TemplateCompetencyStep />}
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
            {!readOnly && step === 1 && (
              <Button variant="outline" onClick={handleSaveDraft} disabled={busy}>
                <Save /> Save as Draft
              </Button>
            )}
            {step < LAST_STEP ? (
              <Button onClick={handleSaveAndNext} disabled={busy}>
                {readOnly ? "Next" : busy ? "Saving…" : "Save & Next"} <ArrowRight />
              </Button>
            ) : (
              <Button onClick={handleFinish} disabled={busy}>
                {readOnly ? "Back to templates" : busy ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default GoalTemplateWizard;
