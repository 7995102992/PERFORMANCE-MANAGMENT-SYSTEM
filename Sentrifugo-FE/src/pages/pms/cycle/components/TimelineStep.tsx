import { Info } from "lucide-react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/shared/DatePicker";
import type { PmsCycleUpsert, PmsStageKey } from "@/types/pms";
import { STAGE_LABEL } from "../cycle.constants";
import { dateToIso, isoToDate } from "../../shared/pms.utils";
import { StepSection } from "../../shared/FormRow";

/** Midnight today: dates before it cannot be picked. */
const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** The later of two dates (either may be missing). */
const later = (a: Date, b?: Date) => (b && b > a ? b : a);

/**
 * Wizard step 2: start and end dates for each stage. Dates are suggested from the performance period
 * (see buildDefaultStages); the user can change them.
 */
export function TimelineStep() {
  const {
    control,
    getValues,
    setValue,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  // Live list of stages from the form, so the table updates as dates are edited.
  const stages = useWatch({ control, name: "stages" });
  // Dates cannot be picked in the past, nor before the performance period starts.
  const periodStart = useWatch({ control, name: "basic.period_start" });
  const earliest = later(today(), isoToDate(periodStart));
  const hasOverlap = Array.isArray(errors.stages) && errors.stages.some(Boolean);

  return (
    <section>
      <StepSection
        title="Timeline Configuration"
      />

      {hasOverlap && (
        <p
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          Some stage dates break the order or overlap another stage. Fix the dates marked below to continue.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-table-border bg-table-header text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5">Stage</th>
              <th className="px-3 py-2.5">Start Date</th>
              <th className="px-3 py-2.5">End Date</th>
              <th className="px-4 py-2.5 text-center">Notification</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((row, i) => {
              // This stage validation errors (start / end date messages).
              const rowError = errors.stages?.[i];
              return (
                <tr key={row.stage} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    {STAGE_LABEL[row.stage as PmsStageKey] ?? row.stage}
                  </td>
                  <td className="px-3 py-2.5">
                    <Controller
                      control={control}
                      name={`stages.${i}.start_date`}
                      render={({ field }) => (
                        <DatePicker
                          className="w-[9.5rem]"
                          value={isoToDate(field.value)}
                          minDate={earliest}
                          onChange={(d) => {
                            field.onChange(dateToIso(d));
                            // Keep end >= start: a start after the end clears the end so it is re-picked.
                            const end = isoToDate(getValues(`stages.${i}.end_date`));
                            if (d && end && end < d) setValue(`stages.${i}.end_date`, "", { shouldValidate: false });
                          }}
                        />
                      )}
                    />
                    {rowError?.start_date && (
                      <p role="alert" className="mt-1 max-w-[14rem] text-xs text-destructive">
                        {rowError.start_date.message}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Controller
                      control={control}
                      name={`stages.${i}.end_date`}
                      render={({ field }) => (
                        <DatePicker
                          className="w-[9.5rem]"
                          value={isoToDate(field.value)}
                          minDate={later(earliest, isoToDate(row.start_date))}
                          onChange={(d) => field.onChange(dateToIso(d))}
                        />
                      )}
                    />
                    {rowError?.end_date && (
                      <p role="alert" className="mt-1 max-w-[14rem] text-xs text-destructive">
                        {rowError.end_date.message}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-center">
                      <Controller
                        control={control}
                        name={`stages.${i}.notify`}
                        render={({ field }) => (
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            aria-label={`Notify for ${STAGE_LABEL[row.stage as PmsStageKey]}`}
                          />
                        )}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
