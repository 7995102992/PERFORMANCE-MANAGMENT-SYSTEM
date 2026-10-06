import { Controller, useFormContext } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/shared/DatePicker";
import { useGetPmsDepartmentsQuery, useGetPmsDesignationsQuery } from "@/store/api/pmsApi";
import { FormRow, StepSection } from "../../../shared/FormRow";
import { dateToIso, financialYearLabel, isoToDate } from "../../../shared/pms.utils";
import { financialYearOptions } from "../../config.constants";
import type { TemplateFormValues } from "../template.types";

/**
 * Goal template step 1 (screen 2.2): name, financial year, department, role / designation, plant,
 * effective date and status. Designations are loaded for the chosen department.
 */
export function TemplateBasicStep() {
  const {
    register,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<TemplateFormValues>();
  const e = errors.basic;
  const departmentId = watch("basic.department_id");

  const { data: departments = [] } = useGetPmsDepartmentsQuery();
  const { data: designations = [], isFetching: loadingDesignations } = useGetPmsDesignationsQuery(
    departmentId,
    { skip: !departmentId },
  );

  return (
    <section>
      <StepSection title="Template Details" />
      <div className="space-y-4">
        <FormRow label="Financial Year" required error={e?.financial_year?.message}>
          <Controller
            control={control}
            name="basic.financial_year"
            render={({ field }) => (
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {financialYearOptions().map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {financialYearLabel(y)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormRow>

        <FormRow label="Template Name" required htmlFor="tpl-name" error={e?.name?.message}>
          <Input
            id="tpl-name"
            placeholder="e.g. Production Engineer Template"
            aria-invalid={!!e?.name}
            {...register("basic.name")}
          />
        </FormRow>

        <FormRow label="Description" htmlFor="tpl-description" error={e?.description?.message}>
          <Textarea
            id="tpl-description"
            rows={3}
            placeholder="Annual goal template for Production Engineers"
            {...register("basic.description")}
          />
        </FormRow>

        <FormRow label="Department" required error={e?.department_id?.message}>
          <Controller
            control={control}
            name="basic.department_id"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v);
                  // A designation belongs to one department — the old pick no longer applies.
                  setValue("basic.designation_id", "", { shouldDirty: true });
                }}
              >
                <SelectTrigger className="w-full" aria-invalid={!!e?.department_id}>
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormRow>

        <FormRow
          label="Role / Designation"
          required
          error={e?.designation_id?.message}
          hint={!departmentId ? "Choose a department first" : undefined}
        >
          <Controller
            control={control}
            name="basic.designation_id"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={!departmentId || loadingDesignations}
              >
                <SelectTrigger className="w-full" aria-invalid={!!e?.designation_id}>
                  <SelectValue placeholder="Select role / designation" />
                </SelectTrigger>
                <SelectContent>
                  {designations.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormRow>

        <FormRow label="Effective From" required error={e?.effective_from?.message}>
          <Controller
            control={control}
            name="basic.effective_from"
            render={({ field }) => (
              <DatePicker
                value={isoToDate(field.value)}
                onChange={(d) => field.onChange(dateToIso(d))}
                placeholder="Pick a date"
              />
            )}
          />
        </FormRow>

        <FormRow label="Status">
          <Controller
            control={control}
            name="basic.status"
            render={({ field }) => (
              <RadioGroup
                className="flex gap-6 pt-2"
                value={field.value}
                onValueChange={field.onChange}
              >
                <Label className="flex cursor-pointer items-center gap-2 font-normal">
                  <RadioGroupItem value="active" /> Active
                </Label>
                <Label className="flex cursor-pointer items-center gap-2 font-normal">
                  <RadioGroupItem value="inactive" /> Inactive
                </Label>
              </RadioGroup>
            )}
          />
        </FormRow>
      </div>
    </section>
  );
}
