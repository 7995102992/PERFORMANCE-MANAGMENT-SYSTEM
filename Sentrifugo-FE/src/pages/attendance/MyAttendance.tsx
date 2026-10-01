import { useState, useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  LogIn,
  LogOut,
  Timer,
  AlertCircle,
  LayoutList,
  RefreshCw,
  CreditCard,
  ScanFace,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { useGetMyMonthAttendanceQuery } from "@/store/api/attendanceApi";
import { useGetMyCalendarQuery } from "@/store/api/lmsApi";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type AttendanceStatus = "full" | "late" | "partial" | "no-time" | "weekend" | "holiday" | "leave";

interface PunchEntry {
  terminal_name?: string | null;
  time: string;
  type: "in" | "out";
  // Card number/ID when punched with an access card; empty/null = face-ID scan.
  card?: string | null;
}

interface AttendanceRecord {
  date: number;
  firstIn: string;
  lastOut: string;
  grossHours: string;
  netHours: string;
  punches: PunchEntry[];
  status: AttendanceStatus;
  leaveTypeName?: string | null;
  holidayName?: string | null;
}

type TimeFormat = "12h" | "24h";

const TIME_FORMAT_KEY = "sentrifugo-timeformat-attendance";

// Punch clock times arrive from the API as 24h "HH:mm" (sometimes "HH:mm:ss").
// Durations (total/work hours) are NOT clock times — never pass them through here.
function formatTime(time: string | undefined | null, format: TimeFormat) {
  if (!time) return "";
  if (format === "24h") return time;
  const [h, m] = time.split(":");
  const hour = Number(h);
  if (!m || Number.isNaN(hour)) return time;
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${m} ${suffix}`;
}

interface PunchPair {
  in: PunchEntry | null;
  out: PunchEntry | null;
}

function toMinutes(time: string) {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m || 0);
}

// Pair punches by walking the day in chronological order instead of zipping the
// in/out lists by index. Index-zipping shifts every row below a missing punch, so
// a gap in the morning surfaces as a "Missing" out at the very end of the day and
// the rows in between show overlapping in/out times that never happened.
function buildPunchPairs(punches: PunchEntry[]): PunchPair[] {
  const ordered = [...punches].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  const pairs: PunchPair[] = [];
  for (const punch of ordered) {
    const open = pairs[pairs.length - 1];
    if (punch.type === "in") {
      // An "in" always opens a new pair — if the previous one is still open it
      // stays open, and that is exactly the missing "out" we want to show.
      pairs.push({ in: punch, out: null });
    } else if (open && open.in && !open.out) {
      open.out = punch;
    } else {
      // An "out" with nothing open before it — a missing "in".
      pairs.push({ in: null, out: punch });
    }
  }
  return pairs;
}

// Odd punch = unpaired punches (an "in" without its "out", or vice versa),
// not simply "more than one in/out pair".
function hasOddPunch(punches: PunchEntry[] | undefined) {
  if (!punches?.length) return false;
  const ins = punches.filter((p) => p.type === "in").length;
  return ins !== punches.length - ins;
}

// A day is "full" at 8 hours or more of total (gross) time — green — and short
// of that it reads red. This drives every time shown in the cell, so the whole
// day is legible at a glance without decoding the API's status field.
const FULL_DAY_MINUTES = 8 * 60;
const FULL_DAY_TEXT = "text-[#1a7a3a]";
const SHORT_DAY_TEXT = "text-[#EF4444]";

// Total hours arrive as "H:MM" (e.g. "8:02"), not as a decimal.
function isFullDay(grossHours: string | undefined) {
  if (!grossHours) return false;
  const [h, m] = grossHours.split(":");
  const hours = Number(h);
  if (Number.isNaN(hours)) return false;
  return hours * 60 + Number(m || 0) >= FULL_DAY_MINUTES;
}

// Colour any duration ("H:MM") by the same ≥8h rule — green when full, red
// when short. Lets work hours read independently of total hours.
function hoursColor(hours: string | undefined) {
  return isFullDay(hours) ? FULL_DAY_TEXT : SHORT_DAY_TEXT;
}

type AttendanceView = "calendar" | "list";

const VIEW_KEY = "sentrifugo-view-my-attendance";

// Single source of truth for how a day reads, shared by the calendar cells and
// the list rows so the two views can never disagree.
function dayStatus(record: AttendanceRecord | undefined) {
  if (!record) return { label: "No data", text: "text-muted-foreground" };
  if (record.firstIn) {
    return isFullDay(record.grossHours)
      ? { label: "Full Day", text: FULL_DAY_TEXT }
      : { label: "Short Day", text: SHORT_DAY_TEXT };
  }
  if (record.status === "leave")
    return { label: record.leaveTypeName || "Leave", text: STATUS_COLORS.leave.text };
  if (record.status === "holiday")
    return { label: record.holidayName || "Holiday", text: STATUS_COLORS.holiday.text };
  if (record.status === "weekend") return { label: "Weekend", text: "text-muted-foreground" };
  // A day with no punches renders as a plain dash, not "Absent" — the biometric
  // feed only knows there were no punches, which isn't the same as an absence.
  if (record.status === "no-time") return { label: "-", text: "text-muted-foreground" };
  return { label: "No data", text: "text-muted-foreground" };
}

const CALENDAR_LEGEND = [
  { text: FULL_DAY_TEXT, label: "Full Day (≥8h)" },
  { text: SHORT_DAY_TEXT, label: "Short Day (<8h)" },
  { text: "text-muted-foreground", label: "Weekend / No data" },
];

const STATUS_COLORS: Record<AttendanceStatus, { bg: string; text: string; label: string }> = {
  full: { bg: "bg-[#d4f5e0]", text: "text-[#1a7a3a]", label: "Full Day (≥8h)" },
  late: { bg: "bg-[#fff3cd]", text: "text-[#b8860b]", label: "Late / Short" },
  partial: { bg: "bg-[#e8d5f5]", text: "text-[#7b2d8e]", label: "Partial" },
  "no-time": { bg: "bg-[#fce4e4]", text: "text-[#EF4444]", label: "No Time" },
  weekend: { bg: "bg-[#e8eeff]/60", text: "text-muted-foreground", label: "Weekend" },
  holiday: { bg: "bg-[#fff3cd]", text: "text-[#b8860b]", label: "Holiday" },
  leave: { bg: "bg-[#e0ecff]", text: "text-[#2563eb]", label: "Leave" },
};

function getCalendarDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  let startDay = firstDay.getDay() - 1;
  if (startDay < 0) startDay = 6;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const days: { day: number; inMonth: boolean; date: Date }[] = [];

  for (let i = startDay - 1; i >= 0; i--) {
    days.push({
      day: daysInPrevMonth - i,
      inMonth: false,
      date: new Date(year, month - 1, daysInPrevMonth - i),
    });
  }

  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }

  const remaining = 42 - days.length;
  for (let d = 1; d <= remaining; d++) {
    days.push({ day: d, inMonth: false, date: new Date(year, month + 1, d) });
  }

  return days;
}

function isToday(date: Date) {
  const now = new Date();
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  );
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_HEADERS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export default function MyAttendance() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState(now.getDate());
  const [punchDialogDay, setPunchDialogDay] = useState<number | null>(null);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(
    () => (localStorage.getItem(TIME_FORMAT_KEY) as TimeFormat) || "24h",
  );

  const changeTimeFormat = (next: TimeFormat) => {
    setTimeFormat(next);
    localStorage.setItem(TIME_FORMAT_KEY, next);
  };

  const [view, setView] = useState<AttendanceView>(
    () => (localStorage.getItem(VIEW_KEY) as AttendanceView) || "calendar",
  );

  const changeView = (next: AttendanceView) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  };

  const {
    data: apiMonthData,
    isFetching: isLoadingAttendance,
    isError,
    refetch,
  } = useGetMyMonthAttendanceQuery({ year, month: month + 1 });

  // The employee's own calendar — the same source the timesheet and leave
  // calendars read for holidays. Without it a company holiday reads as
  // "Absent" here, since the biometric system simply has no punch for it.
  const monthRange = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const last = new Date(year, month + 1, 0).getDate();
    return {
      from: `${year}-${pad(month + 1)}-01`,
      to: `${year}-${pad(month + 1)}-${pad(last)}`,
    };
  }, [year, month]);

  const { data: myCalendar } = useGetMyCalendarQuery(monthRange);

  // Holiday dates arrive as "YYYY-MM-DD"; match on the string prefix so no
  // Date parsing (and no UTC shift) can move a holiday to the wrong day.
  const holidayByDay = useMemo(() => {
    const map = new Map<number, string>();
    const prefix = `${monthRange.from.slice(0, 8)}`;
    for (const h of myCalendar?.holidays ?? []) {
      if (!h.date?.startsWith(prefix)) continue;
      map.set(Number(h.date.slice(8, 10)), h.name);
    }
    return map;
  }, [myCalendar, monthRange]);

  // Name/team come from the punch rows themselves — the biometric system is
  // the only source that knows which device user these punches belong to.
  const employeeLabel = useMemo(() => {
    const first = apiMonthData?.[0];
    if (!first) return "View your daily attendance records and punch details";
    return [first.user_name, first.group_name].filter(Boolean).join(" · ");
  }, [apiMonthData]);

  const hasMonthData = !!apiMonthData?.length;

  const records = useMemo(() => {
    const map = new Map<number, AttendanceRecord>();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const dow = date.getDay();
      if (dow === 0 || dow === 6) {
        map.set(d, { date: d, firstIn: "", lastOut: "", grossHours: "0:00", netHours: "0:00", punches: [], status: "weekend" });
      } else if (date < today && hasMonthData) {
        // Only call a past weekday absent when the month has punches at all.
        // With no data the honest answer is "nothing recorded", not "absent
        // every day" — which is what an unlinked biometric id would look like.
        map.set(d, { date: d, firstIn: "", lastOut: "", grossHours: "0:00", netHours: "0:00", punches: [], status: "no-time" });
      }
    }
    if (apiMonthData) {
      for (const a of apiMonthData) {
        const d = new Date(a.punch_date).getDate();
        map.set(d, {
          date: d,
          firstIn: a.first_in ?? "",
          lastOut: a.last_out ?? "",
          grossHours: a.total_hours ?? "0:00",
          netHours: a.work_hours ?? "0:00",
          punches: a.punches.map((p) => ({ time: p.time, type: p.type as "in" | "out", terminal_name: p.terminal_name, card: p.card })),
          status: (a.status as AttendanceStatus) || "no-time",
          leaveTypeName: a.leave_type_name,
        });
      }
    }
    // Holiday overlay — a day with no punches is a holiday, not an absence.
    // Punches win (someone did work that day) and so does an approved leave,
    // since that's what the employee's record actually says.
    for (const [d, name] of holidayByDay) {
      const rec = map.get(d);
      if (rec?.firstIn || rec?.status === "leave") continue;
      map.set(d, {
        date: d,
        firstIn: "",
        lastOut: "",
        grossHours: "0:00",
        netHours: "0:00",
        punches: [],
        ...rec,
        status: "holiday",
        holidayName: name,
      });
    }
    return map;
  }, [apiMonthData, hasMonthData, year, month, holidayByDay]);
  const calendarDays = useMemo(() => getCalendarDays(year, month), [year, month]);

  const attendedDays = useMemo(() => {
    let count = 0;
    records.forEach((r) => {
      if (r.status === "full" || r.status === "late" || r.status === "partial") count++;
    });
    return count;
  }, [records]);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const workingDays = useMemo(() => {
    let count = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month, d).getDay();
      // A company holiday is not a working day — counting it drags the
      // attendance percentage down for a day nobody was expected in.
      if (dow !== 0 && dow !== 6 && !holidayByDay.has(d)) count++;
    }
    return count;
  }, [year, month, daysInMonth, holidayByDay]);

  const attendancePercent = workingDays > 0 ? Math.round((attendedDays / workingDays) * 100) : 0;

  const prevMonth = () => {
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
    setSelectedDay(1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
    setSelectedDay(1);
  };
  // Jump back to the current month and select today, from wherever we've navigated.
  const goToToday = () => {
    const today = new Date();
    setYear(today.getFullYear());
    setMonth(today.getMonth());
    setSelectedDay(today.getDate());
  };

  const selectedRecord = records.get(selectedDay);
  const selectedDate = new Date(year, month, selectedDay);
  const selectedDateLabel = `${selectedDate.toLocaleDateString("en-GB", { weekday: "short" })}, ${selectedDate
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-")}`;

  const punches = selectedRecord?.punches ?? [];
  const isOddPunch = hasOddPunch(punches);
  const oddPunchLabel = punches.length === 0 ? "-" : isOddPunch ? "Yes" : "No";

  const detailCards = [
    { label: "Date", value: selectedDateLabel, icon: CalendarDays },
    { label: "First In", value: formatTime(selectedRecord?.firstIn, timeFormat) || "-", icon: LogIn },
    { label: "Last Out", value: formatTime(selectedRecord?.lastOut, timeFormat) || "-", icon: LogOut },
    { label: "Total Hours", value: selectedRecord?.grossHours || "-", icon: Clock },
    { label: "Work Hours", value: selectedRecord?.netHours || "-", icon: Timer },
    { label: "Odd Punch", value: oddPunchLabel, icon: AlertCircle },
  ];

  if (isLoadingAttendance) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="My Attendance" subtitle="View your daily attendance records and punch details" />
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">Loading attendance data...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="My Attendance" subtitle="View your daily attendance records and punch details" />
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={AlertCircle}
            variant="error"
            title="Couldn't load attendance"
            description="We couldn't reach the attendance service. Please try again in a moment."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="My Attendance" subtitle={employeeLabel} />

      {/* Detail cards for selected day */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {detailCards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">{label}</p>
              <p className={cn(
                "text-lg font-bold text-foreground mt-0.5",
                label === "Date" && "text-base whitespace-nowrap",
                label === "Odd Punch" && isOddPunch && "text-[#b8860b]",
              )}>
                {value}
              </p>
            </div>
            <Icon className={cn(
              "size-7 shrink-0 text-muted-foreground",
              label === "Odd Punch" && isOddPunch && "text-[#b8860b]",
            )} />
          </div>
        ))}
      </div>

      {!hasMonthData && (
        <div className="rounded-xl border bg-card px-5 py-3 text-sm text-muted-foreground">
          No attendance recorded for {MONTH_NAMES[month]} {year}.
        </div>
      )}

      <CalendarView
        year={year}
        month={month}
        calendarDays={calendarDays}
        records={records}
        attendancePercent={attendancePercent}
        selectedDay={selectedDay}
        onSelectDay={setSelectedDay}
        onOpenPunches={(day) => setPunchDialogDay(day)}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onToday={goToToday}
        timeFormat={timeFormat}
        onTimeFormatChange={changeTimeFormat}
        view={view}
        onViewChange={changeView}
        onRefresh={refetch}
        isRefreshing={isLoadingAttendance}
      />

      <PunchTimelineDialog
        open={punchDialogDay !== null}
        onOpenChange={(open) => { if (!open) setPunchDialogDay(null); }}
        date={punchDialogDay !== null ? new Date(year, month, punchDialogDay) : null}
        record={punchDialogDay !== null ? records.get(punchDialogDay) ?? null : null}
        timeFormat={timeFormat}
      />
    </div>
  );
}

