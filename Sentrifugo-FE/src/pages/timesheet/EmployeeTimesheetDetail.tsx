import { useState, useMemo, useCallback } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Loader2,
  FileSpreadsheet,
  FileText,
  Download,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  LockOpen,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  useGetTeamTimesheetQuery,
  useGetEmployeeDetailQuery,
  useGetEmployeeTimesheetsQuery,
  useApproveTimesheetMutation,
  useRejectTimesheetMutation,
  useBulkApproveTimesheetsMutation,
  useBulkRejectTimesheetsMutation,
} from "@/store/api/timesheetApi";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { downloadAuthed } from "@/lib/download";
import { getWeekNumberInMonth, isWeekInMonth } from "@/lib/week";
import { ReopenMonthDialog } from "./ReopenMonthDialog";
import { useAuth } from "@/hooks/use-auth";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const formatDateTime = (d: string | null) => (d ? formatDateTimeIST(d) : "—");

const formatDate = (d: string) => formatDateIST(d);

interface Props {
  timesheetId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Month being viewed on the dashboard (0-11). Falls back to the open week's
   *  own month when not supplied. */
  month?: number;
  year?: number;
  /**
   * Hides every approve / reject control in the sheet.
   *
   * Fallback only — the detail responses now carry their own `read_only`,
   * which wins. This covers the frame before either has loaded, and callers
   * that already know (the list passes what it read).
   */
  readOnly?: boolean;
}

