import { useState } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/shared/DatePicker";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  useGetPmsDepartmentsQuery,
  useGetPmsPlantsQuery,
} from "@/store/api/pmsApi";
import type { PmsCycleUpsert, PmsEmploymentType } from "@/types/pms";
import { EMPLOYMENT_TYPE_OPTIONS } from "../cycle.constants";
import { dateToIso, isoToDate } from "../../shared/pms.utils";
import { EligibleEmployeesDialog } from "./EligibleEmployeesDialog";
import { FormRow, StepSection } from "../../shared/FormRow";

export function ApplicabilityStep() {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  const e = errors.applicability;
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: plants = [], isLoading: plantsLoading } = useGetPmsPlantsQuery();
  const { data: departments = [] } = useGetPmsDepartmentsQuery();

  const allDepartments = watch("applicability.all_departments");

  return (
    <section>
      <StepSection
        title="Applicability"
        description="Choose who is covered by this cycle."
      />
      <div className="space-y-4">
        <FormRow label="Applicable Plants" required error={e?.plant_ids?.message}>
          <Controller
            control={control}
            name="applicability.plant_ids"
            render={({ field }) => (
              <SearchableSelect
                multi
                loading={plantsLoading}
                options={plants.map((p) => ({ label: p.name, value: p.id }))}
                value={field.value}
                onChange={(v) => field.onChange(v as string[])}
                placeholder="Select plants"
              />
            )}
          />
        </FormRow>

        <FormRow label="Departments" error={e?.department_ids?.message}>
          <div className="space-y-3">
            <Controller
              control={control}
              name="applicability.all_departments"
              render={({ field }) => (
                <RadioGroup
                  className="flex gap-5"
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

        <FormRow label="Employment Type" required error={e?.employment_types?.message}>
          <Controller
            control={control}
            name="applicability.employment_types"
            render={({ field }) => (
              <div className="flex flex-wrap gap-5 pt-1.5">
                {EMPLOYMENT_TYPE_OPTIONS.map((o) => (
                  <Label key={o.value} className="flex cursor-pointer items-center gap-2 font-normal">
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
        </FormRow>

        <FormRow
          label="Minimum Service (Months)"
          required
          htmlFor="min-service"
          error={e?.min_service_months?.message}
        >
          <Input
            id="min-service"
            type="number"
            min={0}
            className="w-28"
            aria-invalid={!!e?.min_service_months}
            {...register("applicability.min_service_months", { valueAsNumber: true })}
          />
        </FormRow>

        <FormRow
          label="Service calculated as on"
          required
          error={e?.service_as_on?.message}
        >
          <Controller
            control={control}
            name="applicability.service_as_on"
            render={({ field }) => (
              <DatePicker
                className="w-[11rem]"
                value={isoToDate(field.value)}
                onChange={(d) => field.onChange(dateToIso(d))}
              />
            )}
          />
        </FormRow>

        <FormRow label="Exclude Probation Employees">
          <Controller
            control={control}
            name="applicability.exclude_probation"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} className="mt-2" />
            )}
          />
        </FormRow>

        <FormRow label="Exclude Resigned / Notice Period">
          <Controller
            control={control}
            name="applicability.exclude_notice_period"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} className="mt-2" />
            )}
          />
        </FormRow>

        <div className="sm:pl-[17.5rem]">
          <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
            <Eye /> Show Eligible Employees Preview
          </Button>
        </div>
      </div>

      <EligibleEmployeesDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        applicability={watch("applicability")}
      />
    </section>
  );
}
