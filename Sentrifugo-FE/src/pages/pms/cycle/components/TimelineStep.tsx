import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/shared/DatePicker";
import type { PmsCycleUpsert, PmsStageKey } from "@/types/pms";
import { STAGE_LABEL } from "../cycle.constants";
import { dateToIso, isoToDate } from "../../shared/pms.utils";
import { StepSection } from "../../shared/FormRow";

const DAY = 86_400_000;

const time = (iso: string) => isoToDate(iso)?.getTime();

/**
 * Wizard step 2: start and end dates for each stage. Dates are suggested from the performance period
 * (see buildDefaultStages); the user can change them.
 */
export function TimelineStep() {
  const {
    control,
    formState: { errors },
  } = useFormContext<PmsCycleUpsert>();
  const stages = useWatch({ control, name: "stages" });

  // Bars are drawn against the span of the whole cycle so overlaps between
  // stages (goal setting vs acknowledgement) read at a glance.
  const starts = stages.map((s) => time(s.start_date)).filter((t): t is number => !!t);
  const ends = stages.map((s) => time(s.end_date)).filter((t): t is number => !!t);
  const min = Math.min(...starts);
  const span = Math.max(...ends) - min || DAY;

  return (
    <section>
      <StepSection
        title="Timeline Configuration"
      />

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
              const rowError = errors.stages?.[i];
              const s = time(row.start_date);
              const e = time(row.end_date);
              const left = s ? ((s - min) / span) * 100 : 0;
              const width = s && e ? Math.max(((e - s) / span) * 100, 1.5) : 0;
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
                          onChange={(d) => field.onChange(dateToIso(d))}
                        />
                      )}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Controller
                      control={control}
                      name={`stages.${i}.end_date`}
                      render={({ field }) => (
                        <DatePicker
                          className="w-[9.5rem]"
                          value={isoToDate(field.value)}
                          onChange={(d) => field.onChange(dateToIso(d))}
                        />
                      )}
                    />
                    {(rowError?.end_date || rowError?.start_date) && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {rowError.end_date?.message ?? rowError.start_date?.message}
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
