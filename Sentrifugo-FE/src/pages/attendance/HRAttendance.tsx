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
  Timer,
  AlertCircle,
  Users,
  Search,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { TablePagination } from "@/components/shared/TablePagination";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/EmptyState";
import { useGetEmployeesQuery } from "@/store/api/iamApi";
import {
  attendanceApi,
  useGetDailyAttendanceQuery,
  useGetEmployeeMonthAttendanceQuery,
  type EmployeeDayAttendance,
} from "@/store/api/attendanceApi";
import { useWorkingDays, type WorkingDayRef } from "@/hooks/use-work-calendars";
import { useEmployeeHolidays } from "@/hooks/use-employee-holidays";
import type { WorkingDayResponse } from "@/types/leave";

type AttendanceStatus = "full" | "late" | "partial" | "no-time" | "weekend" | "holiday" | "leave";

interface PunchEntry {
  time: string;
  type: "in" | "out";
}

interface EmployeeDayRecord {
  employeeId: string;
  /** IAM user id — what `/working-day` keys on. Empty if the employee has none. */
  employeeUserId: string;
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
  late: { bg: "bg-[#fff3cd]", text: "text-[#b8860b]", label: "Late / Short" },
  partial: { bg: "bg-[#e8d5f5]", text: "text-[#7b2d8e]", label: "Partial" },
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
 * `/attendance/daily` marks any day without punches as "no-time" (Absent) — it
 * does not consult the employee's work calendar. A week off, a holiday or a
 * non-rostered day therefore arrives looking like an absence, so we re-derive
 * it from `/working-day` before showing it.
 *
 * `is_working_day: false` on its own is NOT treated as a week off: the endpoint
 * also returns false when the employee has no calendar assigned at all, which
 * would paint every single day of the month as a week off. We only override
 * when a calendar actually resolved (`calendar_id` present). Otherwise the row
 * degrades to the API's own answer rather than inventing one.
 *
 * Holidays come from `useEmployeeHolidays` — the plan the employee is actually
 * assigned to — and take precedence, since a holiday is more informative than
 * "week off" when the two collide.
 *
 * `workingDay.is_holiday` is deliberately NOT consulted: `/working-day` matches
 * holidays by department/business unit across every plan in the org rather than
 * by the employee's plan assignment, so it reports holidays belonging to other
 * plans (see use-employee-holidays.ts). Its week off answers are still trusted —
 * those come from the work calendar and are correct.
 *
 * ManagerAttendance.tsx has a matching copy — keep the two in step.
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
const DEFAULT_PAGE_SIZE = 10;

export default function HRAttendance() {
  const now = new Date();
  const [selectedDate, setSelectedDate] = useState(format(now, "yyyy-MM-dd"));
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sheetEmployee, setSheetEmployee] = useState<{ id: string; userId: string; name: string } | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  // Export date range (From/To). Defaults to the currently viewed day.
  const [fromDate, setFromDate] = useState(format(now, "yyyy-MM-dd"));
  const [toDate, setToDate] = useState(format(now, "yyyy-MM-dd"));
  const [isExporting, setIsExporting] = useState(false);

  // Attendance only ever exists up to today — a future date could only ever
  // render an empty roster, so it is not offered in any picker on this page.
  const today = format(now, "yyyy-MM-dd");

  // Active roster — drives the list so every active employee is shown, even on
  // a day with no punches (they render as Absent). is_active resolves against
  // the EMPLOYMENT_STATUSES master data server-side.
  const { data: apiEmployees = [], isLoading: isLoadingEmployees } = useGetEmployeesQuery({ is_active: true, limit: 1000 });
  const { data: apiAttendance, isLoading: isLoadingAttendance } = useGetDailyAttendanceQuery({ punch_date: selectedDate });
  const isLoading = isLoadingEmployees || isLoadingAttendance;

  // Attendance rows carry the employee's user id as `employee_user_id`; index by
  // it so each roster member can be joined to their punches for the day.
  const attendanceByUserId = useMemo(() => {
    const map = new Map<string, EmployeeDayAttendance>();
    for (const a of apiAttendance ?? []) {
      if (a.employee_user_id) map.set(a.employee_user_id, a);
    }
    return map;
  }, [apiAttendance]);

