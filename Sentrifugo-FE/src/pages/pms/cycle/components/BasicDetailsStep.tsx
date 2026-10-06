import { Controller, useFormContext } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/shared/DatePicker";
import type { PmsCycleUpsert } from "@/types/pms";
import { APPRAISAL_TYPE_OPTIONS } from "../cycle.constants";
import { dateToIso, isoToDate } from "../../shared/pms.utils";
import { FormRow, StepSection } from "../../shared/FormRow";

/** Wizard step 1: cycle name, appraisal type, performance period and description. */
export function BasicDetailsStep() {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  const e = errors.basic;
  const periodStart = watch("basic.period_start");

  return (
    <section>
      <StepSection
        title="Basic Details"
        description="Name the cycle and set the performance period it covers."
      />
      <div className="space-y-4">
        <FormRow label="Cycle Name" required htmlFor="cycle-name" error={e?.name?.message}>
          <Input
            id="cycle-name"
            placeholder="e.g. FY 2026-27"
            aria-invalid={!!e?.name}
            {...register("basic.name")}
          />
        </FormRow>

        <FormRow label="Description" htmlFor="cycle-description" error={e?.description?.message}>
          <Textarea
            id="cycle-description"
            rows={3}
            placeholder="Annual Performance Appraisal for FY 2026-27"
            {...register("basic.description")}
          />
        </FormRow>

        <FormRow label="Appraisal Type" required error={e?.type?.message}>
          <Controller
            control={control}
            name="basic.type"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPRAISAL_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormRow>

        <FormRow
          label="Performance Period"
          required
          error={e?.period_start?.message ?? e?.period_end?.message}
        >
          <div className="grid grid-cols-2 gap-3">
            <Controller
              control={control}
              name="basic.period_start"
              render={({ field }) => (
                <DatePicker
                  value={isoToDate(field.value)}
                  onChange={(d) => field.onChange(dateToIso(d))}
                  placeholder="Start date"
                />
              )}
            />
            <Controller
              control={control}
              name="basic.period_end"
              render={({ field }) => (
                <DatePicker
                  value={isoToDate(field.value)}
                  onChange={(d) => field.onChange(dateToIso(d))}
                  minDate={isoToDate(periodStart)}
                  placeholder="End date"
                />
              )}
            />
          </div>
        </FormRow>
      </div>
    </section>
  );
}
