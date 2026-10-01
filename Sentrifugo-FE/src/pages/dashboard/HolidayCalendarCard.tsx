import { addMonths, format, parseISO } from "date-fns";
import { CalendarDays } from "lucide-react";

import {
  useGetMyCalendarQuery,
  type MyCalendarHoliday,
} from "@/store/api/lmsApi";
import { DashCard, DashEmpty, DashList, DashSpinner } from "./dashboardUi";

const FALLBACK_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const iso = (d: Date) => format(d, "yyyy-MM-dd");

function colorFor(h: MyCalendarHoliday, i: number): string {
  return h.classification_color || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}

export function HolidayCalendarCard() {
  const today = new Date();
  const { data, isLoading } = useGetMyCalendarQuery({
    from: iso(today),
    to: iso(addMonths(today, 12)),
  });
  const holidays = (data?.holidays ?? []).slice(0, 7);

  return (
    <DashCard className="h-[340px]">
      <h3 className="mb-3 text-sm font-semibold text-foreground tracking-tight">
        Holiday Calendar
      </h3>
      {isLoading ? (
        <DashSpinner />
      ) : holidays.length > 0 ? (
        <DashList>
          {holidays.map((h, i) => (
            <div
              key={h.id}
              className="flex items-center gap-2.5 py-2.5 text-[13px] first:pt-0"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorFor(h, i) }}
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {h.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {format(parseISO(h.date), "dd-MMM-yyyy")}
              </span>
            </div>
          ))}
        </DashList>
      ) : (
        <DashEmpty icon={CalendarDays} label="No upcoming holidays." />
      )}
    </DashCard>
  );
}
