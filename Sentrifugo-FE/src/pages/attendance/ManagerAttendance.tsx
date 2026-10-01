import { useState, useMemo } from "react";
import { format, eachDayOfInterval, parseISO } from "date-fns";
import { toast } from "sonner";
import { store } from "@/store";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  LogIn,
  LogOut,
  AlertCircle,
  Users,
  Search,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  attendanceApi,
  useGetTeamDailyAttendanceQuery,
  useGetEmployeeMonthAttendanceQuery,
  type EmployeeDayAttendance,
} from "@/store/api/attendanceApi";
import { useWorkingDays, type WorkingDayRef } from "@/hooks/use-work-calendars";
import {
  useEmployeeHolidays,
  fetchEmployeeHolidayResolver,
  type EmployeeHolidayResolver,
} from "@/hooks/use-employee-holidays";
import { useGetTeamCalendarQuery } from "@/store/api/lmsApi";
import type { WorkingDayResponse } from "@/types/leave";

type AttendanceStatus = "full" | "late" | "partial" | "no-time" | "weekend" | "holiday" | "leave";

interface PunchEntry {
  time: string;
  type: "in" | "out";
}

interface EmployeeDayRecord {
  // Stable unique id per reportee (the employee's user id) — used for React keys
  // and row selection.
  employeeUserId: string;
  // The biometric terminal id — used to drill into the monthly calendar. May be
  // empty for a reportee who has never punched; the drill-in button is disabled
  // in that case.
  terminalUserId: string;
  employeeName: string;
  department: string;
  firstIn: string;
  lastOut: string;
  grossHours: string;
  netHours: string;
  punches: PunchEntry[];
  status: AttendanceStatus;
  leaveTypeName?: string | null;
}

interface EmployeeMonthRecord {
  date: number;
  firstIn: string;
  lastOut: string;
  grossHours: string;
  netHours: string;
  punches: PunchEntry[];
  status: AttendanceStatus;
  leaveTypeName?: string | null;
  holidayName?: string;
}

// Odd punch = unpaired punches (an "in" without its "out", or vice versa),
// not simply "more than one in/out pair".
function hasOddPunch(punches: PunchEntry[] | undefined) {
  if (!punches?.length) return false;
  const ins = punches.filter((p) => p.type === "in").length;
  return ins !== punches.length - ins;
}

