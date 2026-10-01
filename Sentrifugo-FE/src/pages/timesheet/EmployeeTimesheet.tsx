import { useState, useMemo, useCallback, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  PlusCircle,
  Search,
  LayoutList,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";
import { EmptyState } from "@/components/shared/EmptyState";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import TimesheetEntry from "./TimesheetEntry";
import {
  useGetMyTimesheetsQuery,
  useGetMyTimesheetSummaryQuery,
} from "@/store/api/timesheetApi";
import {
  useGetMyCalendarQuery,
  useGetEmployeeWorkCalendarQuery,
} from "@/store/api/lmsApi";
import { useAppSelector } from "@/store";
import type {
  TimesheetStatus,
  WeeklyTimesheetResponse,
} from "@/types/timesheet";

const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  l1_approved: "Manager Approved",
  l1_rejected: "Manager Rejected",
  client_approved: "Final Approved",
  client_rejected: "Client Rejected",
  resubmitted: "Resubmitted",
  pending_approval: "Pending Approval",
};

const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

const RANGE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
// "Jun 01 – Jun 07, 2026"
const formatWeekRange = (start: string, end: string) => {
  const s = new Date(start);
  const e = new Date(end);
  const sStr = `${RANGE_MONTHS[s.getMonth()]} ${String(s.getDate()).padStart(2, "0")}`;
  const eStr = `${RANGE_MONTHS[e.getMonth()]} ${String(e.getDate()).padStart(2, "0")}`;
  return `${sStr} – ${eStr}, ${e.getFullYear()}`;
};

const getDaysInMonth = (year: number, month: number) =>
  new Date(year, month + 1, 0).getDate();

const formatDateKey = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

