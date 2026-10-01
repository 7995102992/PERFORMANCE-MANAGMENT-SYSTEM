import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { toast, extractErrorMessage, hasErrorCode } from "@/lib/toast";
import { formatDateTimeIST } from "@/lib/format-ist";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Save,
  SendHorizontal,
  Loader2,
  Calendar,
  Clock,
  Trash2,
  ArrowLeft,
  AlertTriangle,
  CheckCircle,
  X,
  Lock,
} from "lucide-react";
import {
  useGetMyTimesheetsQuery,
  useGetMyTimesheetQuery,
  useCreateTimesheetMutation,
  useSaveTimesheetEntriesMutation,
  useSubmitTimesheetMutation,
  useResubmitTimesheetMutation,
  useGetMyAssignedProjectsQuery,
} from "@/store/api/timesheetApi";
import { useGetMyCalendarQuery } from "@/store/api/lmsApi";
import type {
  TimesheetEntryInput,
  TimesheetProjectApproval,
  TimesheetStatus,
} from "@/types/timesheet";
import { ProjectApprovalBadge } from "@/components/shared/ProjectApprovalBadge";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
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

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const formatDateISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Parse the ?week= deep-link value. A bare "2026-08-17" is parsed by the spec
 * as UTC midnight, which for anyone west of UTC lands on the previous local day
 * — and getMonday would then open the week before the one the link meant. Treat
 * date-only strings as local midnight; anything with a time component (the full
 * ISO form the notification service sends) already parses as local.
 */
const parseWeekParam = (raw: string): Date => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  return new Date(raw);
};