const STATUS_COLORS: Record<AttendanceStatus, { bg: string; text: string; label: string }> = {
  full: { bg: "bg-[#d4f5e0]", text: "text-[#1a7a3a]", label: "Full Day" },
  late: { bg: "bg-muted", text: "text-muted-foreground", label: "Late / Short" },
  partial: { bg: "bg-[#fff3cd]", text: "text-[#b8860b]", label: "Partial" },
  // Label is a dash, not "Absent" — the screen renders these days as a dash, and
  // the export reads from the same map, so the CSV says exactly what the UI says.
  "no-time": { bg: "bg-[#fce4e4]", text: "text-[#c0392b]", label: "-" },
  weekend: { bg: "bg-[#e8eeff]/60", text: "text-muted-foreground", label: "Week Off" },
  holiday: { bg: "bg-[#fff3cd]", text: "text-[#b8860b]", label: "Holiday" },
  leave: { bg: "bg-[#e0ecff]", text: "text-[#2563eb]", label: "Leave" },
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (year: number, month: number, day: number) =>
  `${year}-${pad2(month + 1)}-${pad2(day)}`;

/** True when the lookup actually resolved against an assigned work calendar. */
const hasCalendar = (workingDay: WorkingDayResponse | undefined) =>
  !!workingDay?.calendar_id;

/**
 * `/attendance/team/daily` marks any day without punches as "no-time" (Absent)
 * — it does not consult the employee's work calendar. A week off, a holiday or
 * a non-rostered day therefore arrives looking like an absence, so we re-derive
 * it from `/working-day` before showing it.
 *
 * `is_working_day: false` on its own is NOT treated as a week off: the endpoint
 * also returns false when the employee has no calendar assigned at all, which
 * would paint every single day of the month as a week off. We only override
 * when a calendar actually resolved (`calendar_id` present). Otherwise the row
 * degrades to the API's own answer rather than inventing one.
 *
 * Holidays come from `useEmployeeHolidays` — the plan each reportee is actually
 * assigned to — and take precedence, since a holiday is more informative than
 * "week off" when the two collide. `/manager/team-calendar` is not used for
 * this: it returns one flat holiday list for the whole team, so reportees split
 * across different holiday plans would all get the same set.
 *
 * `workingDay.is_holiday` is deliberately NOT consulted: `/working-day` matches
 * holidays by department/business unit across every plan in the org rather than
 * by the employee's plan assignment, so it reports holidays belonging to other
 * plans (see use-employee-holidays.ts). Its week off answers are still trusted —
 * those come from the work calendar and are correct.
 *
 * HRAttendance.tsx has a matching copy — keep the two in step.
 */
function resolveStatus(
  apiStatus: AttendanceStatus,
  workingDay: WorkingDayResponse | undefined,
  holidayName?: string,
): AttendanceStatus {
  if (apiStatus !== "no-time") return apiStatus;
  if (holidayName) return "holiday";
  if (!workingDay) return apiStatus;
  if (workingDay.is_weekend) return "weekend";
  // A non-working day whose only reason is a holiday is one of the mis-matched
  // holidays described above: the employee's own plan has already had its say,
  // so this is an ordinary working day. Without this guard the day would fall
  // through to the week off rule below and read "Week Off" instead of "Absent".
  if (workingDay.reason === "HOLIDAY") return "no-time";
  if (!workingDay.is_working_day && workingDay.calendar_id) return "weekend";
  return "no-time";
}

/**
 * Whether `/working-day` treats a date as non-working only because it matched a
 * holiday. Such a day is rostered as far as the employee is concerned unless
 * their own plan also lists it, so working-day tallies must count it.
 */
function isHolidayOnlyNonWorkingDay(workingDay: WorkingDayResponse | undefined) {
  return !!workingDay && !workingDay.is_working_day && workingDay.reason === "HOLIDAY";
}


function getCalendarDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  let startDay = firstDay.getDay() - 1;
  if (startDay < 0) startDay = 6;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const days: { day: number; inMonth: boolean; date: Date }[] = [];

  for (let i = startDay - 1; i >= 0; i--) {
    days.push({ day: daysInPrevMonth - i, inMonth: false, date: new Date(year, month - 1, daysInPrevMonth - i) });
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_HEADERS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const TH = "text-xs font-medium text-muted-foreground uppercase tracking-wide h-10";

export default function ManagerAttendance() {
  const now = new Date();
  const [selectedDate, setSelectedDate] = useState(format(now, "yyyy-MM-dd"));
  const [search, setSearch] = useState("");
  const [sheetEmployee, setSheetEmployee] = useState<{ terminalUserId: string; employeeUserId: string; name: string } | null>(null);
  // Export date range (From/To). Defaults to the currently viewed day.
  const [fromDate, setFromDate] = useState(format(now, "yyyy-MM-dd"));
  const [toDate, setToDate] = useState(format(now, "yyyy-MM-dd"));
  const [isExporting, setIsExporting] = useState(false);

  // Attendance only ever exists up to today — a future date could only ever
  // render an empty roster, so it is not offered in any picker on this page.
  const today = format(now, "yyyy-MM-dd");

  // The team roster is resolved server-side: the backend scopes to the caller's
  // direct (L1) reports and gates on the `manager_attendance` permission, so the
  // FE never reconstructs or filters the roster client-side. (The IAM employee
  // list below is a lookup for department only — it does not drive the rows.)
  const { data: apiAttendance = [], isLoading } = useGetTeamDailyAttendanceQuery({ punch_date: selectedDate });

  // Department is resolved server-side and arrives on the roster row itself.
  // It is NOT `group_name` — that's the biometric terminal's group (SFO, SIL,
  // Trainees…), not the HR department. This used to join against IAM's employee
  // list, but that endpoint requires `core_hr:create_resource`, which a manager
  // does not hold: it 403'd and every department rendered blank.

  // The API already returns one row per reportee (present, on leave, or absent),
  // so this is a straight map — no left-join or roster reconstruction needed.
  const teamData = useMemo((): EmployeeDayRecord[] => {
    return apiAttendance.map((a) => ({
      employeeUserId: a.employee_user_id ?? a.terminal_user_id ?? "",
      terminalUserId: a.terminal_user_id ?? "",
      employeeName: a.user_name || a.employee_user_id || "",
      department: a.department_name ?? "",
      firstIn: a.first_in ?? "",
      lastOut: a.last_out ?? "",
      grossHours: a.total_hours ?? "",
      netHours: a.work_hours ?? "",
      punches: (a.punches ?? []).map((p) => ({ time: p.time, type: p.type as "in" | "out" })),
      status: (a.status as AttendanceStatus) || "no-time",
      leaveTypeName: a.leave_type_name,
    }));
  }, [apiAttendance]);

  // Only the rows the API called absent need a calendar lookup — a punched-in,
  // on-leave or already-resolved row is taken at face value.
  const workingDayRefs = useMemo<WorkingDayRef[]>(
    () =>
      teamData
        .filter((r) => r.status === "no-time" && r.employeeUserId)
        .map((r) => ({ userId: r.employeeUserId, date: selectedDate })),
    [teamData, selectedDate],
  );
  const workCal = useWorkingDays(workingDayRefs);

  // Holidays are per-reportee, resolved through the holiday plan each one is
  // assigned to — a team split across plans (different BUs or countries) gets
  // the right set per row instead of one flat team-wide list.
  const holidayUserIds = useMemo(
    () => teamData.map((r) => r.employeeUserId).filter(Boolean),
    [teamData],
  );
  const empHolidays = useEmployeeHolidays(holidayUserIds, selectedDate, selectedDate);
  const isLoadingHolidays = empHolidays.isLoading;

  const resolvedTeam = useMemo(
    () =>
      teamData.map((r) => {
        const workingDay = workCal.get(r.employeeUserId, selectedDate);
        const holidayName = empHolidays.get(r.employeeUserId, selectedDate);
        const status = resolveStatus(r.status, workingDay, holidayName);
        return {
          ...r,
          status,
          holidayName: status === "holiday" ? holidayName : undefined,
          // This row's own calendar lookup is still in flight — showing
          // "Absent" now would only be corrected a moment later. Deliberately
          // per-row, so one slow reportee doesn't hold up the whole column.
          statusPending:
            r.status === "no-time" &&
            !workingDay &&
            (workCal.isPending(r.employeeUserId, selectedDate) || isLoadingHolidays),
        };
      }),
    [teamData, workCal, selectedDate, empHolidays, isLoadingHolidays],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return resolvedTeam;
    const q = search.toLowerCase();
    return resolvedTeam.filter(
      (r) => r.employeeName.toLowerCase().includes(q) || r.department.toLowerCase().includes(q),
    );
  }, [resolvedTeam, search]);

  const selectedDateObj = new Date(selectedDate);
  const selectedDateLabel = `${selectedDateObj.toLocaleDateString("en-GB", { weekday: "short" })}, ${selectedDateObj
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-")}`;

  // Counted off the resolved statuses, so a week off or a holiday no longer
  // inflates the Absent tile.
  const teamStats = useMemo(() => {
    let present = 0, absent = 0, late = 0, partial = 0;
    resolvedTeam.forEach((r) => {
      if (r.statusPending) return;
      if (r.status === "full") present++;
      else if (r.status === "no-time") absent++;
      else if (r.status === "late") late++;
      else if (r.status === "partial") partial++;
    });
    return { total: resolvedTeam.length, present, absent, late, partial };
  }, [resolvedTeam]);

  const statCards = [
    { label: "Team Size", value: teamStats.total, icon: Users },
    { label: "Present", value: teamStats.present, icon: LogIn },
    { label: "Absent", value: teamStats.absent, icon: AlertCircle },
    { label: "Late / Partial", value: `${teamStats.late} / ${teamStats.partial}`, icon: Clock },
  ];

  // Downloads the team's attendance for the From→To range as a CSV (opens in
  // Excel). No range endpoint exists, so we pull the single-day team API for
  // each date and stack the rows — mirroring the table's columns plus a Date
  // column, and honouring the active search filter.
  const handleExport = async () => {
    const start = parseISO(fromDate);
    const end = parseISO(toDate);
    if (end < start) {
      toast.error("'To' date must be on or after 'From' date");
      return;
    }
    setIsExporting(true);
    try {
      const days = eachDayOfInterval({ start, end });
      const q = search.trim().toLowerCase();
      const rows: (string | number)[][] = [];

      // Resolved once for the whole range, so the CSV can label holidays instead
      // of reporting them as absences — and labels them per employee, from the
      // plan each is assigned to. Week offs can't be resolved here; that would
      // need a /working-day call per employee per day.
      let holidays: EmployeeHolidayResolver = { get: () => undefined };
      try {
        holidays = await fetchEmployeeHolidayResolver(fromDate, toDate);
      } catch {
        // Holidays are best-effort; the export still goes out without them.
      }

      for (const day of days) {
        const punch_date = format(day, "yyyy-MM-dd");
        let dayData: EmployeeDayAttendance[] = [];
        try {
          dayData = await store
            .dispatch(attendanceApi.endpoints.getTeamDailyAttendance.initiate({ punch_date }))
            .unwrap();
        } catch {
          dayData = [];
        }
        for (const a of dayData ?? []) {
          const name = a.user_name ?? "";
          const dept = a.department_name ?? "";
          const id = a.terminal_user_id ?? "";
          if (q && !(name.toLowerCase().includes(q) || dept.toLowerCase().includes(q))) continue;
          const userId = a.employee_user_id ?? a.terminal_user_id ?? "";
          const status = resolveStatus(
            (a.status as AttendanceStatus) || "no-time",
            undefined,
            holidays.get(userId, punch_date),
          );
          const mappedPunches = (a.punches ?? []).map((p) => ({ time: p.time, type: p.type as "in" | "out" }));
          rows.push([
            punch_date,
            id,
            name,
            dept,
            a.first_in ?? "",
            a.last_out ?? "",
            a.total_hours ?? "",
            a.work_hours ?? "",
            mappedPunches.length ? (hasOddPunch(mappedPunches) ? "Yes" : "No") : "-",
            STATUS_COLORS[status]?.label ?? status,
          ]);
        }
      }

      if (rows.length === 0) {
        toast.info("No attendance data to export for the selected range");
        return;
      }

      const header = ["Date", "Employee ID", "Employee", "Department", "First In", "Last Out", "Total Hours", "Work Hours", "Odd Punch", "Status"];
      const csvEscape = (v: string | number) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
      // BOM so Excel reads UTF-8 correctly.
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objUrl;
      link.download = fromDate === toDate ? `team-attendance_${fromDate}.csv` : `team-attendance_${fromDate}_to_${toDate}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objUrl);
      toast.success(`Exported ${rows.length} record${rows.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Failed to export attendance");
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader
          title="Team Attendance"
          subtitle="View your team's daily attendance and drill into individual records"
        />
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          Loading team members...
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Team Attendance"
        subtitle="View your team's daily attendance and drill into individual records"
      />

      {/* Date + team summary stat cards — single row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
          <div>
            <p className="text-xs text-muted-foreground font-medium">Date</p>
            <p className="text-lg font-bold text-foreground mt-0.5">{selectedDateLabel}</p>
          </div>
          <CalendarDays className="size-7 shrink-0 text-muted-foreground" />
        </div>
        {statCards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">{label}</p>
              <p className="text-2xl font-bold text-foreground">{value}</p>
            </div>
            <Icon className="size-8 shrink-0 text-muted-foreground" />
          </div>
        ))}
      </div>

      {/* Team table */}
      <div className="rounded-xl border overflow-hidden bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or department..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <DatePicker
            value={selectedDate}
            onChange={(v) => { if (v) setSelectedDate(v); }}
            max={today}
            placeholder="Select date"
            className="w-[180px]"
          />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Export range</span>
            <DatePicker
              value={fromDate}
              onChange={(v) => {
                if (!v) return;
                setFromDate(v);
                // Keep the range valid: pull "To" forward if it's now before "From".
                if (toDate < v) setToDate(v);
              }}
              max={today}
              placeholder="From date"
              className="w-[150px]"
            />
            <span className="text-muted-foreground">–</span>
            <DatePicker
              value={toDate}
              onChange={(v) => { if (v) setToDate(v); }}
              min={fromDate}
              max={today}
              placeholder="To date"
              className="w-[150px]"
            />
            <Button variant="outline" className="gap-2 h-9" onClick={handleExport} disabled={isExporting}>
              <Download className="size-4" /> {isExporting ? "Exporting…" : "Export"}
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className={TH}>Employee</TableHead>
              <TableHead className={TH}>Department</TableHead>
              <TableHead className={TH}>
                <div className="flex items-center gap-1.5"><LogIn className="size-3.5" /> First In</div>
              </TableHead>
              <TableHead className={TH}>
                <div className="flex items-center gap-1.5"><LogOut className="size-3.5" /> Last Out</div>
              </TableHead>
              <TableHead className={TH}>Total Hours</TableHead>
              <TableHead className={TH}>Work Hours</TableHead>
              <TableHead className={TH}>Odd Punch</TableHead>
              <TableHead className={TH}>Status</TableHead>
              <TableHead className={cn(TH, "w-10")} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="p-0">
                  <EmptyState icon={Users} title="No employees found" description="Try adjusting your search or date." />
                </TableCell>
              </TableRow>
            )}
            {filtered.map((row) => (
              <TableRow
                key={row.employeeUserId}
                className={cn(row.terminalUserId ? "cursor-pointer" : "cursor-default")}
                onClick={() => {
                  if (row.terminalUserId) setSheetEmployee({ terminalUserId: row.terminalUserId, employeeUserId: row.employeeUserId, name: row.employeeName });
                }}
              >
                <TableCell className="text-sm font-medium text-foreground">{row.employeeName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.department}</TableCell>
                <TableCell className="text-sm text-foreground">{row.firstIn || "-"}</TableCell>
                <TableCell className="text-sm text-foreground">{row.lastOut || "-"}</TableCell>
                <TableCell className="text-sm text-foreground">{row.grossHours || "-"}</TableCell>
                <TableCell className="text-sm text-foreground font-medium">{row.netHours || "-"}</TableCell>
                <TableCell className="text-sm">
                  {hasOddPunch(row.punches) ? (
                    <span className="inline-flex items-center gap-1 text-[#b8860b]">
                      <AlertCircle className="size-3.5" /> Yes
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </TableCell>
                <TableCell>
                  {/* Absent renders as a plain dash rather than a red pill —
                      which also means a row still resolving its calendar looks
                      identical to the answer it usually lands on, so there's no
                      visible flicker. */}
                  {row.statusPending || row.status === "no-time" ? (
                    <span className="text-sm text-muted-foreground">-</span>
                  ) : row.status !== "weekend" ? (
                    <span
                      title={row.holidayName ?? undefined}
                      className={cn(
                        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                        STATUS_COLORS[row.status].bg,
                        STATUS_COLORS[row.status].text,
                      )}
                    >
                      {STATUS_COLORS[row.status].label}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Week Off</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={!row.terminalUserId}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (row.terminalUserId) setSheetEmployee({ terminalUserId: row.terminalUserId, employeeUserId: row.employeeUserId, name: row.employeeName });
                    }}
                  >
                    <CalendarDays className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Employee calendar sheet */}
      <Sheet open={!!sheetEmployee} onOpenChange={(open) => { if (!open) setSheetEmployee(null); }}>
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>{sheetEmployee?.name}</SheetTitle>
            <SheetDescription>Monthly attendance calendar</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {sheetEmployee && (
              <EmployeeCalendarSheet
                terminalUserId={sheetEmployee.terminalUserId}
                employeeUserId={sheetEmployee.employeeUserId}
                initialDate={selectedDate}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EmployeeCalendarSheet({
  terminalUserId,
  employeeUserId,
  initialDate,
}: {
  terminalUserId: string;
  employeeUserId: string;
  /** The day selected in the page filter ("yyyy-MM-dd") — the calendar opens on
   *  that month, not on today's, so the sheet answers the question the manager
   *  was already asking. */
  initialDate: string;
}) {
  const [initialYear, initialMonth] = useMemo(() => {
    const [y, m] = initialDate.split("-").map(Number);
    return Number.isNaN(y) || Number.isNaN(m)
      ? [new Date().getFullYear(), new Date().getMonth()]
      : [y, m - 1];
  }, [initialDate]);

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  const { data: apiMonthData, isLoading: isLoadingMonth } = useGetEmployeeMonthAttendanceQuery({
    terminal_user_id: terminalUserId,
    year,
    month: month + 1,
  });

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // The whole month is resolved (not just past days) so future week offs and
  // holidays render correctly and the Working Days tile is accurate.
  const workingDayRefs = useMemo<WorkingDayRef[]>(() => {
    if (!employeeUserId) return [];
    return Array.from({ length: daysInMonth }, (_, i) => ({
      userId: employeeUserId,
      date: isoDate(year, month, i + 1),
    }));
  }, [employeeUserId, year, month, daysInMonth]);
  const workCal = useWorkingDays(workingDayRefs);

  // Team calendar is used for this employee's leave events only — its holiday
  // list is team-wide and would show holidays from other reportees' plans.
  const { data: monthCalendar } = useGetTeamCalendarQuery({
    from_date: isoDate(year, month, 1),
    to_date: isoDate(year, month, daysInMonth),
  });

  // Only the holidays of the plan THIS employee is assigned to.
  const holidayUserIds = useMemo(
    () => (employeeUserId ? [employeeUserId] : []),
    [employeeUserId],
  );
  const empHolidays = useEmployeeHolidays(
    holidayUserIds,
    isoDate(year, month, 1),
    isoDate(year, month, daysInMonth),
  );

  // `/attendance/employee/{id}/month` only returns days with punches — it does
  // not report leave, so a leave day arrives as a gap and would render Absent
  // even though the daily team table (which does resolve leave) shows "Leave".
  // The team calendar carries the same employee's approved leave events, so
  // expand those over the month.
  const leaveByDate = useMemo(() => {
    const map = new Map<string, string>();
    const member = monthCalendar?.team_members?.find(
      (m) => m.user_id === employeeUserId,
    );
    const first = isoDate(year, month, 1);
    const last = isoDate(year, month, daysInMonth);

    for (const ev of member?.events ?? []) {
      if (ev.status !== "APPROVED") continue;
      const start = ev.start_date?.slice(0, 10);
      const end = (ev.end_date || ev.start_date)?.slice(0, 10);
      if (!start || !end) continue;

      // Clip the request to the visible month, then walk it day by day.
      const from = start > first ? start : first;
      const to = end < last ? end : last;
      if (from > to) continue;
      for (let d = Number(from.slice(8, 10)); d <= Number(to.slice(8, 10)); d++) {
        map.set(isoDate(year, month, d), ev.leave_type_name);
      }
    }
    return map;
  }, [monthCalendar, employeeUserId, year, month, daysInMonth]);

  const records = useMemo(() => {
    const map = new Map<number, EmployeeMonthRecord>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const apiByDay = new Map<number, EmployeeMonthRecord>();
    for (const a of apiMonthData ?? []) {
      const d = new Date(a.punch_date).getDate();
      apiByDay.set(d, {
        date: d,
        firstIn: a.first_in ?? "",
        lastOut: a.last_out ?? "",
        grossHours: a.total_hours ?? "0:00",
        netHours: a.work_hours ?? "0:00",
        punches: a.punches.map((p) => ({ time: p.time, type: p.type as "in" | "out" })),
        status: (a.status as AttendanceStatus) || "no-time",
        leaveTypeName: a.leave_type_name,
      });
    }

    const blank = { firstIn: "", lastOut: "", grossHours: "0:00", netHours: "0:00", punches: [] };

    for (let d = 1; d <= daysInMonth; d++) {
      const api = apiByDay.get(d);
      // A real record — punches, leave, anything the API already classified —
      // wins outright, including a punch made on a holiday.
      if (api && (api.status !== "no-time" || api.punches.length > 0)) {
        map.set(d, api);
        continue;
      }

      const iso = isoDate(year, month, d);
      const workingDay = workCal.get(employeeUserId, iso);
      const holidayName = empHolidays.get(employeeUserId, iso);
      const offStatus = resolveStatus("no-time", workingDay, holidayName);
      if (offStatus !== "no-time") {
        map.set(d, {
          date: d,
          ...blank,
          status: offStatus,
          holidayName: offStatus === "holiday" ? holidayName : undefined,
        });
      } else if (leaveByDate.has(iso)) {
        // Ranks below holiday/week off so leave spanning a weekend still shows
        // the weekend days as Week Off, matching how the day is actually spent.
        map.set(d, {
          date: d,
          ...blank,
          status: "leave",
          leaveTypeName: leaveByDate.get(iso),
        });
      } else if (api) {
        map.set(d, api);
      } else if (new Date(year, month, d) < today) {
        map.set(d, { date: d, ...blank, status: "no-time" });
      }
      // Future working day with no record — left empty.
    }
    return map;
  }, [apiMonthData, year, month, daysInMonth, workCal, employeeUserId, empHolidays, leaveByDate]);
  const calendarDays = useMemo(() => getCalendarDays(year, month), [year, month]);

  const attendedDays = useMemo(() => {
    let count = 0;
    records.forEach((r) => {
      if (r.status === "full" || r.status === "late" || r.status === "partial") count++;
    });
    return count;
  }, [records]);

  // Taken from the employee's own calendar; falls back to Mon–Fri while the
  // lookups are still resolving, if they failed, or if this employee has no
  // work calendar assigned (in which case every day reports as non-working).
  const workingDays = useMemo(() => {
    let resolved = 0;
    let count = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoDate(year, month, d);
      const workingDay = workCal.get(employeeUserId, iso);
      if (!hasCalendar(workingDay)) continue;
      resolved++;
      // A holiday sits on a rostered day but isn't one the employee owes — only
      // when it is on THEIR plan. A day /working-day marked non-working purely
      // because of a holiday from some other plan is still a day they owe, so it
      // counts (otherwise the tile silently under-reports and skews the %).
      const isRostered =
        workingDay!.is_working_day || isHolidayOnlyNonWorkingDay(workingDay);
      if (isRostered && !empHolidays.get(employeeUserId, iso)) count++;
    }
    if (resolved === daysInMonth) return count;

    let fallback = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month, d).getDay();
      if (dow !== 0 && dow !== 6) fallback++;
    }
    return fallback;
  }, [year, month, daysInMonth, workCal, employeeUserId, empHolidays]);

  const attendancePercent = workingDays > 0 ? Math.round((attendedDays / workingDays) * 100) : 0;

  const prevMonth = () => {
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
  };

  if (isLoadingMonth) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">Loading monthly data...</div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground font-medium">Working Days</p>
          <p className="text-lg font-bold text-foreground">{workingDays}</p>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground font-medium">Present</p>
          <p className="text-lg font-bold text-foreground">{attendedDays}</p>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground font-medium">Attendance</p>
          <p className={cn(
            "text-lg font-bold",
            attendancePercent >= 80 ? "text-[#1a7a3a]" : attendancePercent >= 50 ? "text-[#b8860b]" : "text-destructive",
          )}>
            {attendancePercent}%
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden ">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <CalendarDays className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              {MONTH_NAMES[month]} {year}
            </h3>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="size-7" onClick={prevMonth}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={nextMonth}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-7 border-b">
          {DAY_HEADERS.map((d) => (
            <div key={d} className={cn(
              "text-sm font-medium text-center py-3 uppercase tracking-wide",
              (d === "SAT" || d === "SUN") ? "text-primary/60" : "text-muted-foreground",
            )}>
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {calendarDays.map((day, i) => {
            const record = day.inMonth ? records.get(day.day) : undefined;
            const isOff = record?.status === "weekend" || record?.status === "holiday";

            let textColor = "";

            if (!day.inMonth) {
              textColor = "text-muted-foreground/40";
            } else if (record) {
              textColor = STATUS_COLORS[record.status].text;
            }

            return (
              <div
                key={i}
                className={cn(
                  "min-h-[110px] p-2 border-b border-r last:border-r-0 relative flex flex-col bg-card",
                  day.inMonth && record?.status === "weekend" && "bg-[#e8eeff]/30",
                )}
              >
                {day.inMonth && record && record.firstIn ? (
                  <>
                    <div className="flex items-start gap-2">
                      <span className="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold bg-primary/10 text-foreground shrink-0">{day.day}</span>
                      <div className="flex flex-col gap-1 flex-1 items-end">
                        <div className="rounded bg-muted/50 px-1 py-0.5 text-right">
                          <p className="text-[7px] text-muted-foreground leading-none">FIRST IN</p>
                          <p className={cn("text-[10px] font-medium leading-tight", textColor)}>{record.firstIn}</p>
                        </div>
                        <div className="rounded bg-muted/50 px-1 py-0.5 text-right">
                          <p className="text-[7px] text-muted-foreground leading-none">LAST OUT</p>
                          <p className={cn("text-[10px] font-medium leading-tight", textColor)}>{record.lastOut}</p>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1 mt-auto">
                      <div className="rounded bg-muted/50 px-1.5 py-1 text-center">
                        <p className="text-[7px] text-muted-foreground leading-none">TOTAL</p>
                        <p className={cn("text-[10px] font-medium leading-tight", textColor)}>{record.grossHours}</p>
                      </div>
                      <div className="rounded bg-muted/50 px-1.5 py-1 text-center">
                        <p className="text-[7px] text-muted-foreground leading-none">WORK</p>
                        <p className={cn("text-[10px] font-medium leading-tight", textColor)}>{record.netHours}</p>
                      </div>
                    </div>
                  </>
                ) : day.inMonth && record && record.status === "leave" ? (
                  <div className="flex flex-col items-center gap-1 px-1">
                    <span className="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold bg-primary/10 text-foreground">{day.day}</span>
                    <span className={cn("text-[10px] font-medium mt-1 text-center leading-tight", STATUS_COLORS.leave.text)}>{record.leaveTypeName || "Leave"}</span>
                  </div>
                ) : day.inMonth && record && record.status === "no-time" ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold bg-primary/10 text-foreground">{day.day}</span>
                    <span className="text-[10px] font-medium mt-1 text-muted-foreground">-</span>
                  </div>
                ) : day.inMonth && isOff ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className={cn(
                      "size-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-foreground",
                      record?.status === "holiday" ? "bg-[#fff3cd]" : "bg-primary/10",
                    )}>
                      {day.day}
                    </span>
                    <span
                      title={record?.holidayName ?? undefined}
                      className={cn("text-[10px] font-medium mt-1 text-center leading-tight", textColor)}
                    >
                      {record?.status === "holiday" ? "Holiday" : "Week Off"}
                    </span>
                  </div>
                ) : (
                  <span className={cn(
                    "size-6 rounded-full flex items-center justify-center text-[10px] font-semibold",
                    !day.inMonth ? "text-muted-foreground/40" : "text-foreground",
                    day.inMonth && "bg-primary/10",
                  )}>
                    {day.day}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t">
          {/* "no-time" is omitted — absent days render as a plain dash, so its
              swatch would explain a colour that no longer appears anywhere. */}
          {Object.entries(STATUS_COLORS)
            .filter(([key]) => key !== "no-time")
            .map(([key, val]) => (
              <div key={key} className="flex items-center gap-1">
                <span className={cn("size-2.5 rounded-sm", val.bg, key === "weekend" && "border border-[#c5d0f0]")} />
                <span className="text-[10px] text-muted-foreground">{val.label}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