  // Roster-driven: every active employee is listed. Those with a punch carry
  // their computed record; those without show as Absent (no-time).
  //
  // Department always comes from the IAM record. The attendance payload's
  // `group_name` is the biometric terminal's group (SFO, SIL, Trainees…), not
  // the HR department, so it is deliberately not used as a fallback.
  const allData = useMemo((): EmployeeDayRecord[] => {
    return apiEmployees.map((e) => {
      const userId = ((e.userId ?? e.user_id) as string | undefined) ?? "";
      const a = userId ? attendanceByUserId.get(userId) : undefined;
      const name = `${e.firstName ?? e.first_name ?? ""} ${e.lastName ?? e.last_name ?? ""}`.trim();
      const dept = e.departmentName ?? e.department_name ?? "";
      if (!a) {
        return {
          employeeId: e.id,
          employeeUserId: userId,
          employeeName: name,
          department: dept,
          firstIn: "",
          lastOut: "",
          grossHours: "",
          netHours: "",
          punches: [],
          status: "no-time",
        };
      }
      return {
        employeeId: a.terminal_user_id,
        employeeUserId: userId,
        employeeName: a.user_name || name,
        department: dept,
        firstIn: a.first_in ?? "",
        lastOut: a.last_out ?? "",
        grossHours: a.total_hours ?? "",
        netHours: a.work_hours ?? "",
        punches: a.punches.map((p) => ({ time: p.time, type: p.type as "in" | "out" })),
        status: (a.status as AttendanceStatus) || "no-time",
        leaveTypeName: a.leave_type_name,
      };
    });
  }, [apiEmployees, attendanceByUserId]);

  const departments = useMemo(() =>
    [...new Set(allData.map((e) => e.department).filter(Boolean))].sort(),
  [allData]);