const NAV_MONTHS = [
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
// "Dec 21, 2025"
const formatNavDate = (d: Date) =>
  `${NAV_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
// Decimal hours → "HH:MM" for display-only rows
const toHHMM = (hours: number) => {
  const total = Math.max(0, Math.round(hours * 60));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const getWeeksInMonth = (year: number, month: number): Date[] => {
  const weeks: Date[] = [];
  const first = getMonday(new Date(year, month, 1));
  const lastDay = new Date(year, month + 1, 0);
  let cur = new Date(first);
  while (cur <= lastDay) {
    weeks.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
};

// Entries can only be saved in draft / l1_rejected / client_rejected; every
// other status is locked server-side and returns TSM-004.
const lockedStatusLabel = (status: TimesheetStatus): string => {
  switch (status) {
    case "submitted":
      return "Submitted — awaiting approval";
    case "resubmitted":
      return "Resubmitted — awaiting approval";
    case "l1_approved":
      return "Approved by your manager";
    case "client_approved":
      return "Approved by the client";
    default:
      return "Locked";
  }
};

interface EntryRow {
  id?: string;
  project_id: string;
  task_id: string;
  task_name?: string;
  hours: Record<string, number>;
  notes: string;
}

const HoursInput = ({
  value,
  onChange,
  disabled,
  className,
  id,
  onAdvance,
  onBack,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  onAdvance?: () => void;
  onBack?: () => void;
}) => {
  const [display, setDisplay] = useState(
    value !== undefined ? String(value) : "",
  );
  const isFocused = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!isFocused.current) {
      setDisplay(value !== undefined ? String(value) : "");
    }
  }, [value]);

  // Clear any pending auto-advance when this input unmounts
  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const cancelAdvance = () => clearTimeout(advanceTimer.current);

  return (
    <Input
      id={id}
      type="text"
      inputMode="decimal"
      className={className}
      value={display}
      onFocus={() => {
        isFocused.current = true;
      }}
      onBlur={() => {
        isFocused.current = false;
        cancelAdvance();
        if (display === "") {
          onChange(undefined);
          return;
        }
        const num = Number(display);
        if (!isNaN(num)) {
          setDisplay(String(num));
          onChange(num);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          cancelAdvance();
          onAdvance?.();
        } else if (e.key === "Backspace" && display === "") {
          // Empty field + backspace → jump to the previous day
          e.preventDefault();
          cancelAdvance();
          onBack?.();
        }
      }}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw !== "" && !/^\d*\.?\d{0,1}$/.test(raw)) return;
        const stripped = raw.replace(/^0+(\d)/, "$1");
        cancelAdvance();
        if (stripped !== "") {
          const num = Number(stripped);
          if (!isNaN(num) && num > 24) return;
          setDisplay(stripped);
          if (!isNaN(num)) onChange(num);
          // OTP-style advance: instant once a decimal is completed (e.g. 8.5),
          // otherwise a short debounce so multi-digit ints (10, 24) still work.
          if (onAdvance) {
            if (/^\d*\.\d$/.test(stripped)) onAdvance();
            else advanceTimer.current = setTimeout(() => onAdvance(), 500);
          }
        } else {
          setDisplay("");
          onChange(undefined);
        }
      }}
      disabled={disabled}
    />
  );
};

interface TimesheetEntryProps {
  embedded?: boolean;
  initialWeek?: string;
  onClose?: () => void;
}

const TimesheetEntry = ({
  embedded = false,
  initialWeek,
  onClose,
}: TimesheetEntryProps = {}) => {
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as Record<
    string,
    string | undefined
  >;
  const [weekStart, setWeekStart] = useState(() => {
    if (initialWeek) return getMonday(new Date(initialWeek));
    if (searchParams?.week) return getMonday(parseWeekParam(searchParams.week));
    return getMonday(new Date());
  });
  const [displayMonth, setDisplayMonth] = useState(() => {
    const init = (() => {
      if (initialWeek) return getMonday(new Date(initialWeek));
      if (searchParams?.week) return getMonday(parseWeekParam(searchParams.week));
      return getMonday(new Date());
    })();
    return { year: init.getFullYear(), month: init.getMonth() };
  });
  const [rows, setRows] = useState<EntryRow[]>([]);
  const [rowsInitialized, setRowsInitialized] = useState(false);
  const [editingRowIdx, setEditingRowIdx] = useState<number | null>(null);
  const [submitConfirm, setSubmitConfirm] = useState(false);
  // Turns on after a blocked submit so unfilled cells/selects show a danger state
  const [showMissing, setShowMissing] = useState(false);
  // TSM-034 — submit rejected because a task was unassigned after the entries
  // were saved. Holds the backend's message naming the task/date pairs.
  const [assignmentChanged, setAssignmentChanged] = useState<string | null>(
    null,
  );
  // Set the moment save/submit starts, so the buttons disable on click rather
  // than when the first request resolves — the submit path saves first, so the
  // mutation flags alone leave a window wide enough to double-submit.
  const [isBusy, setIsBusy] = useState(false);
  // TSM-004 — the timesheet is locked; the grid shouldn't have been editable
  const [lockedError, setLockedError] = useState<string | null>(null);
  // TSM-035 — the monthly cutoff closed this period for one or more projects
  const [periodClosedError, setPeriodClosedError] = useState<string | null>(
    null,
  );
  // TSM-036 — a settled day would have been changed. Holds the message plus the
  // dates it names, so those columns can be highlighted.
  const [settledDayError, setSettledDayError] = useState<{
    message: string;
    dates: Set<string>;
  } | null>(null);
  const tsm036Dates = settledDayError?.dates ?? new Set<string>();
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  const weekDates = useMemo(() => {
    return DAYS.map((_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const weekStartStr = formatDateISO(weekStart);

  // Keep the URL ?week= in sync with the week currently being viewed
  useEffect(() => {
    if (embedded) return;
    navigate({
      to: "/timesheet/my-timesheet/entry",
      search: { week: weekStartStr },
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartStr, embedded]);

  // Jump to the week containing a picked date (from the calendar icon)
  const selectWeekFromDate = (date?: Date) => {
    if (!date) return;
    const monday = getMonday(date);
    setWeekStart(monday);
    setDisplayMonth({ year: monday.getFullYear(), month: monday.getMonth() });
  };

  const monthWeeks = useMemo(() => {
    return getWeeksInMonth(displayMonth.year, displayMonth.month);
  }, [displayMonth]);

  const calMonthFrom = `${displayMonth.year}-${String(displayMonth.month + 1).padStart(2, "0")}-01`;
  const calMonthTo = (() => {
    const last = new Date(displayMonth.year, displayMonth.month + 1, 0);
    return formatDateISO(last);
  })();
  const { data: calendarData } = useGetMyCalendarQuery({
    from: calMonthFrom,
    to: calMonthTo,
  });

  const entryLeavesByDate = useMemo(() => {
    const map = new Map<string, NonNullable<typeof calendarData>["leaves"]>();
    if (!calendarData?.leaves) return map;
    for (const leave of calendarData.leaves) {
      const cur = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      while (cur <= end) {
        const key = formatDateISO(cur);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(leave);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }, [calendarData]);

  const entryHolidaysByDate = useMemo(() => {
    const map = new Map<string, NonNullable<typeof calendarData>["holidays"]>();
    if (!calendarData?.holidays) return map;
    for (const h of calendarData.holidays) {
      map.set(h.date, [h]);
    }
    return map;
  }, [calendarData]);

  const currentWeekIndex = useMemo(() => {
    return monthWeeks.findIndex((w) => formatDateISO(w) === weekStartStr);
  }, [monthWeeks, weekStartStr]);

  const { data: timesheetsData, isLoading: isLoadingTimesheets } =
    useGetMyTimesheetsQuery({ page: 1, page_size: 100 });
  const { data: assignedProjects, refetch: refetchAssignedProjects } =
    useGetMyAssignedProjectsQuery();
  // Active projects only are selectable for new/resubmitted entries. Deleted
  // (inactive) projects are still returned so past entries can resolve names.
  const activeProjects = useMemo(
    () =>
      (assignedProjects ?? []).filter(
        (p) => (p.status ?? "active") === "active",
      ),
    [assignedProjects],
  );
  /**
   * A manager can reassign work after entries were saved, leaving a row pointing
   * at a project or task the employee no longer has. Those options are gone from
   * the dropdowns, so without a marker the row just looks ordinary — and submit
   * fails later with TSM-034. Flag them in place instead.
   *
   * Only meaningful once the assigned list has loaded; while it's empty every
   * row would otherwise look unassigned.
   */
  const assignedTasksByProject = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const p of activeProjects) {
      map.set(p.id, new Set((p.tasks ?? []).map((t) => t.task_id)));
    }
    return map;
  }, [activeProjects]);

  const isProjectUnassigned = (row: EntryRow) =>
    activeProjects.length > 0 &&
    Boolean(row.project_id) &&
    !assignedTasksByProject.has(row.project_id);

  const isTaskUnassigned = (row: EntryRow) =>
    activeProjects.length > 0 &&
    Boolean(row.project_id) &&
    Boolean(row.task_id) &&
    // Only judge the task when the project itself is still assigned
    assignedTasksByProject.has(row.project_id) &&
    !assignedTasksByProject.get(row.project_id)!.has(row.task_id);

  const unassignedFieldClass =
    "border-warning bg-warning/5 focus-visible:border-warning focus-visible:ring-warning/30";

  const editingProjectId =
    editingRowIdx !== null ? rows[editingRowIdx]?.project_id : "";
  // Tasks for the editing project come inline from the assigned-projects payload.
  const addProjectTasks = useMemo(
    () =>
      (assignedProjects ?? []).find((p) => p.id === editingProjectId)?.tasks ??
      [],
    [assignedProjects, editingProjectId],
  );

  const [createTimesheet, { isLoading: isCreating }] =
    useCreateTimesheetMutation();
  // Busy state for all three comes from isBusy, which is set synchronously on
  // click — the submit path saves first, so the mutations' own isLoading flags
  // flip too late to stop a second click.
  const [saveEntries] = useSaveTimesheetEntriesMutation();
  // No per-entry DELETE call: the bulk save replaces the week, so a row removed
  // from the grid is removed server-side simply by not being in the payload.
  const [submitTimesheet] = useSubmitTimesheetMutation();
  const [resubmitTimesheet] = useResubmitTimesheetMutation();

  const currentTimesheet = useMemo(() => {
    if (!timesheetsData?.items) return null;
    return timesheetsData.items.find((ts) =>
      ts.week_start_date.startsWith(weekStartStr),
    );
  }, [timesheetsData, weekStartStr]);

  const {
    data: timesheetDetail,
    isFetching: isFetchingDetail,
    refetch: refetchDetail,
  } = useGetMyTimesheetQuery(currentTimesheet?.id ?? "", {
    skip: !currentTimesheet?.id,
  });

  // Work-calendar day types for this week (weekoff / half-day), from weekend_matrix
  const workCalendarByDate = useMemo(() => {
    const map = new Map<string, "weekoff" | "first_half" | "second_half">();
    const wc = timesheetDetail?.work_calendar;
    if (!wc) return map;
    wc.weekoffs?.forEach((d) => map.set(d, "weekoff"));
    wc.first_half_days?.forEach((d) => map.set(d, "first_half"));
    wc.second_half_days?.forEach((d) => map.set(d, "second_half"));
    return map;
  }, [timesheetDetail?.work_calendar]);

  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    (assignedProjects ?? []).forEach((p) => map.set(p.id, p.name));
    return map;
  }, [assignedProjects]);

  const [knownTasks, setKnownTasks] = useState<Map<string, string>>(new Map());

  // Seed task names from every assigned project (active + deleted) so past
  // entries always show task names instead of ids.
  useEffect(() => {
    if (!assignedProjects) return;
    setKnownTasks((prev) => {
      const next = new Map(prev);
      for (const p of assignedProjects) {
        for (const t of p.tasks ?? []) next.set(t.task_id, t.task_name);
      }
      return next;
    });
  }, [assignedProjects]);

  /**
   * Editability is three-state, not a boolean:
   *
   *   "full"       draft / rejected — the whole grid is open
   *   "zero-days"  submitted or resubmitted and untouched by an approver: days
   *                that logged no hours can still be filled in, days with hours
   *                are settled. No re-submit; saving keeps the status.
   *   "none"       an approver has acted, or the week is approved
   */
  const anyProjectActedOn = (currentTimesheet?.project_approvals ?? []).some(
    (pa) =>
      pa.status === "l1_approved" ||
      pa.status === "client_approved" ||
      pa.status === "l1_rejected" ||
      pa.status === "client_rejected",
  );

  const editMode: "full" | "zero-days" | "none" = (() => {
    if (!currentTimesheet) return "full";
    const status = currentTimesheet.timesheet_status;
    if (
      status === "draft" ||
      status === "l1_rejected" ||
      status === "client_rejected"
    )
      return "full";
    if (status === "submitted" || status === "resubmitted")
      return anyProjectActedOn ? "none" : "zero-days";
    return "none";
  })();

  // Anything that writes to the grid is allowed in either editable mode; the
  // per-day and per-row rules below narrow it down from there.
  const isEditable = editMode !== "none";

  // Per-project editability for rejected timesheets
  const rejectedProjectIds = useMemo(() => {
    if (!currentTimesheet?.project_approvals) return new Set<string>();
    return new Set(
      currentTimesheet.project_approvals
        .filter(
          (pa) =>
            pa.status === "l1_rejected" || pa.status === "client_rejected",
        )
        .map((pa) => pa.project_id),
    );
  }, [currentTimesheet?.project_approvals]);

  const projectApprovalMap = useMemo(() => {
    const map = new Map<string, TimesheetProjectApproval>();
    (currentTimesheet?.project_approvals ?? []).forEach((pa) =>
      map.set(pa.project_id, pa),
    );
    return map;
  }, [currentTimesheet?.project_approvals]);

  /**
   * Days already carrying hours *on the server*. Deliberately not derived from
   * the live grid: in zero-days mode the moment someone types into an open day
   * its total leaves 0, and a live count would disable the input mid-keystroke.
   */
  const settledDates = useMemo(() => {
    const totals = new Map<string, number>();
    const entries = timesheetDetail?.entries;
    if (entries?.length) {
      for (const e of entries) {
        const d = e.entry_date.split("T")[0];
        totals.set(d, (totals.get(d) ?? 0) + e.hours);
      }
    } else {
      for (const [d, list] of Object.entries(
        currentTimesheet?.daily_entries ?? {},
      )) {
        totals.set(
          d,
          list.reduce((s, x) => s + x.hours, 0),
        );
      }
    }
    return new Set(
      [...totals.entries()].filter(([, h]) => h > 0).map(([d]) => d),
    );
  }, [timesheetDetail?.entries, currentTimesheet?.daily_entries]);

  /** In zero-days mode a day with server hours can no longer be touched. */
  const isDaySettled = (dateStr: string) =>
    editMode === "zero-days" && settledDates.has(dateStr);

  /**
   * A row that contributes hours to a settled day can't be re-pointed, renamed
   * or removed — any of those rewrites that day's entries and trips TSM-036.
   */
  const rowHasSettledHours = (row: EntryRow) =>
    editMode === "zero-days" &&
    [...settledDates].some((d) => (row.hours[d] ?? 0) > 0);

  /**
   * Row-level edits — project, task, notes, delete — rewrite every entry the
   * row owns, including ones on settled days, so a row touching a settled day
   * is frozen as a whole.
   */
  const isRowEditable = (row: EntryRow): boolean => {
    if (!currentTimesheet) return false;
    const status = currentTimesheet.timesheet_status;
    if (status === "draft") return true;
    if (status === "l1_rejected" || status === "client_rejected") {
      if (!row.project_id) return true; // new unsaved row, no project chosen yet
      return rejectedProjectIds.has(row.project_id);
    }
    // Submitted and untouched: rows that only cover open days stay editable
    if (editMode === "zero-days") return !rowHasSettledHours(row);
    return false;
  };

  /**
   * A single day's hours, which is finer-grained than isRowEditable: hours are
   * stored per (row, date), so filling an open day on a row that also covers
   * settled days adds an entry without touching the settled ones. A row with
   * Mon–Fri submitted can still have its Sat/Sun filled in.
   */
  const isCellEditable = (row: EntryRow, dateStr: string): boolean => {
    if (editMode === "none") return false;
    if (editMode === "zero-days") return !settledDates.has(dateStr);
    return isRowEditable(row);
  };

  /**
   * One description of what a day IS, so the header chip, the cell tint and
   * the zero-fill below all read the same answer.
   *
   * Previously a week off got a chip, while a holiday or a leave got a
   * coloured dot — three ways of saying "you weren't expected to work", drawn
   * three ways. They're one idea and now render as one.
   *
   * Precedence is deliberate: the work calendar is the org's own statement
   * about the day, so a week off wins over a holiday that lands on it. Half
   * days stay separate — they're partly working, and must not be zero-filled.
   */
  type DayKind = "weekoff" | "holiday" | "leave" | "half" | "working";
  const dayMeta = useMemo(() => {
    const map = new Map<
      string,
      { kind: DayKind; label: string; title: string }
    >();
    for (const d of weekDates) {
      const key = formatDateISO(d);
      const wc = workCalendarByDate.get(key);
      const holidays = entryHolidaysByDate.get(key) ?? [];
      const leaves = entryLeavesByDate.get(key) ?? [];
      // Only a full-day leave means no work: a half-day leave still leaves
      // half a day to account for, so it must stay a normal editable cell.
      const fullDayLeave = leaves.find((l) => l.duration_mode === "FULL_DAYS");

      // The chip names the actual day where there is a name to give — the
      // holiday, or the leave type. "Holiday" and "On Leave" told you a
      // category you could already see from the styling; the name is the part
      // you can't get anywhere else without hovering.
      if (wc === "weekoff") {
        map.set(key, { kind: "weekoff", label: "Week Off", title: "Week off" });
      } else if (holidays.length > 0) {
        const names = holidays.map((h) => h.name).join(", ");
        map.set(key, { kind: "holiday", label: names, title: names });
      } else if (fullDayLeave) {
        const names = leaves.map((l) => l.leave_type_name).join(", ");
        map.set(key, { kind: "leave", label: names, title: names });
      } else if (wc === "first_half" || wc === "second_half") {
        map.set(key, {
          kind: "half",
          label: wc === "first_half" ? "Half Day (1st)" : "Half Day (2nd)",
          title:
            wc === "first_half"
              ? "First half working (second half off)"
              : "Second half working (first half off)",
        });
      } else if (leaves.length > 0) {
        // Half-day leave — flagged, but still a working day.
        map.set(key, {
          kind: "half",
          label: leaves.map((l) => l.leave_type_name).join(", "),
          title: `Half day — ${leaves.map((l) => l.leave_type_name).join(", ")}`,
        });
      } else {
        // Ordinary working day. It gets a chip too, so every column is the
        // same height — without one the five weekdays sat a line higher than
        // the weekend and their dates didn't line up.
        map.set(key, {
          kind: "working",
          label: "Weekday",
          title: "Working day",
        });
      }
    }
    return map;
  }, [
    weekDates,
    workCalendarByDate,
    entryHolidaysByDate,
    entryLeavesByDate,
  ]);

  /** Days nobody is expected to work — these get a 0 rather than a blank. */
  const zeroDates = useMemo(() => {
    const set = new Set<string>();
    for (const [key, meta] of dayMeta) {
      if (
        meta.kind === "weekoff" ||
        meta.kind === "holiday" ||
        meta.kind === "leave"
      )
        set.add(key);
    }
    return set;
  }, [dayMeta]);

  /**
   * Put a 0 in every non-working day rather than leaving it blank.
   *
   * A blank cell and a zero mean different things to the submit check — blank
   * is "you haven't said", zero is "nothing worked" — so a week off used to
   * block submission until someone typed 0 into it by hand, seven times a
   * fortnight. Nobody is being asked whether they worked on a public holiday.
   *
   * Only fills cells that are still `undefined`, so a genuine weekend shift
   * that someone logged is never overwritten, and the cells stay editable —
   * this is a default, not a lock.
   *
   * Runs on the rows/calendar it has: the work calendar and leave data arrive
   * after the rows do, so this fires again when they land.
   */
  useEffect(() => {
    if (!rowsInitialized || zeroDates.size === 0) return;
    setRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (!isRowEditable(row)) return row;
        let hours = row.hours;
        for (const d of zeroDates) {
          if (hours[d] !== undefined) continue;
          if (!isCellEditable(row, d)) continue;
          if (hours === row.hours) hours = { ...hours };
          hours[d] = 0;
          changed = true;
        }
        return hours === row.hours ? row : { ...row, hours };
      });
      // Returning `prev` unchanged is what stops this re-running forever.
      return changed ? next : prev;
    });
    // isRowEditable / isCellEditable close over state that changes with rows,
    // and re-running on their identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zeroDates, rowsInitialized, rows.length, editMode]);

  const todayWeekStart = getMonday(new Date());
  const todayStr = formatDateISO(new Date());
  const isCurrentOrPastWeek = weekStart <= todayWeekStart;

  useEffect(() => {
    setRows([]);
    setRowsInitialized(false);
    setEditingRowIdx(null);
    setShowMissing(false);
    setAssignmentChanged(null);
    setLockedError(null);
    setPeriodClosedError(null);
    setSettledDayError(null);
  }, [weekStartStr]);

  const resolveTaskNames = useCallback(
    (
      entries: {
        project_id: string;
        task_id: string;
        entry_date: string;
        hours: number;
      }[],
    ): Map<string, string> => {
      const resolved = new Map<string, string>();
      if (!currentTimesheet) return resolved;

      const projectTasks = currentTimesheet.project_tasks ?? [];
      const tasksByProject = new Map<string, Set<string>>();
      for (const e of entries) {
        if (!tasksByProject.has(e.project_id))
          tasksByProject.set(e.project_id, new Set());
        tasksByProject.get(e.project_id)!.add(e.task_id);
      }
      for (const [pid, taskIds] of tasksByProject) {
        const pName = projectMap.get(pid);
        if (!pName) continue;
        const pts = projectTasks.filter((pt) => pt.project_name === pName);
        if (taskIds.size === 1 && pts.length === 1) {
          resolved.set([...taskIds][0], pts[0].task_name);
        }
      }

      const dailyEntries = currentTimesheet.daily_entries ?? {};
      for (const entry of entries) {
        if (resolved.has(entry.task_id)) continue;
        const dateKey = entry.entry_date.split("T")[0];
        const pName = projectMap.get(entry.project_id);
        if (!pName) continue;
        const dailies = dailyEntries[dateKey] ?? [];
        const match = dailies.find(
          (d) => d.project_name === pName && d.hours === entry.hours,
        );
        if (match) resolved.set(entry.task_id, match.task_name);
      }

      return resolved;
    },
    [currentTimesheet, projectMap],
  );

  // Re-resolve task names once projectMap is ready (assignedProjects may arrive after rows init)
  useEffect(() => {
    if (!rowsInitialized || !timesheetDetail?.entries?.length) return;
    const taskNames = resolveTaskNames(timesheetDetail.entries);
    if (!taskNames.size) return;
    setKnownTasks((prev) => {
      const next = new Map(prev);
      let changed = false;
      taskNames.forEach((v, k) => {
        if (!prev.has(k)) {
          next.set(k, v);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [resolveTaskNames, rowsInitialized, timesheetDetail?.entries]);

  useEffect(() => {
    if (rowsInitialized || isFetchingDetail) return;

    // Bail out if currentTimesheet hasn't settled to the current week yet.
    // This prevents the previous week's data from filling rows during the
    // brief moment before the timesheets list query re-resolves.
    if (
      currentTimesheet &&
      !currentTimesheet.week_start_date.startsWith(weekStartStr)
    )
      return;

    // Only use timesheetDetail if it belongs to the current timesheet.
    if (currentTimesheet && timesheetDetail?.entries?.length) {
      const taskNames = resolveTaskNames(timesheetDetail.entries);
      const grouped = new Map<string, EntryRow>();
      for (const entry of timesheetDetail.entries) {
        const key = `${entry.project_id}-${entry.task_id}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            project_id: entry.project_id,
            task_id: entry.task_id,
            task_name: taskNames.get(entry.task_id),
            hours: {},
            notes: entry.notes ?? "",
          });
        }
        const row = grouped.get(key)!;
        row.hours[entry.entry_date.split("T")[0]] = entry.hours;
      }
      if (taskNames.size > 0) {
        setKnownTasks((prev) => {
          const next = new Map(prev);
          taskNames.forEach((v, k) => next.set(k, v));
          return next;
        });
      }
      setRows(Array.from(grouped.values()));
      setRowsInitialized(true);
      return;
    }

    if (
      currentTimesheet?.daily_entries &&
      Object.keys(currentTimesheet.daily_entries).length > 0
    ) {
      const reverseProjectMap = new Map<string, string>();
      projectMap.forEach((name, id) => reverseProjectMap.set(name, id));
      const grouped = new Map<string, EntryRow>();
      for (const [dateKey, dayEntries] of Object.entries(
        currentTimesheet.daily_entries,
      )) {
        for (const entry of dayEntries) {
          const key = `${entry.project_name}||${entry.task_name}`;
          if (!grouped.has(key)) {
            grouped.set(key, {
              project_id: reverseProjectMap.get(entry.project_name) ?? "",
              task_id: "",
              task_name: entry.task_name,
              hours: {},
              notes: "",
            });
          }
          grouped.get(key)!.hours[dateKey] =
            (grouped.get(key)!.hours[dateKey] ?? 0) + entry.hours;
        }
      }
      setRows(Array.from(grouped.values()));
      setRowsInitialized(true);
      return;
    }

    if (currentTimesheet) {
      setRows([
        {
          project_id: "",
          task_id: "",
          task_name: undefined,
          hours: {},
          notes: "",
        },
      ]);
      setEditingRowIdx(0);
      setRowsInitialized(true);
    }
  }, [
    timesheetDetail,
    currentTimesheet,
    rowsInitialized,
    isFetchingDetail,
    resolveTaskNames,
    weekStartStr,
  ]);

  const navigateWeek = (dir: number) => {
    if (dir > 0 && !isCurrentOrPastWeek) return;
    const candidate = new Date(weekStart);
    candidate.setDate(candidate.getDate() + dir * 7);
    if (dir > 0 && candidate > todayWeekStart) return;
    const candidateStr = formatDateISO(candidate);

    if (monthWeeks.some((w) => formatDateISO(w) === candidateStr)) {
      setWeekStart(candidate);
      return;
    }

    // Candidate is outside current display month — shift display month
    const rawMonth = displayMonth.month + dir;
    const newYear =
      displayMonth.year + (rawMonth < 0 ? -1 : rawMonth > 11 ? 1 : 0);
    const newMonth = ((rawMonth % 12) + 12) % 12;
    const newDisplay = { year: newYear, month: newMonth };
    const newMonthWeeks = getWeeksInMonth(newYear, newMonth);

    // When going forward, only flip the display month if the new month has at
    // least one week that isn't in the future (otherwise there's nothing to
    // show and the user would be looking at a disabled-only week list).
    if (dir > 0) {
      const hasNavigableWeek = newMonthWeeks.some((w) => w <= todayWeekStart);
      if (!hasNavigableWeek) return;
    }

    // If the current weekStart is a boundary week of the new month, just
    // change the display so the user sees that same week in the new month's
    // context (navigate it twice); next click will advance by 7 days.
    const weekStartStr2 = formatDateISO(weekStart);
    if (newMonthWeeks.some((w) => formatDateISO(w) === weekStartStr2)) {
      setDisplayMonth(newDisplay);
    } else {
      setWeekStart(candidate);
      setDisplayMonth(newDisplay);
    }
  };

  const handleCreateTimesheet = async () => {
    try {
      await createTimesheet({ week_start_date: weekStartStr }).unwrap();
      toast.success("Timesheet created successfully");
    } catch (err: any) {
      toast.error(
        err?.data?.detail ?? err?.data?.message ?? "Failed to create timesheet",
      );
    }
  };

  const handleAddRow = () => {
    setRows((prev) => [
      ...prev,
      {
        project_id: "",
        task_id: "",
        task_name: undefined,
        hours: {},
        notes: "",
      },
    ]);
    setEditingRowIdx(rows.length);
  };

  const updateRowProject = (rowIdx: number, projectId: string) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx ? { ...r, project_id: projectId, task_id: "" } : r,
      ),
    );
    setEditingRowIdx(rowIdx);
  };

  const updateRowTask = (rowIdx: number, taskId: string) => {
    const row = rows[rowIdx];
    if (row) {
      const exists = rows.some(
        (r, i) =>
          i !== rowIdx &&
          r.project_id === row.project_id &&
          r.task_id === taskId,
      );
      if (exists) {
        toast.error("This project-task combination already exists");
        return;
      }
    }
    const taskName = (addProjectTasks ?? []).find(
      (t) => t.task_id === taskId,
    )?.task_name;
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx ? { ...r, task_id: taskId, task_name: taskName } : r,
      ),
    );
    setEditingRowIdx(null);
  };

  const updateHours = (
    rowIdx: number,
    dateStr: string,
    value: number | undefined,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        if (value === undefined) {
          const { [dateStr]: _, ...rest } = r.hours;
          return { ...r, hours: rest };
        }
        const clamped = Math.min(24, Math.max(0, isNaN(value) ? 0 : value));
        return { ...r, hours: { ...r.hours, [dateStr]: clamped } };
      }),
    );
  };

  // OTP-style: move focus to the next enabled (non-future, editable) day input
  const focusNextDay = (rowIdx: number, dayIdx: number) => {
    const row = rows[rowIdx];
    if (!row) return;
    for (let i = dayIdx + 1; i < weekDates.length; i++) {
      const dateStr = formatDateISO(weekDates[i]);
      if (dateStr > todayStr) continue; // skip future (disabled) days
      if (!isCellEditable(row, dateStr)) continue; // skip settled days
      const el = document.getElementById(
        `ts-day-${rowIdx}-${i}`,
      ) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
        return;
      }
    }
  };

  // OTP-style: backspace on an empty cell jumps to the previous enabled day
  const focusPrevDay = (rowIdx: number, dayIdx: number) => {
    const row = rows[rowIdx];
    if (!row) return;
    for (let i = dayIdx - 1; i >= 0; i--) {
      if (!isCellEditable(row, formatDateISO(weekDates[i]))) continue;
      const el = document.getElementById(
        `ts-day-${rowIdx}-${i}`,
      ) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
        return;
      }
    }
  };

  const updateNotes = (rowIdx: number, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === rowIdx ? { ...r, notes: value } : r)),
    );
  };

  const removeRow = (rowIdx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== rowIdx));
  };

  /**
   * The full week, always. POST /my-timesheets/{id}/entries REPLACES the
   * timesheet's contents — anything missing from the payload is deleted — so
   * this must never return a partial set.
   *
   * Three cell states, and the difference matters:
   *   untouched  → no key in row.hours   → no entry object
   *   explicit 0 → key present, value 0  → entry object with hours: 0
   *   cleared    → key removed by updateHours → no entry object (deleted)
   */
  // Takes the rows explicitly so a caller can pass a just-computed set — the
  // zero-fill on submit can't wait a render for setRows to land.
  const buildEntries = (source: EntryRow[] = rows): TimesheetEntryInput[] => {
    const entries: TimesheetEntryInput[] = [];
    for (const row of source) {
      if (!row.project_id || !row.task_id) continue;
      for (const [dateStr, hours] of Object.entries(row.hours)) {
        // No truthiness check — 0 is real data ("no time on this task that day")
        if (hours === undefined || hours === null) continue;
        entries.push({
          project_id: row.project_id,
          task_id: row.task_id,
          entry_date: dateStr,
          hours,
          notes: row.notes || null,
        });
      }
    }
    return entries;
  };

  /**
   * Rows carrying hours but missing a project or task can't be expressed in the
   * payload, and under replace semantics dropping them silently deletes those
   * hours server-side. Refuse the save instead.
   */
  const unsavableRows = rows.filter(
    (r) => (!r.project_id || !r.task_id) && Object.keys(r.hours).length > 0,
  );

  /** Shared guards for both save and submit — both post the whole week. */
  const blockedReason = (): string | null => {
    if (validRows.length === 0) {
      return "Please add at least one project and task before saving.";
    }
    if (exceededDays.length > 0) {
      return "Daily hours cannot exceed 24. Please review the highlighted columns.";
    }
    if (unsavableRows.length > 0) {
      return "Every row with hours needs a project and a task. Saving now would remove those hours.";
    }
    return null;
  };

  /**
   * A rejected save must never look like a successful one. The two lock cases
   * each get a banner that names the reason; everything else falls through to a
   * toast. TSM-004 also pulls server state back in, since the grid should not
   * have been editable at all.
   */
  const handleSaveFailure = (err: unknown, fallback: string) => {
    if (hasErrorCode(err, "TSM-004")) {
      setLockedError(
        "This timesheet has already been submitted and can't be edited. Ask your manager to reject it if you need to change it.",
      );
      // Re-read status and entries; the effect rebuilds the grid from them
      setRowsInitialized(false);
      refetchDetail();
      return;
    }
    // TSM-035 — the monthly cutoff closed this period. The message names the
    // cutoff date and the projects still closed, so show it verbatim. Saving is
    // blocked per project, so part of the week may still be writable; the grid
    // stays as it is rather than being wiped.
    if (hasErrorCode(err, "TSM-035")) {
      setPeriodClosedError(
        extractErrorMessage(
          err,
          "This week's period has closed and can no longer be edited or submitted. Ask the project manager to reopen the month.",
        ),
      );
      return;
    }
    // TSM-036 — a day that was already submitted with hours would have changed.
    // The message names the dates, so pull them out to highlight those columns.
    if (hasErrorCode(err, "TSM-036")) {
      const message = extractErrorMessage(
        err,
        "This timesheet has been submitted — only days with no hours logged can still be filled in.",
      );
      setSettledDayError({
        message,
        dates: new Set(message.match(/\d{4}-\d{2}-\d{2}/g) ?? []),
      });
      // The grid drifted from the server's idea of what's settled — re-read it
      setRowsInitialized(false);
      refetchDetail();
      return;
    }
    toast.error(err, fallback);
  };

  const handleSave = async () => {
    if (!currentTimesheet || isBusy) return;
    const blocked = blockedReason();
    if (blocked) {
      setShowMissing(true);
      toast.error(blocked);
      return;
    }
    setIsBusy(true);
    try {
      await saveEntries({
        id: currentTimesheet.id,
        body: { entries: buildEntries() },
      }).unwrap();
      setLockedError(null);
      setPeriodClosedError(null);
      setSettledDayError(null);
      toast.success("Entries saved successfully");
    } catch (err) {
      handleSaveFailure(err, "Failed to save entries");
    } finally {
      setIsBusy(false);
    }
  };

  const isRejected =
    currentTimesheet?.timesheet_status === "l1_rejected" ||
    currentTimesheet?.timesheet_status === "client_rejected";

  const projectApprovals =
    timesheetDetail?.project_approvals ??
    currentTimesheet?.project_approvals ??
    [];
  const rejectedProjects = projectApprovals.filter(
    (pa) => pa.status === "l1_rejected" || pa.status === "client_rejected",
  );
  const approvedProjects = projectApprovals.filter(
    (pa) => pa.status === "l1_approved" || pa.status === "client_approved",
  );

  /**
   * Every still-empty required cell, set to 0.
   *
   * An empty day used to block submission until it was typed into by hand.
   * That asked people to state something they'd already stated by leaving it
   * blank — nobody logs a day they didn't work — so the confirm dialog names
   * how many will be zeroed and this applies it on confirm.
   *
   * Returns the same array when there's nothing to fill, so the caller can
   * skip the state write.
   */
  const withMissingZeroed = (): EntryRow[] => {
    if (missingCells.length === 0) return rows;
    const byRow = new Map<number, string[]>();
    for (const c of missingCells) {
      if (!byRow.has(c.rowIdx)) byRow.set(c.rowIdx, []);
      byRow.get(c.rowIdx)!.push(requiredDates[c.dayIdx]);
    }
    return rows.map((row, i) => {
      const dates = byRow.get(i);
      if (!dates) return row;
      const hours = { ...row.hours };
      for (const d of dates) hours[d] = 0;
      return { ...row, hours };
    });
  };

  const handleSubmit = async () => {
    // Guard on isBusy too: the dialog button is disabled from the flag below,
    // but this closes the window between click and re-render.
    if (!currentTimesheet || isBusy) return;
    const blocked = blockedReason();
    if (blocked) {
      setShowMissing(true);
      toast.error(blocked);
      setSubmitConfirm(false);
      return;
    }
    // Confirmed in the dialog — fill the blanks and submit what the user saw
    // described, rather than sending it back to the grid.
    const filledRows = withMissingZeroed();
    if (filledRows !== rows) setRows(filledRows);
    setIsBusy(true);
    try {
      await saveEntries({
        id: currentTimesheet.id,
        body: { entries: buildEntries(filledRows) },
      }).unwrap();
      setLockedError(null);
      setPeriodClosedError(null);
      setSettledDayError(null);
      if (isRejected) {
        await resubmitTimesheet(currentTimesheet.id).unwrap();
      } else {
        await submitTimesheet(currentTimesheet.id).unwrap();
      }
      toast.success("Timesheet submitted for approval");
    } catch (err) {
      // TSM-034 — time logged against a task the employee was since unassigned
      // from. The entries are saved; only the submit failed, so keep the user on
      // the grid with the offending task/date pairs named and refresh the task
      // list so the picker reflects the new assignment.
      if (hasErrorCode(err, "TSM-034")) {
        setAssignmentChanged(
          extractErrorMessage(
            err,
            "Your assignment changed — remove or re-enter the affected time before submitting.",
          ),
        );
        refetchAssignedProjects();
      } else {
        handleSaveFailure(err, "Failed to submit timesheet");
      }
    } finally {
      setIsBusy(false);
      setSubmitConfirm(false);
    }
  };

  const getRowTotal = (row: EntryRow) =>
    Object.values(row.hours).reduce((s, h) => s + (h || 0), 0);
  const weekTotal = rows.reduce((s, r) => s + getRowTotal(r), 0);

  const dayTotals = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of weekDates) {
      const dateStr = formatDateISO(d);
      map[dateStr] = rows.reduce((s, r) => s + (r.hours[dateStr] || 0), 0);
    }
    return map;
  }, [rows, weekDates]);

  const exceededDays = Object.entries(dayTotals)
    .filter(([, t]) => t > 24)
    .map(([d]) => d);

  // All non-future dates in the week (all 7 days including Sat/Sun)
  const requiredDates = weekDates
    .map((d) => formatDateISO(d))
    .filter((d) => d <= todayStr);
  // Valid rows have both project and task selected
  const validRows = rows.filter((r) => r.project_id && r.task_id);

  // Day cells that still need hours before the timesheet can be submitted.
  // requiredDates is weekDates minus the trailing future days, so its indexes
  // line up with the day columns.
  const missingCells = rows.flatMap((row, rowIdx) =>
    !row.project_id || !row.task_id || !isRowEditable(row)
      ? []
      : requiredDates.flatMap((d, dayIdx) =>
          row.hours[d] === undefined
            ? [{ rowIdx, dayIdx, projectId: row.project_id }]
            : [],
        ),
  );
  const missingCellKeys = new Set(
    missingCells.map((c) => `${c.rowIdx}-${c.dayIdx}`),
  );
  // A row's project/task selects are flagged only when they actually block
  // submission: nothing valid at all, or a half-filled row.
  const isRowSelectionMissing = (row: EntryRow) =>
    isRowEditable(row) &&
    (validRows.length === 0
      ? !row.project_id || !row.task_id
      : Boolean(row.project_id) !== Boolean(row.task_id));

  const dangerFieldClass =
    "border-destructive bg-destructive/5 focus-visible:border-destructive focus-visible:ring-destructive/30";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {!embedded && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate({ to: "/timesheet/my-timesheet" })}
            >
              <ArrowLeft />
            </Button>
          )}
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              My Timesheet
            </h1>
            <p className="text-sm text-muted-foreground">
              Log your weekly work hours
            </p>
          </div>
        </div>
      </div>

      {/* Select a Week */}
      <div className="rounded-xl border bg-card px-6 py-5">
        <h2 className="text-xl font-semibold text-foreground">Select a Week</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose a week from the options below to view or manage your detailed
          timesheet entries.
        </p>
      </div>

      {/* Locked: the grid is read-only and the reason should be visible */}
      {currentTimesheet && !isEditable && (
        <div className="flex items-start gap-3 rounded-xl border bg-muted/40 px-4 py-3">
          <Lock className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {lockedStatusLabel(currentTimesheet.timesheet_status)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {lockedError ??
                "This week is read-only. Ask your manager to reject it if you need to make changes."}
            </p>
          </div>
        </div>
      )}

      {/* TSM-035 — the monthly cutoff closed this period. The message names the
          cutoff date and which projects are still closed, so it carries the
          detail; saving may still work for a project that was reopened. */}
      {periodClosedError && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3">
          <Lock className="size-4 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              This period has closed
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {periodClosedError}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => setPeriodClosedError(null)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* Submitted but not yet acted on: the open days can still be filled in */}
      {editMode === "zero-days" && (
        <div className="flex items-start gap-3 rounded-xl border bg-muted/40 px-4 py-3">
          <Lock className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {lockedStatusLabel(
                currentTimesheet?.timesheet_status ?? "submitted",
              )}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Days you already logged hours for are locked. You can still fill
              in the days left at zero — saving updates the submitted week, so
              there's nothing to submit again.
            </p>
          </div>
        </div>
      )}

      {/* TSM-036 — an already-submitted day would have changed */}
      {settledDayError && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <Lock className="size-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">
              Those days are already submitted
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {settledDayError.message}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => setSettledDayError(null)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* Rejection banner — includes the approver's comment so the user knows
          what to change before resubmitting */}
      {currentTimesheet && isRejected && rejectedProjects.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">
              Some projects need your attention
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {rejectedProjects.map((p) => p.project_name).join(", ")}{" "}
              {rejectedProjects.length === 1 ? "was" : "were"} rejected. Update
              your entries and resubmit.
            </p>
            <div className="mt-2 space-y-1.5">
              {rejectedProjects.map((pa) => {
                const comment =
                  pa.status === "client_rejected"
                    ? pa.client_comments
                    : pa.l1_comments;
                const by =
                  pa.status === "client_rejected"
                    ? pa.client_approver_name
                    : pa.l1_approver_name;
                if (!comment) return null;
                return (
                  <p key={pa.project_id} className="text-xs text-foreground">
                    <span className="font-medium">{pa.project_name}</span>
                    {by ? (
                      <span className="text-muted-foreground"> · {by}</span>
                    ) : null}
                    <span className="text-muted-foreground italic">
                      {" "}
                      — "{comment}"
                    </span>
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Main card: week navigation + table / states */}
      <div className="rounded-xl border overflow-x-auto bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-info hover:text-info"
                aria-label="Jump to a week"
              >
                <Calendar className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <CalendarPicker
                mode="single"
                selected={weekStart}
                defaultMonth={weekStart}
                onSelect={(date) => {
                  selectWeekFromDate(date);
                  setDatePickerOpen(false);
                }}
                disabled={(date) => getMonday(date) > todayWeekStart}
              />
            </PopoverContent>
          </Popover>
          <span className="text-sm font-semibold text-foreground">
            {MONTH_NAMES[weekDates[0].getMonth()]} {weekDates[0].getFullYear()}
          </span>
          <div className="ml-2 flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => navigateWeek(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex items-center gap-3 rounded-xl border px-3 py-1.5 text-sm">
              <span className="font-medium text-foreground">
                Week {currentWeekIndex + 1}
              </span>
              <span className="text-muted-foreground">
                {formatNavDate(weekDates[0])} - {formatNavDate(weekDates[6])}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => navigateWeek(1)}
              disabled={weekStart >= todayWeekStart}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        {isLoadingTimesheets ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading...
            </span>
          </div>
        ) : !currentTimesheet ? (
          <div className="py-12 text-center">
            <Clock className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground mb-4">
              No timesheet exists for this week
            </p>
            <Button
              onClick={handleCreateTimesheet}
              disabled={isCreating}
            >
              {isCreating && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              <Plus className="size-4 mr-1" />
              Create Timesheet
            </Button>
          </div>
        ) : (
          <div className="px-4 py-4">
            <div className="w-full">
              <Table className="table-fixed w-full">
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="w-[12%] text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                      Status
                    </TableHead>
                    <TableHead className="w-[13%] text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                      Project
                    </TableHead>
                    <TableHead className="w-[10%] text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                      Task
                    </TableHead>
                    {weekDates.map((d, i) => {
                      const dk = formatDateISO(d);
                      const meta = dayMeta.get(dk);
                      return (
                        <TableHead
                          key={i}
                          className="text-center w-[7%] text-xs font-medium text-muted-foreground uppercase tracking-wide h-10"
                        >
                          <div className="flex items-center justify-center gap-1 normal-case">
                            <span className="font-semibold text-foreground">
                              {DAYS[i]},
                            </span>
                            <span className="font-normal text-muted-foreground/70">
                              {NAV_MONTHS[d.getMonth()]} {d.getDate()}
                            </span>
                          </div>
                          {/* One chip for every kind of non-working day. A week
                              off, a holiday and a full-day leave all mean the
                              same thing to whoever is filling this in, so they
                              wear the same muted style; half days keep the
                              info tint because they're partly working. The
                              holiday name and leave type move to the tooltip —
                              the coloured dots they used to be were a second
                              vocabulary for the same fact. */}
                          {meta && (
                            <div className="mt-0.5">
                              <span
                                className={`inline-block max-w-full truncate rounded px-1 py-0 text-[9px] font-medium normal-case ${
                                  meta.kind === "half"
                                    ? "bg-info/10 text-info"
                                    : meta.kind === "working"
                                      ? // Quietest of the three: it's the
                                        // default state, and five of these in
                                        // a row shouldn't shout.
                                        "bg-muted/50 text-muted-foreground/70"
                                      : "bg-muted text-muted-foreground"
                                }`}
                                title={meta.title}
                              >
                                {meta.label}
                              </span>
                            </div>
                          )}
                        </TableHead>
                      );
                    })}
                    <TableHead className="w-[10%] text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Notes
                    </TableHead>
                    <TableHead className="text-center w-[5%] text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Total
                    </TableHead>
                    {isEditable && <TableHead className="w-8"></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, rowIdx) => {
                    return (
                      <TableRow
                        key={rowIdx}
                        className={
                          (row.project_id &&
                            projectApprovalMap.get(row.project_id)?.status ===
                              "l1_approved") ||
                          (row.project_id &&
                            projectApprovalMap.get(row.project_id)?.status ===
                              "client_approved")
                            ? "opacity-60 bg-muted/10"
                            : row.project_id &&
                                (projectApprovalMap.get(row.project_id)
                                  ?.status === "l1_rejected" ||
                                  projectApprovalMap.get(row.project_id)
                                    ?.status === "client_rejected")
                              ? "bg-destructive/5"
                              : undefined
                        }
                      >
                        {/* Status column */}
                        <TableCell className="p-2 text-center">
                          {(() => {
                            const pa = row.project_id
                              ? projectApprovalMap.get(row.project_id)
                              : undefined;
                            if (!pa) return null;
                            // No approval details yet (e.g. submitted/pending) → plain badge, no hover
                            const hasDetails = Boolean(
                              pa.l1_approver_name || pa.client_approver_name,
                            );
                            if (!hasDetails) {
                              return (
                                <ProjectApprovalBadge status={pa.status} />
                              );
                            }
                            return (
                              <HoverCard>
                                <HoverCardTrigger asChild>
                                  <span className="cursor-help inline-flex">
                                    <ProjectApprovalBadge status={pa.status} />
                                  </span>
                                </HoverCardTrigger>
                                <HoverCardContent className="w-96" side="right">
                                  <p className="text-xs font-semibold text-foreground mb-3">
                                    {pa.project_name}
                                  </p>
                                  <div className="grid grid-cols-2 gap-4">
                                    {/* Manager */}
                                    {pa.l1_approver_name && (
                                      <div className="space-y-0.5">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                          Manager
                                        </p>
                                        <p className="text-sm text-foreground">
                                          {pa.l1_approver_name}
                                        </p>
                                        {pa.l1_acted_at && (
                                          <p className="text-xs text-muted-foreground">
                                            {formatDateTimeIST(pa.l1_acted_at)}
                                          </p>
                                        )}
                                        {pa.l1_comments && (
                                          <p className="text-xs text-foreground mt-0.5 italic">
                                            "{pa.l1_comments}"
                                          </p>
                                        )}
                                      </div>
                                    )}
                                    {/* Client */}
                                    {pa.client_approver_name && (
                                      <div className="space-y-0.5">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                          Client
                                        </p>
                                        <p className="text-sm text-foreground">
                                          {pa.client_approver_name}
                                        </p>
                                        {pa.client_acted_at && (
                                          <p className="text-xs text-muted-foreground">
                                            {formatDateTimeIST(pa.client_acted_at)}
                                          </p>
                                        )}
                                        {pa.client_comments && (
                                          <p className="text-xs text-foreground mt-0.5 italic">
                                            "{pa.client_comments}"
                                          </p>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </HoverCardContent>
                              </HoverCard>
                            );
                          })()}
                        </TableCell>
                        <TableCell
                          className={`p-1 align-middle max-w-0 ${!isRowEditable(row) ? "text-center" : ""}`}
                        >
                          {isRowEditable(row) ? (
                            <div className="flex items-center gap-1">
                              {/* Reassigned away: the option is gone from the
                                  dropdown, so mark it rather than let the row
                                  look ordinary until submit fails */}
                              {isProjectUnassigned(row) && (
                                <AlertTriangle
                                  className="size-3.5 shrink-0 text-warning"
                                  aria-label="No longer assigned"
                                />
                              )}
                              <Select
                                value={row.project_id || undefined}
                                onValueChange={(v) =>
                                  updateRowProject(rowIdx, v)
                                }
                              >
                                <SelectTrigger
                                  title={
                                    isProjectUnassigned(row)
                                      ? "You're no longer assigned to this project — pick another before submitting"
                                      : undefined
                                  }
                                  className={`h-7 text-xs my-1 w-full ${
                                    showMissing &&
                                    isRowSelectionMissing(row) &&
                                    !row.project_id
                                      ? dangerFieldClass
                                      : isProjectUnassigned(row)
                                        ? unassignedFieldClass
                                        : ""
                                  }`}
                                >
                                  <SelectValue placeholder="Select project" />
                                </SelectTrigger>
                                <SelectContent>
                                  {(() => {
                                    const opts = activeProjects.map((p) => ({
                                      id: p.id,
                                      name: p.name,
                                    }));
                                    // Keep an already-selected (possibly inactive) project visible
                                    if (
                                      row.project_id &&
                                      !opts.some((o) => o.id === row.project_id)
                                    ) {
                                      opts.unshift({
                                        id: row.project_id,
                                        name:
                                          projectMap.get(row.project_id) ??
                                          row.project_id,
                                      });
                                    }
                                    return opts.map((o) => (
                                      <SelectItem key={o.id} value={o.id}>
                                        {o.name}
                                      </SelectItem>
                                    ));
                                  })()}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : (
                            <div
                              className="font-medium text-sm break-words whitespace-normal leading-snug w-full"
                              title={
                                isProjectUnassigned(row)
                                  ? "You're no longer assigned to this project"
                                  : undefined
                              }
                            >
                              {isProjectUnassigned(row) && (
                                <AlertTriangle className="inline size-3 mr-1 align-[-1px] text-warning" />
                              )}
                              {projectMap.get(row.project_id) ?? row.project_id}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="p-1 align-middle max-w-0 text-center">
                          {isRowEditable(row) ? (
                            <div className="flex items-center gap-1">
                              {isTaskUnassigned(row) && (
                                <AlertTriangle
                                  className="size-3.5 shrink-0 text-warning"
                                  aria-label="No longer assigned"
                                />
                              )}
                              <Select
                                key={row.project_id}
                                value={row.task_id || undefined}
                                onValueChange={(v) => updateRowTask(rowIdx, v)}
                                disabled={!row.project_id}
                                onOpenChange={(open) => {
                                  if (open) setEditingRowIdx(rowIdx);
                                }}
                              >
                                <SelectTrigger
                                  title={
                                    isTaskUnassigned(row)
                                      ? "This task is no longer assigned to you — pick another before submitting"
                                      : undefined
                                  }
                                  className={`h-7 text-xs my-1 w-full ${
                                    showMissing &&
                                    isRowSelectionMissing(row) &&
                                    !row.task_id
                                      ? dangerFieldClass
                                      : isTaskUnassigned(row)
                                        ? unassignedFieldClass
                                        : ""
                                  }`}
                                >
                                  <SelectValue placeholder="Select task" />
                                </SelectTrigger>
                                <SelectContent>
                                  {editingRowIdx === rowIdx ? (
                                    (addProjectTasks ?? []).map((t) => (
                                      <SelectItem
                                        key={t.task_id}
                                        value={t.task_id}
                                      >
                                        {t.task_name}
                                      </SelectItem>
                                    ))
                                  ) : row.task_id ? (
                                    <SelectItem value={row.task_id}>
                                      {row.task_name ??
                                        knownTasks.get(row.task_id) ??
                                        row.task_id}
                                    </SelectItem>
                                  ) : null}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : (
                            <div
                              className="text-sm break-words whitespace-normal leading-snug w-full text-center"
                              title={
                                isTaskUnassigned(row)
                                  ? "This task is no longer assigned to you"
                                  : undefined
                              }
                            >
                              {isTaskUnassigned(row) && (
                                <AlertTriangle className="inline size-3 mr-1 align-[-1px] text-warning" />
                              )}
                              {row.task_name ??
                                knownTasks.get(row.task_id) ??
                                row.task_id}
                            </div>
                          )}
                        </TableCell>
                        {weekDates.map((d, dayIdx) => {
                          const dateStr = formatDateISO(d);
                          const isFuture = dateStr > todayStr;
                          const meta = dayMeta.get(dateStr);
                          const isMissing =
                            showMissing &&
                            missingCellKeys.has(`${rowIdx}-${dayIdx}`);
                          // Settled: already submitted with hours. Muted with a
                          // lock so it reads as done, not merely unavailable.
                          const settled = isDaySettled(dateStr);
                          const flagged = tsm036Dates.has(dateStr);
                          return (
                            <TableCell
                              key={dayIdx}
                              title={
                                settled
                                  ? "Submitted — ask your manager to reject the week to change this day"
                                  : undefined
                              }
                              className={`p-1 align-middle ${
                                flagged
                                  ? "bg-destructive/10"
                                  : isMissing
                                    ? "bg-destructive/10"
                                    : settled
                                      ? "bg-muted"
                                      : // Every non-working day tints the
                                        // same, matching its header chip. A
                                        // working day stays plain — it's the
                                        // one you're meant to type into.
                                        meta?.kind === "half"
                                        ? "bg-info/5"
                                        : meta && meta.kind !== "working"
                                          ? "bg-muted/40"
                                          : ""
                              }`}
                            >
                              <HoursInput
                                id={`ts-day-${rowIdx}-${dayIdx}`}
                                className={`w-full text-center h-7 text-xs mx-auto ${
                                  isMissing || flagged ? dangerFieldClass : ""
                                } ${settled ? "border-transparent bg-transparent shadow-none font-medium" : ""}`}
                                value={row.hours[dateStr]}
                                onChange={(v) =>
                                  updateHours(rowIdx, dateStr, v)
                                }
                                onAdvance={() => focusNextDay(rowIdx, dayIdx)}
                                onBack={() => focusPrevDay(rowIdx, dayIdx)}
                                disabled={
                                  !isCellEditable(row, dateStr) || isFuture
                                }
                              />
                            </TableCell>
                          );
                        })}
                        <TableCell className="p-1 align-middle">
                          <Textarea
                            value={row.notes}
                            onChange={(e) =>
                              updateNotes(rowIdx, e.target.value)
                            }
                            placeholder="Add notes..."
                            disabled={!isRowEditable(row)}
                            className="w-full h-7 min-h-0 resize-none text-xs py-1 leading-tight"
                            rows={1}
                          />
                        </TableCell>
                        <TableCell className="text-center font-semibold text-sm">
                          {getRowTotal(row)}
                        </TableCell>
                        {isEditable && (
                          <TableCell>
                            {isRowEditable(row) && rows.length > 1 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-muted-foreground hover:text-destructive"
                                onClick={() => removeRow(rowIdx)}
                              >
                                <Trash2 />
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                  {rows.length > 0 && (
                    <TableRow className="bg-table-header font-semibold">
                      <TableCell colSpan={3}>Total Daily Hours</TableCell>
                      {weekDates.map((d, i) => {
                        const dateStr = formatDateISO(d);
                        const total = dayTotals[dateStr] ?? 0;
                        const over = total > 24;
                        return (
                          <TableCell
                            key={i}
                            className={`text-center text-sm ${over ? "text-destructive bg-destructive/5" : ""}`}
                          >
                            <span title={over ? "Exceeds 24 hours" : undefined}>
                              {toHHMM(total)}
                              {over ? " ⚠" : ""}
                            </span>
                          </TableCell>
                        );
                      })}
                      <TableCell />
                      <TableCell className="text-center">{weekTotal}</TableCell>
                      {isEditable && <TableCell />}
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {isEditable && (
              <div className="pt-4">
                <Button variant="outline" size="sm" onClick={handleAddRow}>
                  <Plus className="size-4 mr-1" />
                  Add project
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Assignment changed under the employee (TSM-034) — stays until fixed */}
      {assignmentChanged && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-destructive mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-destructive">
              {assignmentChanged}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Your entries are saved. Remove or re-enter the time listed above,
              then submit again — the project and task pickers have been
              refreshed with what you can log against now.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => setAssignmentChanged(null)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* Missing-entry warning */}
      {showMissing &&
        currentTimesheet &&
        isEditable &&
        (missingCells.length > 0 || validRows.length === 0) && (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">
              {/* Empty days don't block submission any more — the confirm
                  dialog offers to zero them — so this reads as a note, not an
                  instruction. A project and task ARE still required. */}
              {validRows.length === 0
                ? "Select a project and task before submitting — the highlighted fields are required."
                : `${missingCells.length} day ${missingCells.length === 1 ? "entry is" : "entries are"} still empty. Submitting will record ${missingCells.length === 1 ? "it" : "them"} as 0 hours.`}
            </p>
          </div>
        )}

      {/* Footer actions */}
      {currentTimesheet && isEditable && rows.length > 0 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() =>
              embedded
                ? onClose?.()
                : navigate({ to: "/timesheet/my-timesheet" })
            }
          >
            Cancel
          </Button>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={handleSave} disabled={isBusy}>
              {isBusy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              <Save className="size-4 mr-1" />
              Save
            </Button>
            {/* Filling open days on a submitted week is a plain save — the
                timesheet keeps its status and no re-submit is allowed */}
            {editMode === "full" && (
              <Button
                onClick={() => {
                  if (validRows.length === 0) {
                    setShowMissing(true);
                    toast.error(
                      "Please add at least one project and task before submitting.",
                    );
                    return;
                  }
                  // Empty days no longer block. The confirm dialog says how
                  // many will be zeroed and handleSubmit applies it, so the
                  // common case — a day with no work on it — costs one click
                  // instead of a hunt through highlighted cells.
                  setShowMissing(false);
                  setSubmitConfirm(true);
                }}
                disabled={isBusy}
              >
                <SendHorizontal className="size-4 mr-1" />
                Save & Submit
              </Button>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={submitConfirm}
        onOpenChange={(open) => {
          if (!open && isBusy) return;
          setSubmitConfirm(open);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>
              {isRejected ? "Resubmit timesheet?" : "Submit timesheet?"}
            </DialogTitle>
          </DialogHeader>
          {/* Says what will be written before it's written. Sits above the
              per-case body so it's read first — it's the part that changes
              the data, and it applies to both the plain and rejected flows. */}
          {missingCells.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border bg-muted/40 px-3 py-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <p className="text-xs text-muted-foreground">
                {missingCells.length}{" "}
                {missingCells.length === 1 ? "day is" : "days are"} still empty
                and will be submitted as{" "}
                <span className="font-semibold text-foreground">0 hours</span>.
                Cancel if you meant to log time on{" "}
                {missingCells.length === 1 ? "it" : "them"}.
              </p>
            </div>
          )}
          {isRejected && projectApprovals.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Only rejected projects will be resubmitted for approval.
                Already-approved projects are not affected.
              </p>
              <div className="space-y-2 rounded-xl border bg-muted/30 px-3 py-2">
                {rejectedProjects.map((pa) => (
                  <div
                    key={pa.project_id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <AlertTriangle className="size-3.5 text-destructive shrink-0" />
                    <span className="font-medium text-foreground">
                      {pa.project_name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      — will be resubmitted
                    </span>
                  </div>
                ))}
                {approvedProjects.map((pa) => (
                  <div
                    key={pa.project_id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <CheckCircle className="size-3.5 text-success shrink-0" />
                    <span className="font-medium text-foreground">
                      {pa.project_name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      — already approved, not affected
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-sm font-semibold">Total Hours: {weekTotal}</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Are you sure you want to submit this timesheet for approval? You
                won't be able to edit it until it's reviewed.
              </p>
              <p className="text-sm font-semibold">Total Hours: {weekTotal}</p>
            </>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isBusy}>
                Cancel
              </Button>
            </DialogClose>
            {/* isBusy, not the submit mutation flags — submit saves the week
                first, so those only flip once the save has come back */}
            <Button onClick={handleSubmit} disabled={isBusy} autoFocus>
              {isBusy && <Loader2 className="animate-spin" />}
              {isRejected ? "Resubmit" : "Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TimesheetEntry;
