import { useEffect, useState, type ReactNode } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Eye, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import type { PmsCycleUpsert, PmsEmploymentType } from "@/types/pms";
import { EMPLOYMENT_TYPE_OPTIONS } from "../cycle.constants";
import { dateToIso, formatDisplayDate } from "../../shared/pms.utils";
import { usePmsDepartments, usePmsPlants } from "../../shared/usePmsLookups";
import { EligibleEmployeesDialog } from "./EligibleEmployeesDialog";
import { FormRow, StepSection } from "../../shared/FormRow";

/**
 * Wizard step 3: which plants and departments are covered, then the two halves of the rule - who gets
 * goals and who is rated - each with its own employment types and minimum service. "Show Eligible
 * Employees Preview" opens EligibleEmployeesDialog with the current rules.
 */
export function ApplicabilityStep() {
  const {
    register,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  // Shorthand for this step validation errors.
  const e = errors.applicability;
  // Whether the "Eligible Employees Preview" dialog is open.
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: plants, isLoading: plantsLoading } = usePmsPlants();
  const { data: departments } = usePmsDepartments();

  // Live form values used for the conditional controls and the info banner.
  const allDepartments = watch("applicability.all_departments");
  const plantIds = watch("applicability.plant_ids");
  const appraisalMonths = watch("applicability.appraisal.min_service_months");
  const allPlants = plants.length > 0 && plantIds.length === plants.length;
  const serviceAsOn = watch("applicability.appraisal.service_as_on");
  // The initiation date is today until the cycle is published; a saved cycle keeps its date.
  const initiationDate = serviceAsOn || dateToIso(new Date());
  const appraisalTypes = watch("applicability.appraisal.employment_types");

  // Appraisal covers permanent employees only, and the cut-off is the initiation date.
  useEffect(() => {
    if (appraisalTypes.length !== 1 || appraisalTypes[0] !== "permanent") {
      setValue("applicability.appraisal.employment_types", ["permanent"], { shouldDirty: true });
    }
    if (!serviceAsOn) {
      setValue("applicability.appraisal.service_as_on", initiationDate, { shouldDirty: true });
    }
  }, [appraisalTypes, serviceAsOn, initiationDate, setValue]);

  return (
    <section>
      <StepSection title="Applicability" />
      <div className="space-y-4">
        <FormRow label="Applicable Plants" required error={e?.plant_ids?.message}>
          <div className="flex items-start gap-2">
            <Controller
              control={control}
              name="applicability.plant_ids"
              render={({ field }) => (
                <SearchableSelect
                  multi
                  className="min-w-0 flex-1"
                  loading={plantsLoading}
                  options={plants.map((p) => ({ label: p.name, value: p.id }))}
                  value={field.value}
                  onChange={(v) => field.onChange(v as string[])}
                  placeholder="Select plants"
                />
              )}
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={plants.length === 0}
              onClick={() =>
                setValue("applicability.plant_ids", allPlants ? [] : plants.map((p) => p.id), {
                  shouldValidate: true,
                  shouldDirty: true,
                })
              }
            >
              {allPlants ? "Clear" : "All Plants"}
            </Button>
          </div>
        </FormRow>

        <FormRow label="Departments" error={e?.department_ids?.message}>
          <div className="space-y-3">
            <Controller
              control={control}
              name="applicability.all_departments"
              render={({ field }) => (
                <RadioGroup
                  className="flex gap-5 pt-2"
                  value={field.value ? "all" : "select"}
                  onValueChange={(v) => field.onChange(v === "all")}
                >
                  <Label className="flex cursor-pointer items-center gap-2 font-normal">
                    <RadioGroupItem value="all" /> All Departments
                  </Label>
                  <Label className="flex cursor-pointer items-center gap-2 font-normal">
                    <RadioGroupItem value="select" /> Select Departments
                  </Label>
                </RadioGroup>
              )}
            />
            {!allDepartments && (
              <Controller
                control={control}
                name="applicability.department_ids"
                render={({ field }) => (
                  <SearchableSelect
                    multi
                    options={departments.map((d) => ({ label: d.name, value: d.id }))}
                    value={field.value}
                    onChange={(v) => field.onChange(v as string[])}
                    placeholder="Select departments"
                  />
                )}
              />
            )}
          </div>
        </FormRow>

        <div className="grid gap-4 pt-2 lg:grid-cols-2">
          <RuleCard
            title="Goal Setting – who gets goals"
            description="Goals are set for all employees."
          >
            <EmploymentTypes
              name="applicability.goal_setting.employment_types"
              error={e?.goal_setting?.employment_types?.message}
            />
            <div className="space-y-1.5">
              <Label htmlFor="goal-min-service" className="text-sm font-medium">
                Minimum Service (Months)
              </Label>
              <Input
                id="goal-min-service"
                type="number"
                min={0}
                className="w-28"
                aria-invalid={!!e?.goal_setting?.min_service_months}
                {...register("applicability.goal_setting.min_service_months", {
                  valueAsNumber: true,
                })}
              />
              <FieldError message={e?.goal_setting?.min_service_months?.message} />
            </div>
          </RuleCard>

          <RuleCard
            title="Appraisal – who is rated"
            description="Self rating, manager rating and final rating."
          >
            <EmploymentTypes
              name="applicability.appraisal.employment_types"
              error={e?.appraisal?.employment_types?.message}
              only={["permanent"]}
            />
            <div className="grid items-start gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <Label htmlFor="appraisal-min-service" className="whitespace-nowrap text-sm font-medium">
                  Minimum Service (Months)
                  <span className="ml-0.5 text-destructive">*</span>
                </Label>
                <Input
                  id="appraisal-min-service"
                  type="number"
                  min={0}
                  className="w-28"
                  aria-invalid={!!e?.appraisal?.min_service_months}
                  {...register("applicability.appraisal.min_service_months", {
                    valueAsNumber: true,
                  })}
                />
                <FieldError message={e?.appraisal?.min_service_months?.message} />
              </div>
              <div className="space-y-1.5">
                <Label className="whitespace-nowrap text-sm font-medium">
                  {Number.isFinite(appraisalMonths) ? appraisalMonths : 0} months completed on or
                  before
                  <span className="ml-0.5 text-destructive">*</span>
                </Label>
                {/* The cut-off is the appraisal initiation date: set when the cycle is saved, not picked. */}
                <Input
                  readOnly
                  aria-label="Appraisal initiation date"
                  value={`Appraisal initiation date · ${formatDisplayDate(initiationDate)}`}
                />
                <FieldError message={e?.appraisal?.service_as_on?.message} />
              </div>
            </div>
            <Controller
              control={control}
              name="applicability.exclude_notice_period"
              render={({ field }) => (
                <Label className="flex cursor-pointer items-center gap-3 font-normal">
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                  Exclude Resigned / Notice Period
                </Label>
              )}
            />
          </RuleCard>
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-primary/10 px-4 py-3 text-sm text-primary">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            Employees who have not completed {Number.isFinite(appraisalMonths) ? appraisalMonths : 0}{" "}
            months on or before the appraisal initiation date — including{" "}
            <strong>Trainee and Probationary employees</strong> — get goals and can update progress,
            but the Self Appraisal (self rating) section stays closed for them.
          </p>
        </div>

        <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
          <Eye /> Show Eligible Employees Preview
        </Button>
      </div>

      <EligibleEmployeesDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        applicability={watch("applicability")}
      />
    </section>
  );
}

/** A titled card for one half of the rule (goal setting / appraisal). */
function RuleCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Red validation message under a field; renders nothing when there is no message. */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Employment-type checkboxes bound to one of the two rule halves. */
function EmploymentTypes({
  name,
  error,
  only,
}: {
  name:
    | "applicability.goal_setting.employment_types"
    | "applicability.appraisal.employment_types";
  error?: string;
  /** Limits the choices (the appraisal half offers Permanent only). */
  only?: PmsEmploymentType[];
}) {
  const { control } = useFormContext<PmsCycleUpsert>();
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">Employment Type</Label>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <div className="flex flex-wrap gap-5">
            {EMPLOYMENT_TYPE_OPTIONS.filter((o) => !only || only.includes(o.value)).map((o) => (
              <Label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 font-normal"
              >
                <Checkbox
                  checked={field.value.includes(o.value)}
                  onCheckedChange={(checked) =>
                    field.onChange(
                      checked
                        ? [...field.value, o.value]
                        : field.value.filter((t: PmsEmploymentType) => t !== o.value),
                    )
                  }
                />
                {o.label}
              </Label>
            ))}
          </div>
        )}
      />
      <FieldError message={error} />
    </div>
  );
}