  const filtered = useMemo(() => {
    let result = allData;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) => r.employeeName.toLowerCase().includes(q) || r.department.toLowerCase().includes(q) || r.employeeId.toLowerCase().includes(q),
      );
    }
    if (department !== "all") {
      result = result.filter((r) => r.department === department);
    }
    if (statusFilter !== "all") {
      result = result.filter((r) => r.status === statusFilter);
    }
    return result;
  }, [allData, search, department, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  );
  const startIndex = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, filtered.length);

  // Calendar lookups are scoped to the VISIBLE PAGE, not the whole roster: this
  // page lists up to 1000 employees and /working-day has no bulk variant, so
  // resolving everyone would mean a thousand requests per date change. Ten per
  // page is affordable, and rows are only ever rendered a page at a time.
  const workingDayRefs = useMemo<WorkingDayRef[]>(
    () =>
      paged
        .filter((r) => r.status === "no-time" && r.employeeUserId)
        .map((r) => ({ userId: r.employeeUserId, date: selectedDate })),
    [paged, selectedDate],
  );
  const workCal = useWorkingDays(workingDayRefs);

  // Holidays are per-employee, not org-wide: each row is resolved against the
  // holiday plan that employee is assigned to. Orgs running several plans in one
  // year (split by BU, department or country) get the right one per row, and a
  // holiday on one plan no longer greys out employees on the others.
  const holidayUserIds = useMemo(
    () => allData.map((r) => r.employeeUserId).filter(Boolean),
    [allData],
  );
  const empHolidays = useEmployeeHolidays(holidayUserIds, selectedDate, selectedDate);
  const isLoadingHolidays = empHolidays.isLoading;

  const rows = useMemo(
    () =>
      paged.map((r) => {
        const workingDay = workCal.get(r.employeeUserId, selectedDate);
        const holidayName = empHolidays.get(r.employeeUserId, selectedDate);
        const status = resolveStatus(r.status, workingDay, holidayName);
        return {
          ...r,
          status,
          holidayName: status === "holiday" ? holidayName : undefined,
          // Per-row so one slow lookup doesn't hold up the whole column.
          statusPending:
            r.status === "no-time" &&
            !workingDay &&
            (workCal.isPending(r.employeeUserId, selectedDate) || isLoadingHolidays),
        };
      }),
    [paged, workCal, selectedDate, empHolidays, isLoadingHolidays],
  );

  const selectedRow = selectedEmployeeId
    ? allData.find((r) => r.employeeId === selectedEmployeeId)
    : null;

  const selectedDateObj = new Date(selectedDate);
  const selectedDateLabel = `${selectedDateObj.toLocaleDateString("en-GB", { weekday: "short" })}, ${selectedDateObj
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-")}`;

  const punches = selectedRow?.punches ?? [];
  const isOddPunch = hasOddPunch(punches);
  const oddPunchLabel = punches.length === 0 ? "-" : isOddPunch ? "Yes" : "No";

  // A holiday only excuses the employees whose own plan lists it, so absences
  // are decided per employee rather than zeroed out org-wide. Week offs still
  // can't be reflected here — they are per-employee and only the visible page is
  // resolved against /working-day.
  const orgStats = useMemo(() => {
    let present = 0, absent = 0, late = 0, partial = 0;
    allData.forEach((r) => {
      if (r.status === "full") present++;
      else if (r.status === "no-time") {
        if (!empHolidays.get(r.employeeUserId, selectedDate)) absent++;
      }
      else if (r.status === "late") late++;
      else if (r.status === "partial") partial++;
    });
    return { total: allData.length, present, absent, late, partial };
  }, [allData, empHolidays, selectedDate]);

  const statCards = [
    { label: "Total Employees", value: orgStats.total, icon: Users },
    { label: "Present", value: orgStats.present, icon: LogIn },
    { label: "Absent", value: orgStats.absent, icon: AlertCircle },
    { label: "Late / Partial", value: `${orgStats.late} / ${orgStats.partial}`, icon: Clock },
  ];

  const employeeDetailCards = [
    { label: "First In", value: selectedRow?.firstIn || "-", icon: LogIn },
    { label: "Last Out", value: selectedRow?.lastOut || "-", icon: LogOut },
    { label: "Total Hours", value: selectedRow?.grossHours || "-", icon: Clock },
    { label: "Work Hours", value: selectedRow?.netHours || "-", icon: Timer },
    { label: "Odd Punch", value: oddPunchLabel, icon: AlertCircle },
  ];

  // Downloads attendance for the From→To range as a CSV (opens in Excel).
  // No range endpoint exists, so we pull the single-day API for each date and
  // stack the rows — mirroring the table's columns plus a Date column, and
  // honouring the active search / department / status filters.
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

      for (const day of days) {
        const punch_date = format(day, "yyyy-MM-dd");
        let dayData: EmployeeDayAttendance[] = [];
        try {
          dayData = await store
            .dispatch(attendanceApi.endpoints.getDailyAttendance.initiate({ punch_date }))
            .unwrap();
        } catch {
          dayData = [];
        }
        for (const a of dayData ?? []) {
          const name = a.user_name ?? "";
          const dept = a.group_name ?? "";
          const id = a.terminal_user_id ?? "";
          const status = (a.status as AttendanceStatus) || "no-time";
          if (q && !(name.toLowerCase().includes(q) || dept.toLowerCase().includes(q) || id.toLowerCase().includes(q))) continue;
          if (department !== "all" && dept !== department) continue;
          if (statusFilter !== "all" && status !== statusFilter) continue;
          const mappedPunches = a.punches.map((p) => ({ time: p.time, type: p.type as "in" | "out" }));
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
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = fromDate === toDate ? `hr-attendance_${fromDate}.csv` : `hr-attendance_${fromDate}_to_${toDate}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
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
          title="HR Attendance"
          subtitle="View and manage attendance records for all employees across the organisation"
        />
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          Loading employees...
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="HR Attendance"
        subtitle="View and manage attendance records for all employees across the organisation"
      />

      {/* Date + org-wide summary stat cards — single row */}
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

      {/* Employee table */}
      <div className="rounded-xl border overflow-hidden bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, ID, or department..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9 h-9"
            />
          </div>
          <DatePicker
            value={selectedDate}
            onChange={(v) => { if (v) { setSelectedDate(v); setPage(1); } }}
            max={today}
            placeholder="Select date"
            className="w-[180px]"
          />
          <Select value={department} onValueChange={(v) => { setDepartment(v); setPage(1); }}>
            <SelectTrigger className="w-[180px] h-9 text-sm">
              <SelectValue placeholder="All Departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[160px] h-9 text-sm">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="full">Full Day</SelectItem>
              <SelectItem value="late">Late / Short</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="no-time">Absent</SelectItem>
            </SelectContent>
          </Select>
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
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="p-0">
                  <EmptyState icon={Users} title="No employees found" description="Try adjusting your search or filters." />
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow
                key={row.employeeId}
                className={cn(
                  "cursor-pointer",
                  selectedEmployeeId === row.employeeId && "bg-primary/5",
                )}
                onClick={() => setSheetEmployee({ id: row.employeeId, userId: row.employeeUserId, name: row.employeeName })}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      setSheetEmployee({ id: row.employeeId, userId: row.employeeUserId, name: row.employeeName });
                    }}
                  >
                    <CalendarDays className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* Pagination */}
        <TablePagination
          currentPage={safePage}
          totalPages={totalPages}
          startIndex={startIndex}
          endIndex={endIndex}
          total={filtered.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
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
                employeeId={sheetEmployee.id}
                employeeUserId={sheetEmployee.userId}
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
  employeeId,
  employeeUserId,
  initialDate,
}: {
  employeeId: string;
  employeeUserId: string;
  /** The day selected in the page filter ("yyyy-MM-dd") — the calendar opens on
   *  that month, not on today's, so the sheet answers the question the user was
   *  already asking. */
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
    terminal_user_id: employeeId,
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

  // Only the holidays of the plan THIS employee is assigned to — not the org's
  // first active plan, which would show another country's or BU's holidays.
  const holidayUserIds = useMemo(
    () => (employeeUserId ? [employeeUserId] : []),
    [employeeUserId],
  );
  const empHolidays = useEmployeeHolidays(
    holidayUserIds,
    isoDate(year, month, 1),
    isoDate(year, month, daysInMonth),
  );

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
      } else if (api) {
        map.set(d, api);
      } else if (new Date(year, month, d) < today) {
        map.set(d, { date: d, ...blank, status: "no-time" });
      }
      // Future working day with no record — left empty.
    }
    return map;
  }, [apiMonthData, year, month, daysInMonth, workCal, employeeUserId, empHolidays]);
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