function CalendarView({
  year,
  month,
  calendarDays,
  records,
  attendancePercent,
  selectedDay,
  onSelectDay,
  onOpenPunches,
  onPrevMonth,
  onNextMonth,
  onToday,
  timeFormat,
  onTimeFormatChange,
  view,
  onViewChange,
  onRefresh,
  isRefreshing,
}: {
  year: number;
  month: number;
  calendarDays: { day: number; inMonth: boolean; date: Date }[];
  records: Map<number, AttendanceRecord>;
  attendancePercent: number;
  selectedDay: number;
  onSelectDay: (day: number) => void;
  onOpenPunches: (day: number) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  view: AttendanceView;
  onViewChange: (view: AttendanceView) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden ">
      {/* Toolbar — month nav left, view toggle right, matching the timesheet calendar */}
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" onClick={onPrevMonth}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-semibold text-foreground min-w-[130px] text-center">
            {MONTH_NAMES[month]} {year}
          </span>
          <Button variant="ghost" size="icon" className="size-8" onClick={onNextMonth}>
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="outline" size="sm" className="ml-1 h-8" onClick={onToday}>
            Today
          </Button>
        </div>

        <span className="text-sm font-medium text-[#007CF0]">
          {attendancePercent}% attendance this month
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Clock format toggle — applies to every punch time on this page */}
          <div className="flex items-center rounded-lg border overflow-hidden">
            {(["12h", "24h"] as const).map((format) => (
              <Button
                key={format}
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 rounded-none px-2.5 text-xs font-medium",
                  timeFormat === format && "bg-accent",
                )}
                aria-pressed={timeFormat === format}
                onClick={() => onTimeFormatChange(format)}
              >
                {format}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            aria-label="Refresh attendance"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => onViewChange(view === "calendar" ? "list" : "calendar")}
          >
            {view === "calendar" ? <LayoutList className="size-4" /> : <CalendarDays className="size-4" />}
            {view === "calendar" ? "List View" : "Calendar View"}
          </Button>
        </div>
      </div>

      {view === "list" ? (
        <AttendanceListView
          calendarDays={calendarDays}
          records={records}
          selectedDay={selectedDay}
          onSelectDay={onSelectDay}
          onOpenPunches={onOpenPunches}
          timeFormat={timeFormat}
        />
      ) : (
      <>
      {/* Day headers */}
      <div className="grid grid-cols-7">
        {DAY_HEADERS.map((d) => (
          <div
            key={d}
            className="border-b border-r last:border-r-0 px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide text-center bg-table-header"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {calendarDays.map((day, i) => {
          const record = day.inMonth ? records.get(day.day) : undefined;
          const today = isToday(day.date);
          const dow = day.date.getDay();
          const isWeekend = dow === 0 || dow === 6;

          let textColor = "";

          if (!day.inMonth) {
            textColor = "text-muted-foreground/40";
          } else if (record?.firstIn) {
            // An odd punch is always short — force red regardless of hours.
            textColor = hasOddPunch(record.punches)
              ? SHORT_DAY_TEXT
              : isFullDay(record.grossHours) ? FULL_DAY_TEXT : SHORT_DAY_TEXT;
          } else if (record?.status === "leave") {
            textColor = STATUS_COLORS.leave.text;
          } else if (record?.status === "holiday") {
            textColor = STATUS_COLORS.holiday.text;
          } else if (record?.status === "no-time" || (today && !record)) {
            textColor = "text-muted-foreground";
          } else if (isWeekend) {
            textColor = "text-muted-foreground";
          }

          const isSelected = day.inMonth && day.day === selectedDay;
          const isOddPunchDay = !!(day.inMonth && record && hasOddPunch(record.punches));

          return (
            <div
              key={i}
              className={cn(
                "min-h-[104px] p-2 border-b border-r last:border-r-0 relative transition-colors flex flex-col",
                day.inMonth ? "bg-card cursor-pointer hover:bg-muted/30" : "bg-muted/20",
              )}
              onClick={() => {
                if (!day.inMonth) return;
                onSelectDay(day.day);
                const rec = records.get(day.day);
                if (rec && rec.firstIn) onOpenPunches(day.day);
              }}
            >
              {/* Top row — punch times on the left, date badge pinned top-right on
                  every cell regardless of what the day holds. */}
              <div className="flex items-start justify-end gap-2">
                <span className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  day.inMonth ? "bg-muted text-muted-foreground" : "text-muted-foreground/40",
                )}>
                  {String(day.day).padStart(2, "0")}
                </span>
              </div>

              {day.inMonth && record && record.firstIn ? (
                <div className="grid grid-cols-2 gap-1 mt-auto">
                  <div className="rounded bg-muted/10 px-1.5 py-1 text-center">
                    <p className="text-[7px] text-muted-foreground leading-none">TOTAL</p>
                    <p className={cn("text-[10px] font-medium leading-tight", textColor)}>{record.grossHours}</p>
                  </div>
                  <div className="rounded bg-muted/10 px-1.5 py-1 text-center">
                    <p className="text-[7px] text-muted-foreground leading-none">WORK</p>
                    <p className={cn("text-[10px] font-medium leading-tight", isOddPunchDay ? SHORT_DAY_TEXT : hoursColor(record.netHours))}>{record.netHours}</p>
                  </div>
                </div>
              ) : day.inMonth && record && record.status === "leave" ? (
                <div className="flex flex-1 items-center justify-center px-1">
                  <span className={cn("text-[10px] font-medium text-center leading-tight", STATUS_COLORS.leave.text)}>
                    {record.leaveTypeName || "Leave"}
                  </span>
                </div>
              ) : day.inMonth && record && (record.status === "no-time" || record.status === "holiday") ? (
                <div className="flex flex-1 items-center justify-center px-1">
                  <span
                    className={cn(
                      "text-[10px] font-medium text-center leading-tight",
                      record.status === "holiday"
                        ? STATUS_COLORS.holiday.text
                        : "text-muted-foreground",
                    )}
                    title={record.status === "holiday" ? record.holidayName ?? undefined : undefined}
                  >
                    {record.status === "holiday" ? record.holidayName || "Holiday" : "-"}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Legend — swatches are filled with the same colour the cell text uses,
          so what the legend shows is what the grid actually renders. */}
      <div className="flex items-center gap-6 px-5 py-3 border-t">
        {CALENDAR_LEGEND.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-full bg-current", item.text)} />
            <span className="text-xs text-muted-foreground">{item.label}</span>
          </div>
        ))}
        {/* No "Absent" swatch — days without punches render as a plain dash, so
            it would explain a colour that no longer appears in the grid. */}
        <div className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-full bg-current", STATUS_COLORS.leave.text)} />
          <span className="text-xs text-muted-foreground">Leave</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-full bg-current", STATUS_COLORS.holiday.text)} />
          <span className="text-xs text-muted-foreground">Holiday</span>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

const TH = "text-xs font-medium text-muted-foreground uppercase tracking-wide h-10";

function AttendanceListView({
  calendarDays,
  records,
  selectedDay,
  onSelectDay,
  onOpenPunches,
  timeFormat,
}: {
  calendarDays: { day: number; inMonth: boolean; date: Date }[];
  records: Map<number, AttendanceRecord>;
  selectedDay: number;
  onSelectDay: (day: number) => void;
  onOpenPunches: (day: number) => void;
  timeFormat: TimeFormat;
}) {
  const rows = calendarDays.filter((d) => d.inMonth);

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
          <TableHead className={TH}>Date</TableHead>
          <TableHead className={TH}>Day</TableHead>
          <TableHead className={TH}>First In</TableHead>
          <TableHead className={TH}>Last Out</TableHead>
          <TableHead className={TH}>Total Hours</TableHead>
          <TableHead className={TH}>Work Hours</TableHead>
          <TableHead className={TH}>Odd Punch</TableHead>
          <TableHead className={TH}>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={8} className="p-0">
              <EmptyState icon={CalendarDays} title="No days to show" description="Pick a different month to see attendance." />
            </TableCell>
          </TableRow>
        )}
        {rows.map(({ day, date }) => {
          const record = records.get(day);
          const status = dayStatus(record);
          const isOdd = !!record && hasOddPunch(record.punches);
          const hasTimes = !!record?.firstIn;
          return (
            <TableRow
              key={day}
              className={cn("cursor-pointer", day === selectedDay && "bg-primary/5")}
              onClick={() => {
                onSelectDay(day);
                if (hasTimes) onOpenPunches(day);
              }}
            >
              <TableCell className="text-sm font-medium text-foreground">
                {String(day).padStart(2, "0")} {MONTH_NAMES[date.getMonth()].slice(0, 3)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {date.toLocaleDateString("en-GB", { weekday: "short" })}
              </TableCell>
              <TableCell className={cn("text-sm", status.text)}>
                {formatTime(record?.firstIn, timeFormat) || "-"}
              </TableCell>
              <TableCell className={cn("text-sm", status.text)}>
                {formatTime(record?.lastOut, timeFormat) || "-"}
              </TableCell>
              <TableCell className={cn("text-sm font-medium", isOdd ? SHORT_DAY_TEXT : status.text)}>
                {hasTimes ? record.grossHours : "-"}
              </TableCell>
              <TableCell className={cn("text-sm", isOdd ? SHORT_DAY_TEXT : hasTimes ? hoursColor(record.netHours) : status.text)}>
                {hasTimes ? record.netHours : "-"}
              </TableCell>
              <TableCell className="text-sm">
                {isOdd ? (
                  <span className="inline-flex items-center gap-1 text-[#b8860b]">
                    <AlertCircle className="size-3.5" /> Yes
                  </span>
                ) : (
                  <span className="text-muted-foreground">{hasTimes ? "No" : "-"}</span>
                )}
              </TableCell>
              <TableCell className={cn("text-sm font-medium", status.text)}>{status.label}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Small indicator showing how a punch was captured: a card icon when the
// `card` column carries a card number/ID, otherwise a face-ID scan icon.
function PunchMethodIcon({ card }: { card?: string | null }) {
  const isCard = !!card && card.trim() !== "";
  const Icon = isCard ? CreditCard : ScanFace;
  const label = isCard ? "Card" : "Face ID";
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 text-muted-foreground" aria-label={label}>
            <Icon className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PunchTimelineDialog({
  open,
  onOpenChange,
  date,
  record,
  timeFormat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: Date | null;
  record: AttendanceRecord | null;
  timeFormat: TimeFormat;
}) {
  if (!date || !record) return null;

  const dateLabel = `${date.toLocaleDateString("en-GB", { weekday: "short" })}, ${date
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-")}`;

  const punchIns = record.punches.filter((p) => p.type === "in");
  const punchOuts = record.punches.filter((p) => p.type === "out");
  const pairs = buildPunchPairs(record.punches);
  const isOddPunch = punchIns.length !== punchOuts.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Punch Timeline</DialogTitle>
          <p className="text-sm text-muted-foreground">{dateLabel}</p>
        </DialogHeader>

        {isOddPunch && (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
            <AlertCircle className="size-4 text-destructive shrink-0" />
            <p className="text-xs font-medium text-destructive">
              Odd Punch — {punchIns.length} in, {punchOuts.length} out (mismatch)
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 mt-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Punch In</p>
            <div className="space-y-3">
              {pairs.map((pair, i) => {
                const punch = pair.in;
                // No "in" at all on this row — the pair is an orphan "out".
                const isMissing = !punch;
                // Has an "in" but never clocked back out.
                const isUnpaired = !!punch && !pair.out;
                return (
                  <div key={i} className="flex items-center gap-2.5 min-h-[36px]">
                    <div className={cn(
                      "size-3 rounded-full shrink-0 border-2",
                      isMissing ? "border-dashed border-muted-foreground/40 bg-transparent"
                        : isUnpaired ? "bg-destructive/20 border-destructive"
                        : "bg-primary/20 border-primary",
                    )} />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className={cn("text-sm font-medium", isMissing ? "text-destructive" : isUnpaired ? "text-destructive" : "text-foreground")}>
                          {punch ? formatTime(punch.time, timeFormat) : "Missing"}
                        </p>
                        {punch && <PunchMethodIcon card={punch.card} />}
                      </div>
                      {punch && (
                        <p className={cn("text-[11px]", isUnpaired ? "text-destructive/70" : "text-muted-foreground")}>
                          {punch.terminal_name ?? "Main Entrance"}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Punch Out</p>
            <div className="space-y-3">
              {pairs.map((pair, i) => {
                const punch = pair.out;
                const isMissing = !punch;
                return (
                  <div key={i} className="flex items-center gap-2.5 min-h-[36px]">
                    <div className={cn(
                      "size-3 rounded-full shrink-0 border-2",
                      isMissing ? "border-dashed border-destructive/40 bg-transparent" : "bg-destructive/20 border-destructive",
                    )} />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className={cn("text-sm font-medium", isMissing ? "text-destructive" : "text-foreground")}>
                          {punch ? formatTime(punch.time, timeFormat) : "Missing"}
                        </p>
                        {punch && <PunchMethodIcon card={punch.card} />}
                      </div>
                      {punch && (
                        <p className="text-[11px] text-muted-foreground">
                          {punch.terminal_name ?? "Main Exit"}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t">
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
            <p className="text-[10px] text-muted-foreground">TOTAL HOURS</p>
            <p className="text-sm font-semibold text-foreground">{record.grossHours}</p>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
            <p className="text-[10px] text-muted-foreground">WORK HOURS</p>
            <p className="text-sm font-semibold text-foreground">{record.netHours}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