// Decimal hours → "HH:MM" (e.g. 8 → "08:00", 8.5 → "08:30")
const formatHHMM = (hours: number) => {
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// Per-day status label + colour, derived from the week's timesheet status
const dayStatusInfo = (
  status: string | undefined,
  opts?: { isHoliday?: boolean; isWeekoff?: boolean; hasHours?: boolean },
): { label: string; className: string } => {
  // Non-working days with nothing logged read as the day type, not "No Entry"
  if (!opts?.hasHours && !status) {
    if (opts?.isHoliday)
      return { label: "Holiday", className: "text-muted-foreground/70" };
    if (opts?.isWeekoff)
      return { label: "Week Off", className: "text-muted-foreground/60" };
  }
  switch (status) {
    case "l1_approved":
    case "client_approved":
      return { label: "Approved", className: "text-success" };
    case "submitted":
    case "resubmitted":
    case "pending_approval":
      return { label: "Pending Approval", className: "text-info" };
    case "l1_rejected":
    case "client_rejected":
      return { label: "Rejected", className: "text-destructive" };
    case "draft":
      return { label: "Draft", className: "text-muted-foreground" };
    default:
      return { label: "No Entry", className: "text-muted-foreground/60" };
  }
};

type DailyEntry = { project_name: string; task_name: string; hours: number };

const todayISO = () => new Date().toISOString().slice(0, 10);

const EmployeeTimesheet = () => {
  const [timesheetSheetOpen, setTimesheetSheetOpen] = useState(false);
  const [timesheetSheetWeek, setTimesheetSheetWeek] = useState<
    string | undefined
  >(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"list" | "calendar">(() => {
    const saved = localStorage.getItem("sentrifugo-view-timesheet");
    return saved === "list" || saved === "calendar" ? saved : "calendar";
  });
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) =>
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Aggregate a week's daily entries into task-wise rows with per-day hours
  const weekDetailFor = (ts: WeeklyTimesheetResponse) => {
    const start = new Date(ts.week_start_date);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
    const dayKeys = days.map((d) =>
      formatDateKey(d.getFullYear(), d.getMonth(), d.getDate()),
    );
    const groups = new Map<
      string,
      {
        project: string;
        task: string;
        perDay: Record<string, number>;
        total: number;
      }
    >();
    for (const [dateKey, entries] of Object.entries(ts.daily_entries ?? {})) {
      for (const e of entries) {
        const k = `${e.project_name}|||${e.task_name}`;
        let g = groups.get(k);
        if (!g) {
          g = {
            project: e.project_name,
            task: e.task_name,
            perDay: {},
            total: 0,
          };
          groups.set(k, g);
        }
        g.perDay[dateKey] = (g.perDay[dateKey] ?? 0) + e.hours;
        g.total += e.hours;
      }
    }
    return { days, dayKeys, rows: Array.from(groups.values()) };
  };

  const { data, isLoading } = useGetMyTimesheetsQuery({
    page,
    page_size: pageSize,
    ...(!["all", "pending_approval", "approved_all", "rejected_all"].includes(
      statusFilter,
    )
      ? { timesheet_status: statusFilter as TimesheetStatus }
      : {}),
  });

  const { data: summaryData } = useGetMyTimesheetSummaryQuery();

  const timesheets = data?.items ?? [];

  const filteredTimesheets = useMemo(() => {
    let list = timesheets;
    if (statusFilter === "pending_approval") {
      list = list.filter(
        (ts) =>
          ts.timesheet_status === "submitted" ||
          ts.timesheet_status === "resubmitted",
      );
    } else if (statusFilter === "approved_all") {
      list = list.filter(
        (ts) =>
          ts.timesheet_status === "l1_approved" ||
          ts.timesheet_status === "client_approved",
      );
    } else if (statusFilter === "rejected_all") {
      list = list.filter(
        (ts) =>
          ts.timesheet_status === "l1_rejected" ||
          ts.timesheet_status === "client_rejected",
      );
    }
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(
      (ts) =>
        ts.week_start_date.toLowerCase().includes(q) ||
        ts.week_end_date.toLowerCase().includes(q) ||
        ts.project_names?.some((n) => n.toLowerCase().includes(q)) ||
        statusLabels[ts.timesheet_status]?.toLowerCase().includes(q),
    );
  }, [timesheets, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  const isFiltered = statusFilter !== "all" || search.trim() !== "";

  const calYear = calendarDate.getFullYear();
  const calMonth = calendarDate.getMonth();
  const daysInMonth = getDaysInMonth(calYear, calMonth);
  const firstDayOfWeek = new Date(calYear, calMonth, 1).getDay();

  // Full 5/6-week grid including leading + trailing days of adjacent months
  const calendarGrid = useMemo(() => {
    const totalCells = firstDayOfWeek + daysInMonth <= 35 ? 35 : 42;
    const start = new Date(calYear, calMonth, 1 - firstDayOfWeek);
    return Array.from({ length: totalCells }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return {
        day: d.getDate(),
        dateStr: formatDateKey(d.getFullYear(), d.getMonth(), d.getDate()),
        isCurrentMonth: d.getMonth() === calMonth,
      };
    });
  }, [calYear, calMonth, daysInMonth, firstDayOfWeek]);

  const calFrom = calendarGrid[0].dateStr;
  const calTo = calendarGrid[calendarGrid.length - 1].dateStr;

  const { data: calendarData } = useGetMyCalendarQuery({
    from: calFrom,
    to: calTo,
  });

  // Weekoffs from the employee's assigned work calendar
  const employeeId = useAppSelector((s) => s.auth.user?.id ?? "");
  const { data: employeeWorkCalendar } = useGetEmployeeWorkCalendarQuery(
    employeeId,
    { skip: !employeeId },
  );
  const weekendMatrix = employeeWorkCalendar?.weekend_matrix ?? null;

  const isWeekoff = useCallback(
    (dateStr: string) => {
      if (!weekendMatrix) return false;
      const [, , d] = dateStr.split("-").map(Number);
      const jsDay = new Date(dateStr + "T00:00:00").getDay();
      const matrixDayIndex = (jsDay + 6) % 7; // 0=Mon...6=Sun
      const weekPattern = weekendMatrix[String(Math.min(Math.ceil(d / 7), 5))];
      if (!weekPattern) return false;
      // Matrix convention: 1=working, 0=off
      return weekPattern[matrixDayIndex] === 0;
    },
    [weekendMatrix],
  );

  const leavesByDate = useMemo(() => {
    const map = new Map<string, NonNullable<typeof calendarData>["leaves"]>();
    if (!calendarData?.leaves) return map;
    for (const leave of calendarData.leaves) {
      const cur = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      while (cur <= end) {
        const key = formatDateKey(
          cur.getFullYear(),
          cur.getMonth(),
          cur.getDate(),
        );
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(leave);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }, [calendarData]);

  const holidaysByDate = useMemo(() => {
    const map = new Map<string, NonNullable<typeof calendarData>["holidays"]>();
    if (!calendarData?.holidays) return map;
    for (const h of calendarData.holidays) {
      const d = new Date(h.date);
      const key = formatDateKey(d.getFullYear(), d.getMonth(), d.getDate());
      map.set(key, [h]);
    }
    return map;
  }, [calendarData]);

  // Both views read from filteredTimesheets so the search box, the status
  // dropdown and the stat cards drive the calendar exactly as they drive the
  // list — a day whose week is filtered out shows as empty rather than stale.
  const timesheetByDate = useMemo(() => {
    const map = new Map<string, WeeklyTimesheetResponse>();
    for (const ts of filteredTimesheets) {
      const start = new Date(ts.week_start_date);
      const end = new Date(ts.week_end_date);
      const cur = new Date(start);
      while (cur <= end) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        map.set(key, ts);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }, [filteredTimesheets]);

  const dailyEntriesByDate = useMemo(() => {
    const map = new Map<string, DailyEntry[]>();
    for (const ts of filteredTimesheets) {
      if (!ts.daily_entries) continue;
      for (const [dateKey, entries] of Object.entries(ts.daily_entries)) {
        map.set(dateKey, entries);
      }
    }
    return map;
  }, [filteredTimesheets]);

  const monthTotalHours = useMemo(() => {
    let total = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const key = formatDateKey(calYear, calMonth, day);
      const entries = dailyEntriesByDate.get(key);
      if (entries) total += entries.reduce((s, e) => s + e.hours, 0);
    }
    return Math.round(total * 10) / 10;
  }, [dailyEntriesByDate, calYear, calMonth, daysInMonth]);

  const handleNewTimesheet = () => {
    setTimesheetSheetWeek(undefined);
    setTimesheetSheetOpen(true);
  };

  const handleTimesheetClick = (ts: WeeklyTimesheetResponse) => {
    setTimesheetSheetWeek(ts.week_start_date);
    setTimesheetSheetOpen(true);
  };

  const handleDateClick = (dateKey: string) => {
    const ts = timesheetByDate.get(dateKey);
    setTimesheetSheetWeek(ts ? ts.week_start_date : dateKey);
    setTimesheetSheetOpen(true);
  };

  const handlePillClick = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const toggleView = () => {
    setViewMode((v) => {
      const next = v === "calendar" ? "list" : "calendar";
      localStorage.setItem("sentrifugo-view-timesheet", next);
      return next;
    });
  };

  const statCards = [
    {
      label: "All Timesheets",
      value: "all",
      count: summaryData?.total ?? 0,
      icon: FileText,
    },
    {
      label: "Approved",
      value: "approved_all",
      count:
        (summaryData?.l1_approved ?? 0) + (summaryData?.client_approved ?? 0),
      icon: CheckCircle2,
    },
    {
      label: "Rejected",
      value: "rejected_all",
      count:
        (summaryData?.l1_rejected ?? 0) + (summaryData?.client_rejected ?? 0),
      icon: XCircle,
    },
    {
      label: "Drafts",
      value: "draft",
      count: summaryData?.draft ?? 0,
      icon: Clock,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Timesheets"
        subtitle="Track and submit your weekly timesheets"
        action={
          <Button onClick={handleNewTimesheet}>
            <PlusCircle className="size-4 mr-1.5" />
            New Timesheet
          </Button>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const isActive = statusFilter === card.value;
          const Icon = card.icon;
          return (
            <button
              key={card.value}
              onClick={() => handlePillClick(card.value)}
              className={`flex items-center justify-between rounded-xl border px-5 py-4 text-left transition-colors cursor-pointer ${
                isActive
                  ? "bg-primary/5 border-primary/20"
                  : "bg-card hover:bg-muted/50"
              }`}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {card.label}
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {card.count}
                </p>
              </div>
              <Icon className="size-8 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
      </div>

      {/* Main card: toolbar + calendar / list */}
      <div className="rounded-xl border bg-card overflow-x-auto">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative w-52">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search"
              className="pl-9 h-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <Select value={statusFilter} onValueChange={handlePillClick}>
            <SelectTrigger className="w-52 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending_approval">Pending Approval</SelectItem>
              <SelectItem value="approved_all">Approved</SelectItem>
              <SelectItem value="rejected_all">Rejected</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-2"
            onClick={toggleView}
          >
            {viewMode === "calendar" ? (
              <LayoutList className="size-4" />
            ) : (
              <CalendarDays className="size-4" />
            )}
            {viewMode === "calendar" ? "List View" : "Calendar View"}
          </Button>
        </div>

        {/* Loading */}
        {isLoading ? (
          <PageLoader message="Loading timesheets..." />
        ) : viewMode === "calendar" ? (
          <div className="flex flex-col gap-3 p-4">
            {/* Calendar — same shell, header and cell sizing as the leave calendar */}
            <div className="flex flex-col overflow-x-auto rounded-xl border border-border bg-card">
              {/* Calendar header */}
              <div className="flex flex-shrink-0 items-center justify-between border-b px-4 py-3">
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() =>
                      setCalendarDate(new Date(calYear, calMonth - 1, 1))
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <h3 className="min-w-[130px] text-center text-sm font-semibold text-foreground">
                    {MONTHS_FULL[calMonth]} {calYear}
                  </h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() =>
                      setCalendarDate(new Date(calYear, calMonth + 1, 1))
                    }
                  >
                    <ChevronRight />
                  </Button>
                </div>
                <div className="flex items-center gap-3">
                  {/* Empty-looking cells are usually the filter, not missing
                      data — say so rather than letting the user wonder */}
                  {isFiltered && (
                    <span className="rounded-pill bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      Filtered
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Total —{" "}
                    <span className="font-bold text-foreground">
                      {monthTotalHours}h
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => setCalendarDate(new Date())}
                    className="h-auto rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                  >
                    Today
                  </Button>
                </div>
              </div>

              {/* Day headers */}
              <div className="grid flex-shrink-0 grid-cols-7 border-b border-table-border bg-table-header">
                {DAY_HEADERS.map((day) => (
                  <div
                    key={day}
                    className="border-r border-table-border px-3 py-2.5 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
                  >
                    {day}
                  </div>
                ))}
              </div>

              {/* Calendar cells */}
              <div
                className="grid grid-cols-7 text-sm"
                style={{ gridAutoRows: "1fr", minHeight: 500 }}
              >
                {calendarGrid.map((cell, i) => {
                  const dateKey = cell.dateStr;
                  const inMonth = cell.isCurrentMonth;
                  const today = todayISO();
                  const dayEntries = dailyEntriesByDate.get(dateKey) ?? [];
                  const dayTotal = dayEntries.reduce((s, e) => s + e.hours, 0);
                  const ts = timesheetByDate.get(dateKey);
                  const dayLeaves = leavesByDate.get(dateKey) ?? [];
                  const dayHolidays = holidaysByDate.get(dateKey) ?? [];
                  const cellIsWeekoff = inMonth && isWeekoff(dateKey);
                  const isToday = dateKey === today;
                  const isFutureDay = dateKey > today;
                  const clickable = inMonth && !isFutureDay;
                  const isRightEdge = (i + 1) % 7 === 0;
                  const st = dayStatusInfo(ts?.timesheet_status, {
                    isHoliday: dayHolidays.length > 0,
                    isWeekoff: cellIsWeekoff,
                    hasHours: dayTotal > 0,
                  });

                  const holidayColor = dayHolidays[0]?.classification_color;
                  const cellBg =
                    inMonth && dayHolidays.length > 0 && holidayColor
                      ? `${holidayColor}14`
                      : undefined;

                  return (
                    <div
                      key={dateKey}
                      className={`flex flex-col justify-between overflow-hidden border-b p-2 ${
                        !isRightEdge ? "border-r" : ""
                      } border-table-border ${
                        !inMonth
                          ? "bg-muted/20"
                          : isToday
                            ? "bg-primary/5"
                            : dayLeaves.length > 0
                              ? "bg-warning/10"
                              : cellIsWeekoff
                                ? "bg-muted"
                                : ""
                      } ${
                        clickable
                          ? "cursor-pointer transition-colors hover:bg-muted/30"
                          : inMonth
                            ? "cursor-default opacity-40"
                            : "cursor-default"
                      }`}
                      style={cellBg ? { backgroundColor: cellBg } : undefined}
                      onClick={
                        clickable ? () => handleDateClick(dateKey) : undefined
                      }
                    >
                      {/* Top: day number + labels */}
                      <div className="min-w-0">
                        <div className="flex justify-end">
                          <span
                            className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                              !inMonth
                                ? "text-muted-foreground/40"
                                : isToday
                                  ? "bg-primary font-bold text-primary-foreground"
                                  : "bg-table-header text-muted-foreground"
                            }`}
                          >
                            {cell.day}
                          </span>
                        </div>
                        {cellIsWeekoff && (
                          <div className="text-[9px] font-semibold uppercase leading-tight text-muted-foreground/50">
                            WO
                          </div>
                        )}
                        {inMonth &&
                          dayHolidays.map((h) => (
                            <div
                              key={h.id}
                              className="mt-1 flex items-center gap-1"
                              title={`${h.name} (${h.classification_name})`}
                            >
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-warning"
                                style={
                                  h.classification_color
                                    ? {
                                        backgroundColor: h.classification_color,
                                      }
                                    : undefined
                                }
                              />
                              <span className="truncate text-[11px] font-medium leading-tight text-foreground">
                                {h.name}
                              </span>
                            </div>
                          ))}
                        {inMonth && dayLeaves.length > 0 && (
                          <div
                            className="mt-1 flex items-center gap-1"
                            title={dayLeaves
                              .map((l) => `${l.leave_type_name} · ${l.status}`)
                              .join(", ")}
                          >
                            <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                            <span className="truncate text-[11px] leading-tight text-muted-foreground">
                              {dayLeaves[0].leave_type_name || "Leave"}
                              {dayLeaves[0].duration_mode === "HALF_DAY"
                                ? " (½)"
                                : ""}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Bottom: worked hours + status — current month only */}
                      {inMonth && (
                        <div className="flex items-center justify-between gap-1">
                          <span
                            className={`text-sm tabular-nums leading-none ${
                              dayTotal > 0
                                ? "font-semibold text-foreground"
                                : "text-muted-foreground"
                            }`}
                          >
                            {formatHHMM(dayTotal)}
                          </span>
                          <span
                            className={`text-[10px] font-medium leading-none ${st.className}`}
                          >
                            {st.label}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Legend */}
            <div className="flex flex-shrink-0 flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
              {[
                ["bg-success", "Approved"],
                ["bg-info", "Pending Approval"],
                ["bg-destructive", "Rejected"],
                ["bg-muted-foreground/50", "Draft"],
                ["bg-warning", "Holiday / Leave"],
              ].map(([dot, label]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className={`size-2 rounded-full ${dot}`} />
                  {label}
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded border border-border bg-muted" />
                Week Off
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* List view */}
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Week
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Project
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-center h-10">
                    Total Hours
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Submitted On
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTimesheets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="p-0">
                      <EmptyState
                        icon={FileText}
                        title="No timesheets found"
                        description='Click "New Timesheet" to create one'
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTimesheets.map((ts) => {
                    const isFutureWeek = ts.week_start_date > todayISO();
                    const isExpanded = expandedWeeks.has(ts.id);
                    const detail = isExpanded ? weekDetailFor(ts) : null;
                    return (
                      <Fragment key={ts.id}>
                        <TableRow
                          className={
                            isFutureWeek
                              ? "opacity-50 cursor-default pointer-events-none"
                              : "cursor-pointer"
                          }
                          onClick={
                            isFutureWeek
                              ? undefined
                              : () => handleTimesheetClick(ts)
                          }
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleExpand(ts.id);
                                }}
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={isExpanded ? "Collapse" : "Expand"}
                              >
                                <ChevronRight
                                  className={`size-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                                />
                              </button>
                              <span>
                                {formatWeekRange(
                                  ts.week_start_date,
                                  ts.week_end_date,
                                )}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {ts.project_names?.length
                              ? ts.project_names.join(", ")
                              : "-"}
                          </TableCell>
                          <TableCell className="text-center font-semibold">
                            {ts.total_hours}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {ts.submitted_at
                              ? formatDate(ts.submitted_at)
                              : "-"}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              status={
                                ts.timesheet_status as Parameters<
                                  typeof StatusBadge
                                >[0]["status"]
                              }
                            />
                          </TableCell>
                        </TableRow>
                        {isExpanded && detail && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={5} className="p-0">
                              <div className="px-4 py-3">
                                {detail.rows.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">
                                    No entries for this week.
                                  </p>
                                ) : (
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-muted-foreground">
                                        <th className="py-1.5 pr-3 text-left font-medium">
                                          Project
                                        </th>
                                        <th className="py-1.5 pr-3 text-left font-medium">
                                          Task
                                        </th>
                                        {detail.days.map((d, i) => (
                                          <th
                                            key={i}
                                            className="px-1.5 py-1.5 text-center font-medium whitespace-nowrap"
                                          >
                                            {DAY_HEADERS[d.getDay()]}{" "}
                                            {String(d.getDate()).padStart(
                                              2,
                                              "0",
                                            )}
                                          </th>
                                        ))}
                                        <th className="py-1.5 pl-3 text-right font-medium">
                                          Total
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.rows.map((r, ri) => (
                                        <tr
                                          key={ri}
                                          className="border-t border-border/60"
                                        >
                                          <td className="py-1.5 pr-3 text-foreground">
                                            {r.project}
                                          </td>
                                          <td className="py-1.5 pr-3 text-muted-foreground">
                                            {r.task}
                                          </td>
                                          {detail.dayKeys.map((dk, i) => (
                                            <td
                                              key={i}
                                              className="px-1.5 py-1.5 text-center tabular-nums text-foreground"
                                            >
                                              {r.perDay[dk] ? (
                                                r.perDay[dk]
                                              ) : (
                                                <span className="text-muted-foreground/40">
                                                  -
                                                </span>
                                              )}
                                            </td>
                                          ))}
                                          <td className="py-1.5 pl-3 text-right font-semibold tabular-nums text-foreground">
                                            {r.total}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>

            {(data?.total ?? 0) > 0 && (
              <div className="flex items-center justify-end px-4 py-3 text-sm text-muted-foreground border-t">
                <TablePagination
                  currentPage={page}
                  totalPages={totalPages}
                  startIndex={(page - 1) * pageSize + 1}
                  endIndex={Math.min(page * pageSize, data?.total ?? 0)}
                  total={data?.total ?? 0}
                  pageSize={pageSize}
                  onPageChange={(p) => setPage(p)}
                  onPageSizeChange={(s) => {
                    setPageSize(s);
                    setPage(1);
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      <Sheet
        open={timesheetSheetOpen}
        onOpenChange={(v) => {
          if (!v) setTimesheetSheetOpen(false);
        }}
      >
        <SheetContent className="w-[80vw] max-w-[80vw] flex flex-col p-0">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {timesheetSheetOpen && (
              <TimesheetEntry
                embedded
                initialWeek={timesheetSheetWeek}
                onClose={() => setTimesheetSheetOpen(false)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default EmployeeTimesheet;
