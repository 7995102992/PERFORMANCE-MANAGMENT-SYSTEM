import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  List,
  Loader2,
  Calendar as CalendarIcon,
} from "lucide-react";
import { useGetMyHolidaysQuery } from "@/store/api/lmsApi";
import type { MyCalendarHoliday } from "@/store/api/lmsApi";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FALLBACK_COLOR = "#6b7280";

/** Build from local Y/M/D — toISOString() shifts the date back a day in
 *  positive-offset zones such as IST. */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD as a LOCAL date. `new Date("2026-01-01")` is parsed as UTC
 *  midnight, which renders as the previous day west of Greenwich. */
function parseISODate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function formatLongDate(iso: string): string {
  return parseISODate(iso)
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .replace(/ /g, "-");
}

function ClassificationChip({ holiday }: { holiday: MyCalendarHoliday }) {
  const color = holiday.classification_color || FALLBACK_COLOR;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{
        color,
        borderColor: `${color}55`,
        backgroundColor: `${color}14`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {holiday.classification_name || "Holiday"}
    </span>
  );
}

const MyHolidays = () => {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [monthIndex, setMonthIndex] = useState<number>(() =>
    new Date().getMonth(),
  );

  const { data, isFetching } = useGetMyHolidaysQuery({ year });

  const yearOptions = useMemo(
    () => [currentYear - 1, currentYear, currentYear + 1],
    [currentYear],
  );

  const holidays = useMemo(
    () => [...(data?.holidays ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [data],
  );

  const todayStr = toISODate(new Date());
  const upcomingCount = useMemo(
    () => holidays.filter((h) => h.date >= todayStr).length,
    [holidays, todayStr],
  );

  /** date → holidays, for the calendar grid. */
  const holidayByDate = useMemo(() => {
    const map = new Map<string, MyCalendarHoliday[]>();
    for (const h of holidays) {
      const bucket = map.get(h.date) ?? [];
      bucket.push(h);
      map.set(h.date, bucket);
    }
    return map;
  }, [holidays]);

  /** Six-week grid covering the selected month, with leading/trailing spill. */
  const calendarCells = useMemo(() => {
    const firstDow = new Date(year, monthIndex, 1).getDay();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const cells: { dateStr: string; day: number; isCurrentMonth: boolean }[] = [];

    for (let i = firstDow; i > 0; i--) {
      const d = new Date(year, monthIndex, 1 - i);
      cells.push({ dateStr: toISODate(d), day: d.getDate(), isCurrentMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({
        dateStr: toISODate(new Date(year, monthIndex, d)),
        day: d,
        isCurrentMonth: true,
      });
    }
    const trailing = (cells.length <= 35 ? 35 : 42) - cells.length;
    for (let i = 1; i <= trailing; i++) {
      const d = new Date(year, monthIndex + 1, i);
      cells.push({ dateStr: toISODate(d), day: d.getDate(), isCurrentMonth: false });
    }
    return cells;
  }, [year, monthIndex]);

  const monthLabel = new Date(year, monthIndex, 1).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });

  // Month navigation stays inside the selected year — the payload only holds
  // that year, so stepping past December would render an empty month.
  const canGoPrevMonth = monthIndex > 0;
  const canGoNextMonth = monthIndex < 11;

  const hasPlan = Boolean(data?.plan_id);

  return (
    <div className="flex flex-col w-full h-[calc(100svh-7rem)] p-4 sm:p-8 font-sans overflow-hidden gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
            Holidays
            <span className="bg-primary/10 text-primary text-xs font-bold leading-none w-5 h-5 flex items-center justify-center rounded-full">
              {holidays.length}
            </span>
          </h1>
          <p className="text-xs text-muted-foreground truncate">
            {hasPlan ? (
              <>
                <span className="font-semibold text-foreground">
                  {data?.plan_name}
                </span>
                {upcomingCount > 0 && (
                  <> · {upcomingCount} upcoming</>
                )}
              </>
            ) : (
              "You are not assigned to a holiday plan yet"
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Select
            value={String(year)}
            onValueChange={(v) => {
              setYear(Number(v));
              setMonthIndex(Number(v) === currentYear ? new Date().getMonth() : 0);
            }}
          >
            <SelectTrigger size="sm" className="w-28 text-xs font-semibold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex border border-border rounded overflow-hidden">
            <button
              onClick={() => setView("list")}
              className={`px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 transition-colors ${view === "list" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            >
              <List size={12} /> List
            </button>
            <button
              onClick={() => setView("calendar")}
              className={`px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 border-l border-border transition-colors ${view === "calendar" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            >
              <CalendarIcon size={12} /> Calendar
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="bg-card border border-border shadow-sm rounded-xl flex-1 min-h-0 flex flex-col overflow-hidden">
        {isFetching ? (
          <div className="flex items-center justify-center flex-1 gap-2 text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Loading holidays…</span>
          </div>
        ) : holidays.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 text-muted-foreground">
            <CalendarDays size={28} className="opacity-40" />
            <span className="text-sm">
              {hasPlan
                ? `No holidays published for ${year}.`
                : "No holiday plan is assigned to you yet."}
            </span>
          </div>
        ) : view === "list" ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-table-header">
                <tr className="border-b border-table-border">
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide w-48">
                    Date
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide w-24">
                    Day
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Holiday
                  </th>
                  <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide w-48">
                    Type
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holidays.map((h) => {
                  const isPast = h.date < todayStr;
                  const isToday = h.date === todayStr;
                  return (
                    <tr
                      key={h.id}
                      className={`hover:bg-muted/50 transition-colors ${isPast ? "opacity-55" : ""}`}
                    >
                      <td className="px-6 py-3.5 font-semibold text-foreground whitespace-nowrap">
                        {formatLongDate(h.date)}
                        {isToday && (
                          <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary align-middle">
                            Today
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3.5 text-muted-foreground whitespace-nowrap">
                        {parseISODate(h.date).toLocaleDateString("en-GB", {
                          weekday: "long",
                        })}
                      </td>
                      <td className="px-6 py-3.5">
                        <div className="font-medium text-foreground">{h.name}</div>
                        {h.description && (
                          <div className="text-xs text-muted-foreground">
                            {h.description}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3.5">
                        <ClassificationChip holiday={h} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Month navigation */}
            <div className="flex items-center justify-center gap-2 border-b border-border px-4 py-3 shrink-0">
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 border border-border"
                onClick={() => setMonthIndex((m) => m - 1)}
                disabled={!canGoPrevMonth}
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-sm font-semibold min-w-[150px] text-center">
                {monthLabel}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 border border-border"
                onClick={() => setMonthIndex((m) => m + 1)}
                disabled={!canGoNextMonth}
              >
                <ChevronRight size={14} />
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto p-4">
              <div className="grid grid-cols-7 mb-1">
                {WEEKDAYS.map((d) => (
                  <div
                    key={d}
                    className="py-2 text-center text-[11px] font-bold text-muted-foreground uppercase tracking-wide"
                  >
                    {d}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 border-t border-l border-border rounded overflow-hidden">
                {calendarCells.map((cell) => {
                  const dayHolidays = holidayByDate.get(cell.dateStr) ?? [];
                  const isToday = cell.dateStr === todayStr;
                  return (
                    <div
                      key={cell.dateStr}
                      className={`min-h-[104px] border-r border-b border-border p-1.5 flex flex-col gap-1 ${cell.isCurrentMonth ? "" : "bg-muted/30"}`}
                    >
                      <span
                        className={`self-end text-[11px] font-semibold ${
                          isToday
                            ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                            : cell.isCurrentMonth
                              ? "text-foreground"
                              : "text-muted-foreground/60"
                        }`}
                      >
                        {cell.day}
                      </span>
                      {dayHolidays.map((h) => {
                        const color = h.classification_color || FALLBACK_COLOR;
                        return (
                          <div
                            key={h.id}
                            title={`${h.name}${h.classification_name ? ` · ${h.classification_name}` : ""}`}
                            className="truncate rounded px-1.5 py-1 text-[10px] font-semibold border-l-2"
                            style={{
                              color,
                              borderLeftColor: color,
                              backgroundColor: `${color}14`,
                            }}
                          >
                            {h.name}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5 shrink-0">
              {Array.from(
                new Map(
                  holidays.map((h) => [
                    h.classification_name || "Holiday",
                    h.classification_color || FALLBACK_COLOR,
                  ]),
                ),
              ).map(([name, color]) => (
                <span
                  key={name}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MyHolidays;