const EmployeeTimesheetDetail = ({
  timesheetId,
  open,
  onOpenChange,
  month,
  year,
  readOnly = false,
}: Props) => {
  const [rejectDialog, setRejectDialog] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [rejectAllDialog, setRejectAllDialog] = useState(false);
  const [rejectAllComment, setRejectAllComment] = useState("");
  const [activeTimesheetId, setActiveTimesheetId] = useState<string | null>(
    null,
  );
  const [reopenDialog, setReopenDialog] = useState(false);

  const currentId = activeTimesheetId ?? timesheetId;

  const { data: detail, isLoading: isDetailLoading } = useGetTeamTimesheetQuery(
    currentId!,
    { skip: !currentId },
  );
  const { data: empDetail } = useGetEmployeeDetailQuery(detail?.user_id ?? "", {
    skip: !detail?.user_id,
  });
  const { data: empTimesheets } = useGetEmployeeTimesheetsQuery(
    { userId: detail?.user_id ?? "", page: 1, page_size: 50 },
    { skip: !detail?.user_id },
  );

  const [approveTs, { isLoading: isApproving }] = useApproveTimesheetMutation();
  const [rejectTs, { isLoading: isRejecting }] = useRejectTimesheetMutation();
  const [bulkApprove, { isLoading: isBulkApproving }] =
    useBulkApproveTimesheetsMutation();
  const [bulkReject, { isLoading: isBulkRejecting }] =
    useBulkRejectTimesheetsMutation();

  // The month in scope: the dashboard's selection when supplied, otherwise the
  // open week's own month. Everything month-scoped below keys off this, so the
  // week tabs, the Approve/Reject All set and the export all agree.
  const viewedMonth =
    month ?? (detail ? new Date(detail.week_start_date).getMonth() : null);
  const viewedYear =
    year ?? (detail ? new Date(detail.week_start_date).getFullYear() : null);

  /**
   * Weeks belonging to the viewed month's calendar grid: from the Monday of its
   * first week up to (not including) the Monday of the next month's first week.
   * That's the same grouping the dashboard uses, so a week straddling the
   * boundary — Jul 27 – Aug 2 — sits in August and numbers as its Week 1.
   */
  const isInViewedMonth = useCallback(
    (weekStartDateStr: string) =>
      viewedMonth === null || viewedYear === null
        ? true
        : isWeekInMonth(weekStartDateStr, viewedMonth, viewedYear),
    [viewedMonth, viewedYear],
  );

  const weekTabs = useMemo(
    () =>
      (empTimesheets?.items ?? [])
        // Never hide the week the user is actually looking at
        .filter(
          (wk) => wk.id === currentId || isInViewedMonth(wk.week_start_date),
        )
        .sort((a, b) => a.week_start_date.localeCompare(b.week_start_date)),
    [empTimesheets, isInViewedMonth, currentId],
  );

  // Submitted/resubmitted weeks in the viewed month — the same set the tabs
  // show, so Approve/Reject All covers exactly what's on screen
  const pendingWeekIds = (empTimesheets?.items ?? [])
    .filter(
      (w) =>
        (w.timesheet_status === "submitted" ||
          w.timesheet_status === "resubmitted") &&
        // Watched weeks are excluded: including them would inflate the
        // "Approve All (N)" count with weeks the bulk call will skip.
        !w.read_only &&
        isInViewedMonth(w.week_start_date),
    )
    .map((w) => w.id);

  const handleApproveAll = async () => {
    if (pendingWeekIds.length === 0) return;
    try {
      await bulkApprove({ timesheet_ids: pendingWeekIds }).unwrap();
      onOpenChange(false);
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 409)
        toast.error("Nothing to approve in your assigned scope.");
    }
  };

  const handleRejectAll = async () => {
    if (pendingWeekIds.length === 0 || !rejectAllComment) return;
    try {
      await bulkReject({
        timesheet_ids: pendingWeekIds,
        comments: rejectAllComment,
      }).unwrap();
      setRejectAllDialog(false);
      setRejectAllComment("");
      onOpenChange(false);
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 409)
        toast.error("Nothing to reject in your assigned scope.");
    }
  };

  /**
   * Reopening is gated on `manage_timesheet` — the grant that opens Team
   * Timesheets — not `manage_projects`, since the API moved it from a project
   * decision to a per-employee one. Hidden entirely in the reporting-line view:
   * every reopen endpoint 403s for a watcher.
   */
  const { isOrgAdmin, timesheetActions } = useAuth();
  const hasReopenGrant = isOrgAdmin || timesheetActions.manage_timesheet;

  /**
   * Whether this month can actually be reopened — from the week detail this
   * sheet already fetches, not from a second call.
   *
   * The monthly endpoint also carries the flag and names its month explicitly,
   * which sounds safer. It isn't worth it: that response is every week of the
   * month with its full entries, fetched to read one boolean.
   *
   * The straddling-week worry it would solve doesn't arise here. `weekTabs`
   * filters on isWeekInMonth(week_start_date), which buckets by the week's
   * START month — the same rule `reopen_period` uses — so every week on screen
   * starts in the viewed month and the two always agree. The guard below states
   * that rather than trusting it: if a response ever describes another month,
   * the button hides instead of speaking for a month nobody asked about.
   *
   * Entitlement, not state — true even for a month already reopened, which is
   * why the dialog reads the live grants separately.
   */
  const reopenPeriod = detail?.reopen_period;
  const reopenPeriodMatches =
    !reopenPeriod ||
    (viewedMonth !== null &&
      viewedYear !== null &&
      reopenPeriod.year === viewedYear &&
      reopenPeriod.month === viewedMonth + 1);
  const canReopen =
    hasReopenGrant && (detail?.can_reopen ?? false) && reopenPeriodMatches;

  const projectApprovals = detail?.project_approvals ?? [];

  // canApprove: any project in submitted/resubmitted state (falls back to overall status for old API)
  /**
   * The response's own answer, which is the authority: a deep link or a
   * refresh arrives with no idea which tab it came from, and a shared project
   * can be approvable for you even though you also watch it. The prop is the
   * fallback for the frame before `detail` resolves.
   */
  const isReadOnly = detail?.read_only ?? readOnly;

  const canApprove =
    !isReadOnly &&
    detail &&
    (projectApprovals.length > 0
      ? projectApprovals.some(
          (pa) => pa.status === "submitted" || pa.status === "resubmitted",
        )
      : ["submitted", "resubmitted"].includes(detail.timesheet_status ?? ""));

  // Also on an approval already given — a manager can send their own sign-off
  // back. Not on client_approved: reversing a client's approval is TSM-010.
  const canReject =
    !isReadOnly &&
    detail &&
    (projectApprovals.length > 0
      ? projectApprovals.some((pa) =>
          ["submitted", "resubmitted", "l1_approved"].includes(pa.status),
        )
      : ["submitted", "resubmitted", "l1_approved"].includes(
          detail.timesheet_status ?? "",
        ));

  const handleApprove = async () => {
    if (!currentId) return;
    try {
      await approveTs({ id: currentId, body: {} }).unwrap();
      onOpenChange(false);
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 409) {
        toast.error(
          "Nothing to approve — all your assigned projects are already approved.",
        );
      }
    }
  };

  const handleReject = async () => {
    if (!currentId) return;
    try {
      await rejectTs({
        id: currentId,
        body: { comments: rejectComment },
      }).unwrap();
      setRejectDialog(false);
      setRejectComment("");
      onOpenChange(false);
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 409) {
        toast.error("Nothing to reject in your assigned scope.");
        setRejectDialog(false);
        setRejectComment("");
      }
    }
  };

  // Export the whole month for this employee (viewed week's month/year)
  const handleMonthlyExport = async (format: "excel" | "pdf") => {
    if (!detail || viewedMonth === null || viewedYear === null) return;
    const params = new URLSearchParams({
      user_id: detail.user_id,
      month: String(viewedMonth + 1),
      year: String(viewedYear),
    });
    const ext = format === "excel" ? "xlsx" : "pdf";
    const code = detail.emp_code ?? detail.user_id ?? "timesheet";
    const fallback =
      `${code}_${viewedYear}-${String(viewedMonth + 1).padStart(2, "0")}.${ext}`.replace(
        /\s+/g,
        "_",
      );
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}approvals/timesheets/monthly/export/${format}?${params.toString()}`,
        fallback,
      );
    } catch {
      toast.error("Export failed. Please try again.");
    }
  };

  const handleExcelDownload = () => handleMonthlyExport("excel");
  const handlePdfDownload = () => handleMonthlyExport("pdf");

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setActiveTimesheetId(null);
      setRejectDialog(false);
      setRejectComment("");
    }
    onOpenChange(v);
  };

  const timeline = detail?.weekly_timeline ?? [];

  const notesMap = new Map<string, string>();
  for (const entry of detail?.entries ?? []) {
    if (entry.notes) {
      notesMap.set(`${entry.project_id}-${entry.task_id}`, entry.notes);
    }
  }

  // Build per-day breakdown from weekly_timeline (same shape as client slider)
  const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const DAY_NAMES = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  // weekly_timeline is a dense grid — a day with no entry and a day logged as 0
  // are both plain 0 there, so it can't tell them apart. detail.entries can:
  // an explicit 0 has a row, an untouched day has none. Prefer entries, and fall
  // back to the timeline only when entries aren't in the response.
  const timelineNames = new Map(
    timeline.map((row) => [
      `${row.project_id}-${row.task_id}`,
      {
        project_name: row.project_name ?? row.project_id,
        task_name: row.task_name ?? row.task_id,
      },
    ]),
  );
  const entriesByDate = new Map<
    string,
    { project_name: string; task_name: string; hours: number; notes?: string }[]
  >();
  for (const entry of detail?.entries ?? []) {
    const dateKey = entry.entry_date.split("T")[0];
    const names = timelineNames.get(`${entry.project_id}-${entry.task_id}`);
    const list = entriesByDate.get(dateKey) ?? [];
    list.push({
      project_name: names?.project_name ?? entry.project_id,
      task_name: names?.task_name ?? entry.task_id,
      hours: entry.hours,
      notes: entry.notes ?? undefined,
    });
    entriesByDate.set(dateKey, list);
  }
  const hasEntries = (detail?.entries?.length ?? 0) > 0;

  const dailyBreakdown = DAY_KEYS.map((key, idx) => {
    const date = detail ? new Date(detail.week_start_date) : new Date();
    date.setDate(date.getDate() + idx);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const tasks = hasEntries
      ? (entriesByDate.get(dateStr) ?? [])
      : timeline
          .filter((row) => (row[key] ?? 0) > 0)
          .map((row) => ({
            project_name: row.project_name ?? row.project_id,
            task_name: row.task_name ?? row.task_id,
            hours: row[key] ?? 0,
            notes: notesMap.get(`${row.project_id}-${row.task_id}`),
          }));
    const hours = timeline.reduce((sum, row) => sum + (row[key] ?? 0), 0);
    return { day: DAY_NAMES[idx], date: dateStr, hours, tasks };
  });

  /**
   * Why a day has no hours. A blank row is ambiguous on its own — a week-off, a
   * holiday, approved leave and a genuinely missed day all look identical — so
   * resolve it from the detail response, which carries all three for this week.
   * Precedence runs holiday → leave → week-off → nothing logged.
   *
   * leaves/holidays are optional and may be empty because LMS was unreachable,
   * so absence only ever means "nothing to show here". The fallback label is a
   * statement about the timesheet, never a claim that no leave was taken.
   */
  const workCalendar = detail?.work_calendar;
  const weekoffs = new Set(workCalendar?.weekoffs ?? []);
  const halfDays = new Set([
    ...(workCalendar?.first_half_days ?? []),
    ...(workCalendar?.second_half_days ?? []),
  ]);

  const dayContextLabel = (
    dateStr: string,
  ): { label: string; className: string } => {
    const holiday = (detail?.holidays ?? []).find(
      (h) => h.date.slice(0, 10) === dateStr,
    );
    if (holiday) return { label: holiday.name, className: "text-warning" };

    const leave = (detail?.leaves ?? []).find(
      (l) =>
        dateStr >= l.start_date.slice(0, 10) &&
        dateStr <= l.end_date.slice(0, 10),
    );
    // Half-day leave still leaves working hours in the day, so say which
    if (leave)
      return {
        label:
          leave.duration_mode === "HALF_DAY"
            ? `${leave.leave_type_name} (half day)`
            : leave.leave_type_name,
        className: "text-info",
      };

    if (weekoffs.has(dateStr))
      return { label: "Week off", className: "text-muted-foreground" };
    if (halfDays.has(dateStr))
      return { label: "Half working day", className: "text-muted-foreground" };

    return {
      label: "No timesheet submitted",
      className: "text-muted-foreground",
    };
  };

  // suppress unused variable warnings
  void empDetail;
  void empTimesheets;

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          className="w-[80vw] max-w-[80vw] flex flex-col p-0"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <SheetHeader className="px-6 py-5 border-b">
            <div className="flex items-center">
              <div>
                <SheetTitle>Employee Timesheet Details</SheetTitle>
                <SheetDescription>
                  Review and manage timesheet submissions
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          {isDetailLoading || !detail ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                {/* Employee Profile */}
                <div className="flex items-center gap-3">
                  <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-primary">
                      {(detail.user_name ?? detail.user_id ?? "")
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((w: string) => w[0].toUpperCase())
                        .join("")}
                    </span>
                  </div>
                  <div
                    className={
                      pendingWeekIds.length > 0 ? "min-w-0" : "flex-1 min-w-0"
                    }
                  >
                    <h2 className="text-base font-semibold text-foreground truncate">
                      {detail.user_name ?? detail.user_id}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {detail.emp_code ?? detail.user_id}
                    </p>
                  </div>
                  {!isReadOnly && pendingWeekIds.length > 0 && (
                    <div className="flex items-center gap-2 self-center flex-1">
                      <Button
                        size="sm"
                        onClick={handleApproveAll}
                        disabled={isBulkApproving}
                        title="Approve all submitted weeks this month"
                      >
                        {isBulkApproving && (
                          <Loader2 className="animate-spin" />
                        )}
                        Approve All ({pendingWeekIds.length})
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive hover:bg-destructive/10"
                        onClick={() => setRejectAllDialog(true)}
                        title="Reject all submitted weeks this month"
                      >
                        Reject All
                      </Button>
                    </div>
                  )}
                  {canReopen && !isReadOnly && viewedMonth !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 self-center"
                      onClick={() => setReopenDialog(true)}
                    >
                      <LockOpen className="size-4" /> Reopen Month
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 self-center"
                      >
                        <Download /> Export
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={handleExcelDownload}>
                        <FileSpreadsheet className="size-4 mr-2" /> Excel
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handlePdfDownload}>
                        <FileText /> PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Week selector tabs — scoped and numbered against the same
                    month, so the numbers always read 1..n in order */}
                {weekTabs.length > 1 && (
                  <div className="flex items-center gap-2 overflow-x-auto border-b pb-3">
                    {weekTabs.map((wk) => {
                      const active = wk.id === currentId;
                      return (
                        <button
                          key={wk.id}
                          type="button"
                          onClick={() => setActiveTimesheetId(wk.id)}
                          title={`${formatDate(wk.week_start_date)} – ${formatDate(wk.week_end_date)} · ${wk.total_hours}h`}
                          className={`shrink-0 rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                            active
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border text-foreground hover:bg-muted/50"
                          }`}
                        >
                          {/* Per-week, straight off the item. NOT the
                              sheet-level flag: this endpoint isn't
                              project-filtered, so one week can be actionable
                              and the next only watched. */}
                          {wk.read_only && (
                            <Eye className="mr-1.5 inline size-3.5 align-[-2px]" />
                          )}
                          Week{" "}
                          {getWeekNumberInMonth(wk.week_start_date)}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  {/* Left: Weekly Timeline */}
                  <div className="lg:col-span-2 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          Weekly Timeline
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Week: {formatDate(detail.week_start_date)} –{" "}
                          {formatDate(detail.week_end_date)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge
                          status={
                            detail.timesheet_status as Parameters<
                              typeof StatusBadge
                            >[0]["status"]
                          }
                        />
                        {canReject && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive border-destructive hover:bg-destructive/10"
                            onClick={() => setRejectDialog(true)}
                          >
                            Reject
                          </Button>
                        )}
                        {canApprove && (
                          <Button
                            size="sm"
                            onClick={handleApprove}
                            disabled={isApproving}
                          >
                            {isApproving && <Loader2 className="animate-spin" />}
                            Approve
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border overflow-x-auto bg-card">
                      {timeline.length === 0 ? (
                        <div className="text-center py-8 text-sm text-muted-foreground">
                          No entries for this week
                        </div>
                      ) : (
                        <table className="w-full">
                          <thead>
                            <tr className="bg-table-header border-b border-table-border">
                              <th className="text-left p-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Date & Day
                              </th>
                              <th className="text-left p-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Work Comments & Tasks
                              </th>
                              <th className="text-center p-3 text-xs font-medium text-muted-foreground uppercase tracking-wide w-20">
                                Hours
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {dailyBreakdown.map((day, i) => (
                              <tr key={i} className="border-b last:border-b-0">
                                <td className="p-3">
                                  <div className="font-medium text-sm">
                                    {day.day}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {formatDate(day.date)}
                                  </div>
                                </td>
                                <td className="p-3">
                                  {/* A zero-hour day reads as one plain line
                                      giving the reason — holiday, leave, week
                                      off, or nothing submitted. Listing the
                                      0-hour task rows underneath adds noise. */}
                                  {day.hours === 0
                                    ? (() => {
                                        const ctx = dayContextLabel(day.date);
                                        return (
                                          <span
                                            className={`text-sm ${ctx.className}`}
                                          >
                                            {ctx.label}
                                          </span>
                                        );
                                      })()
                                    : (() => {
                                        // Only the tasks actually worked on — a
                                        // 0-hour entry beside a worked one is
                                        // noise. Per-task hours only earn their
                                        // place when there's more than one to
                                        // split between; otherwise the Hours
                                        // column already says it.
                                        const worked = day.tasks.filter(
                                          (t) => t.hours > 0,
                                        );
                                        return worked.map((t, j) => (
                                          <div
                                            key={j}
                                            className="text-sm text-foreground"
                                          >
                                            <span className="font-medium">
                                              {t.project_name}
                                            </span>
                                            {t.task_name && (
                                              <span className="text-muted-foreground">
                                                {" "}
                                                / {t.task_name}
                                              </span>
                                            )}
                                            {worked.length > 1 && (
                                              <span className="text-muted-foreground">
                                                {" "}
                                                · {t.hours}h
                                              </span>
                                            )}
                                            {t.notes && (
                                              <span className="text-muted-foreground">
                                                {" "}
                                                - {t.notes}
                                              </span>
                                            )}
                                          </div>
                                        ));
                                      })()}
                                </td>
                                <td className="p-3 text-center">
                                  <span className="text-sm font-bold text-muted-foreground">
                                    {day.hours}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="bg-table-header border-t-2 border-table-border">
                              <td className="p-3 font-bold text-sm text-foreground">
                                TOTAL WEEKLY HOURS
                              </td>
                              <td className="p-3 text-xs text-muted-foreground">
                                Calculated from{" "}
                                {formatDate(detail.week_start_date)} to{" "}
                                {formatDate(detail.week_end_date)}
                              </td>
                              <td className="p-3 text-center">
                                <span className="text-lg font-bold text-foreground">
                                  {detail.total_hours}h
                                </span>
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      )}
                    </div>
                  </div>

                  {/* Right: Approval History */}
                  <div className="space-y-4">
                    {(detail.approval_history ?? []).length > 0 && (
                      <div className="rounded-xl border bg-card p-4 space-y-3">
                        <h3 className="text-sm font-semibold text-foreground">
                          Approval History
                        </h3>
                        {(detail.approval_history ?? []).map((ar, i) => (
                          <div
                            key={i}
                            className="text-xs border-l-2 pl-3 py-1 border-border space-y-0.5"
                          >
                            <div className="flex items-center gap-1">
                              {ar.action === "approved" ||
                              ar.action === "submitted" ? (
                                <CheckCircle2 className="size-3 text-success shrink-0" />
                              ) : ar.action === "rejected" ? (
                                <XCircle className="size-3 text-destructive shrink-0" />
                              ) : (
                                <Clock className="size-3 text-muted-foreground shrink-0" />
                              )}
                              <span className="font-semibold text-foreground capitalize">
                                {ar.action}
                              </span>
                              <span className="text-muted-foreground">
                                by {ar.approver_name ?? ar.approver_id}
                              </span>
                            </div>
                            <p className="text-muted-foreground capitalize">
                              {ar.approver_role} – {formatDateTime(ar.acted_at)}
                            </p>
                            {ar.comments && (
                              <p className="text-muted-foreground italic">
                                "{ar.comments}"
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Reopen: this employee, the month the sheet is showing. */}
      {canReopen && detail && viewedMonth !== null && viewedYear !== null && (
        <ReopenMonthDialog
          open={reopenDialog}
          onOpenChange={setReopenDialog}
          userId={detail.user_id}
          userName={detail.user_name}
          month={viewedMonth}
          year={viewedYear}
        />
      )}

      {/* Reject Dialog */}
      <Dialog
        open={rejectDialog}
        onOpenChange={(v) => {
          if (!v) {
            setRejectDialog(false);
            setRejectComment("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Timesheet</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Label>
              Reason for rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
              placeholder="Provide reason for rejection..."
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus>Cancel</Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleReject}
              disabled={!rejectComment || isRejecting}
            >
              {isRejecting && <Loader2 className="animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject All Dialog */}
      <Dialog
        open={rejectAllDialog}
        onOpenChange={(v) => {
          if (!v) {
            setRejectAllDialog(false);
            setRejectAllComment("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject {pendingWeekIds.length} Timesheets</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Label>
              Reason for rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={rejectAllComment}
              onChange={(e) => setRejectAllComment(e.target.value)}
              placeholder="Provide reason for rejecting all submitted weeks..."
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus>Cancel</Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleRejectAll}
              disabled={!rejectAllComment || isBulkRejecting}
            >
              {isBulkRejecting && <Loader2 className="animate-spin" />}
              Reject All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default EmployeeTimesheetDetail;
