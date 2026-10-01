import { useState, useMemo, useEffect, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  CheckCheck,
  ListX,
  Search,
  List,
  CalendarDays,
  Clock,
  Filter,
  Download,
  LockOpen,
  FileSpreadsheet,
  FileText,
  Users,
  Eye,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useNavigate,
  useLocation,
  useSearch,
} from "@tanstack/react-router";
import {
  useGetApprovalDashboardQuery,
  useGetTeamTimesheetsQuery,
  useGetTeamTimesheetQuery,
  useApproveTimesheetMutation,
  useBulkApproveTimesheetsMutation,
  useBulkRejectTimesheetsMutation,
  useGetTeamResourcesQuery,
  useGetPastSubmissionCutoffQuery,
} from "@/store/api/timesheetApi";
import type {
  MonthlyTimesheetBucket,
  WeekSummaryItem,
} from "@/store/api/timesheetApi";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";
import EmployeeTimesheetDetail from "./EmployeeTimesheetDetail";
import { toast } from "@/lib/toast";
import { downloadAuthed } from "@/lib/download";
import { getWeekNumberInMonth, monthHasClosedWeeks } from "@/lib/week";
import { ReopenMonthDialog } from "./ReopenMonthDialog";
import { useAuth } from "@/hooks/use-auth";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const MONTHS = [
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

type FilterChip = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

/**
 * Keys are the API's own `status_filter` values, so a chip click is the filter.
 *
 * There is deliberately no `not_submitted` chip yet. If one is added, it must
 * be hidden while `scope === "reporting"` and the filter reset to "all" when
 * switching into that scope — the reporting view lists filed weeks only, so
 * that tab would always come back empty and read as broken. Unfiled weeks are
 * something to chase, and chasing belongs to whoever can act on them.
 */
const filterChips: FilterChip[] = [
  { key: "all", label: "All", icon: List },
  { key: "pending", label: "Pending", icon: Clock },
  { key: "approved", label: "Approved", icon: CheckCircle2 },
  { key: "rejected", label: "Rejected", icon: XCircle },
];

const formatDateISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const formatDateShort = (d: Date) => {
  const months = [
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
  return `${d.getDate()} ${months[d.getMonth()]}`;
};

const formatWeekRange = (start: string, end: string) =>
  `${formatDateShort(new Date(start))} – ${formatDateShort(new Date(end))}`;


const ManagerApproval = () => {
  const now = new Date();
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(20);
  const [activeFilter, setActiveFilter] = useState("all");
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  // Which dataset the page is showing. The switch lives in the Status column
  // header, right-aligned above the row action icons it governs.

  const [scope, setScope] = useState<"own" | "reporting">("own");
  /** The employee-month whose reopen dialog is open, if any. */
  const [reopenTarget, setReopenTarget] = useState<{
    userId: string;
    userName?: string | null;
    month: number;
    year: number;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(
    new Set(),
  );
  const [rejectDialog, setRejectDialog] = useState<string[] | null>(null);
  const [rejectComment, setRejectComment] = useState("");
  const [bulkRejectDialog, setBulkRejectDialog] = useState(false);
  const [bulkRejectComment, setBulkRejectComment] = useState("");

  /**
   * Deep link from the approval emails: ?timesheet=<id> opens that week's
   * detail sheet. The param is consumed once and stripped, so a refresh or a
   * back navigation doesn't reopen it — the same shape the leave module uses
   * with ?request=<id>.
   *
   * An id alone doesn't say which month the week belongs to, so the timesheet
   * is read once and the dashboard's month moved to match. RTK Query shares the
   * cache entry with the sheet's own query, so this costs no extra request.
   * Without it the week tabs would be numbered against the wrong month.
   */
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = useSearch({ strict: false }) as Record<
    string,
    string | undefined
  >;
  const [deepLinkId, setDeepLinkId] = useState<string | null>(null);

  useEffect(() => {
    const id = searchParams?.timesheet;
    if (!id) return;
    setDetailId(id);
    setDeepLinkId(id);
    navigate({ to: location.pathname, search: {}, replace: true });
    // Mount only — the param is read once and removed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: deepLinkedTimesheet } = useGetTeamTimesheetQuery(
    deepLinkId ?? "",
    { skip: !deepLinkId },
  );

  useEffect(() => {
    const weekStart = deepLinkedTimesheet?.week_start_date;
    if (!weekStart) return;
    const d = new Date(weekStart);
    setSelectedMonth(d.getMonth());
    setSelectedYear(d.getFullYear());
    setDeepLinkId(null); // one-shot, so the month picker stays under user control
  }, [deepLinkedTimesheet?.week_start_date]);

  // Same grant that opens this screen — reopening is per employee now, not
  // per project.
  const { isOrgAdmin, timesheetActions } = useAuth();
  const hasReopenGrant = isOrgAdmin || timesheetActions.manage_timesheet;

  /**
   * The org cutoff, which decides whether there is anything to reopen at all.
   *
   * Without it the button showed on unfiled months even with the cutoff turned
   * off — where nothing is closed, so reopening changes nothing. One cached
   * call for the whole table; the per-row check below is pure arithmetic.
   *
   * The backend's `can_reopen` folds this in, but it only exists on the detail
   * responses — reading it per row would be one request per employee-month.
   */
  const { data: cutoff } = useGetPastSubmissionCutoffQuery(undefined, {
    skip: !hasReopenGrant,
  });

  /** Whether this employee-month is closed and has a gap worth reopening. */
  const canReopenBucket = (b: MonthlyTimesheetBucket) =>
    hasReopenGrant &&
    !readOnly &&
    (cutoff?.enabled ?? false) &&
    monthHasClosedWeeks(b.month - 1, b.year, cutoff!.cutoff_day) &&
    b.weeks.some((w) => !w.id);

  const dashParams = { month: selectedMonth + 1, year: selectedYear };

  // Deliberately NOT scoped: the tiles stay on the caller's own approval
  // queue and don't re-fetch when the scope switch moves. They describe what
  // is waiting on YOU, which the reporting-line view never adds to.
  const { data: dashboard, isLoading: isDashLoading } =
    useGetApprovalDashboardQuery(dashParams);
  const { data: timesheetsData, isLoading } = useGetTeamTimesheetsQuery({
    page,
    page_size: pageSize,
    // The chip keys are the API's own values, so the card click IS the filter.
    // This replaced a `timesheet_status: statusFilter` that was always
    // undefined — none of the chips carried one — with the real filtering
    // happening client-side over the current page afterwards.
    status_filter: activeFilter as
      | "all"
      | "pending"
      | "approved"
      | "rejected"
      | "not_submitted",
    scope,
    month: selectedMonth + 1,
    year: selectedYear,
    search: searchQuery || undefined,
  });

  /**
   * Whether this dataset can be acted on, straight from the response.
   *
   * Taken from the payload rather than from `scope === "reporting"` — the two
   * always agree, but a single source can't disagree with itself. Defaults to
   * read-only while the request is in flight, so no approve button exists
   * before the answer arrives.
   */
  const readOnly = timesheetsData?.read_only ?? scope === "reporting";

  const [approveTs, { isLoading: isApproving }] = useApproveTimesheetMutation();
  const [bulkApprove, { isLoading: isBulkApproving }] =
    useBulkApproveTimesheetsMutation();
  const [bulkReject, { isLoading: isBulkRejecting }] =
    useBulkRejectTimesheetsMutation();

  const calFrom = `${selectedYear}-${String(selectedMonth + 1).padStart(2, "0")}-01`;
  const lastDayOfMonth = new Date(selectedYear, selectedMonth + 1, 0).getDate();
  const calTo = `${selectedYear}-${String(selectedMonth + 1).padStart(2, "0")}-${String(lastDayOfMonth).padStart(2, "0")}`;

  const { data: teamResources } = useGetTeamResourcesQuery(
    { from_date: calFrom, to_date: calTo },
    { skip: viewMode !== "calendar" },
  );

  const leavesByDate = useMemo(() => {
    const map = new Map<
      string,
      Array<{ name: string; leave_type_name: string; status: string }>
    >();
    if (!teamResources) return map;
    for (const emp of teamResources) {
      for (const leave of emp.leaves) {
        const start = new Date(leave.start_date);
        const end = new Date(leave.end_date);
        const cur = new Date(start);
        while (cur <= end) {
          const key = cur.toISOString().slice(0, 10);
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({
            name: emp.name,
            leave_type_name: leave.leave_type_name,
            status: leave.status,
          });
          cur.setDate(cur.getDate() + 1);
        }
      }
    }
    return map;
  }, [teamResources]);

  const holidaysByDate = useMemo(() => {
    const map = new Map<
      string,
      Array<{
        id: string;
        name: string;
        classification_name: string;
        classification_color: string;
      }>
    >();
    if (!teamResources) return map;
    const seen = new Set<string>();
    for (const emp of teamResources) {
      for (const h of emp.holidays) {
        if (!seen.has(h.id)) {
          seen.add(h.id);
          if (!map.has(h.date)) map.set(h.date, []);
          map.get(h.date)!.push(h);
        }
      }
    }
    return map;
  }, [teamResources]);

  const timesheets = timesheetsData?.items ?? [];
  const total = timesheetsData?.total ?? 0;

  /**
   * The server filters now, so this is just what came back.
   *
   * It used to re-filter the current page by rollup status, which meant the
   * filter ran AFTER pagination: `total` counted the unfiltered set, the pager
   * offered pages that rendered empty, and a page of twenty could show three
   * rows. `status_filter` does it before the page is taken.
   */
  const displayedTimesheets = timesheets;

  const bucketKey = (b: MonthlyTimesheetBucket) =>
    `${b.user_id}-${b.year}-${b.month}`;

  const getPendingWeekIds = (b: MonthlyTimesheetBucket) =>
    b.weeks
      .filter((w) => ["submitted", "resubmitted"].includes(w.timesheet_status))
      .map((w) => w.id);

  const approvableIds = useMemo(
    () => displayedTimesheets.flatMap(getPendingWeekIds),
    [displayedTimesheets],
  );

  const getChipCount = (key: string) => {
    if (!dashboard) return 0;
    if (key === "all") return dashboard.total;
    const d = dashboard as unknown as Record<string, number>;
    if (key === "pending") return (d.submitted ?? 0) + (d.resubmitted ?? 0);
    if (key === "approved")
      return (d.l1_approved ?? 0) + (d.client_approved ?? 0);
    if (key === "rejected")
      return (d.l1_rejected ?? 0) + (d.client_rejected ?? 0);
    return d[key] ?? 0;
  };

  const toggleSelect = (bucket: MonthlyTimesheetBucket) => {
    const ids = getPendingWeekIds(bucket);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds((prev) =>
      prev.size === approvableIds.length ? new Set() : new Set(approvableIds),
    );
  };

  const handleMonthlyExport = async (
    bucket: MonthlyTimesheetBucket,
    format: "excel" | "pdf",
  ) => {
    const params = new URLSearchParams({
      user_id: bucket.user_id,
      month: String(bucket.month),
      year: String(bucket.year),
    });
    const ext = format === "excel" ? "xlsx" : "pdf";
    const fallback =
      `${bucket.emp_code ?? bucket.user_name ?? "timesheet"}_${bucket.month_label}.${ext}`.replace(
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

  const handleWeekExport = async (
    bucket: MonthlyTimesheetBucket,
    week: WeekSummaryItem,
    format: "excel" | "pdf",
  ) => {
    const ext = format === "excel" ? "xlsx" : "pdf";
    const code = bucket.emp_code ?? bucket.user_name ?? "timesheet";
    const fallback =
      `${code}_${week.week_start_date.slice(0, 10)}_${week.week_end_date.slice(0, 10)}.${ext}`.replace(
        /\s+/g,
        "_",
      );
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}approvals/timesheets/${week.id}/export/${format}`,
        fallback,
      );
    } catch {
      toast.error("Export failed. Please try again.");
    }
  };

  const toggleBucket = (key: string) => {
    setExpandedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleApprove = async (id: string) => {
    try {
      await approveTs({ id, body: {} }).unwrap();
      toast.success("Timesheet approved");
    } catch (err) {
      toast.error(err, "Failed to approve timesheet");
    }
  };

  const handleApproveAll = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await bulkApprove({ timesheet_ids: ids }).unwrap();
      toast.success(
        ids.length === 1
          ? "Timesheet approved"
          : `${ids.length} timesheets approved`,
      );
    } catch (err) {
      toast.error(err, "Failed to approve timesheets");
    }
  };

  const handleReject = async () => {
    if (!rejectDialog || rejectDialog.length === 0 || !rejectComment) return;
    try {
      await bulkReject({
        timesheet_ids: rejectDialog,
        comments: rejectComment,
      }).unwrap();
      toast.success(
        rejectDialog.length === 1
          ? "Timesheet rejected"
          : `${rejectDialog.length} timesheets rejected`,
      );
      // Only clear the dialog on success — a failure keeps the typed comment
      setRejectDialog(null);
      setRejectComment("");
    } catch (err) {
      toast.error(err, "Failed to reject timesheet");
    }
  };

  const handleBulkApprove = async () => {
    const count = selectedIds.size;
    try {
      await bulkApprove({ timesheet_ids: Array.from(selectedIds) }).unwrap();
      toast.success(
        count === 1 ? "Timesheet approved" : `${count} timesheets approved`,
      );
      setSelectedIds(new Set());
    } catch (err) {
      toast.error(err, "Failed to approve timesheets");
    }
  };

  const handleBulkReject = async () => {
    if (!bulkRejectComment) return;
    const count = selectedIds.size;
    try {
      await bulkReject({
        timesheet_ids: Array.from(selectedIds),
        comments: bulkRejectComment,
      }).unwrap();
      toast.success(
        count === 1 ? "Timesheet rejected" : `${count} timesheets rejected`,
      );
      setSelectedIds(new Set());
      setBulkRejectDialog(false);
      setBulkRejectComment("");
    } catch (err) {
      toast.error(err, "Failed to reject timesheets");
    }
  };

  const prevMonth = () => {
    if (selectedMonth === 0) {
      setSelectedMonth(11);
      setSelectedYear((y) => y - 1);
    } else setSelectedMonth((m) => m - 1);
    setPage(1);
  };

  const nextMonth = () => {
    if (selectedMonth === 11) {
      setSelectedMonth(0);
      setSelectedYear((y) => y + 1);
    } else setSelectedMonth((m) => m + 1);
    setPage(1);
  };

  const calendarDays = useMemo(() => {
    const firstDay = new Date(selectedYear, selectedMonth, 1);
    const lastDay = new Date(selectedYear, selectedMonth + 1, 0);
    const startDow = firstDay.getDay();
    const days: (number | null)[] = [];
    for (let i = 0; i < startDow; i++) days.push(null);
    for (let d = 1; d <= lastDay.getDate(); d++) days.push(d);
    while (days.length % 7 !== 0) days.push(null);
    return days;
  }, [selectedMonth, selectedYear]);

  const weeks = useMemo(() => {
    const rows: (number | null)[][] = [];
    for (let i = 0; i < calendarDays.length; i += 7) {
      rows.push(calendarDays.slice(i, i + 7));
    }
    return rows;
  }, [calendarDays]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={
          scope === "reporting"
            ? "View timesheets across your reporting line"
            : "Review and approve employee timesheets"
        }
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {filterChips.map((chip) => {
          const count = getChipCount(chip.key);
          const isActive = activeFilter === chip.key;
          const Icon = chip.icon;
          return (
            <button
              key={chip.key}
              onClick={() => {
                setActiveFilter(chip.key);
                setPage(1);
                setSelectedIds(new Set());
              }}
              className={`flex items-center justify-between rounded-xl border px-5 py-4 text-left transition-colors cursor-pointer ${
                isActive
                  ? "bg-primary/5 border-primary/20"
                  : "bg-card hover:bg-muted/50"
              }`}
            >
              <div>
                <p className="text-xs text-muted-foreground font-medium">
                  {chip.label}
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {isDashLoading ? "-" : count}
                </p>
              </div>
              <Icon className="size-8 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
      </div>

      {/* Controls Row: Nav + Search + View Toggle */}
      <div className="flex items-center justify-between gap-4 flex-wrap rounded-xl border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={prevMonth}
            >
              <ChevronLeft />
            </Button>
            <Select
              value={String(selectedMonth)}
              onValueChange={(v) => {
                setSelectedMonth(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-32 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(selectedYear)}
              onValueChange={(v) => {
                setSelectedYear(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-24 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(
                  { length: 5 },
                  (_, i) => now.getFullYear() - 2 + i,
                ).map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={nextMonth}
            >
              <ChevronRight />
            </Button>
          </>
        </div>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by employee name"
            className="pl-9 h-9"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="flex items-center rounded-xl border overflow-x-auto">
          <Button
            variant="ghost"
            size="sm"
            className={`rounded-none gap-1.5 h-8 px-3 ${viewMode === "list" ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground" : ""}`}
            onClick={() => setViewMode("list")}
          >
            <List className="size-4" /> Timesheets
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`rounded-none gap-1.5 h-8 px-3 ${viewMode === "calendar" ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground" : ""}`}
            onClick={() => setViewMode("calendar")}
          >
            <CalendarDays className="size-4" /> Leave & Holiday Calendar
          </Button>
        </div>
      </div>

      {/* Bulk Actions Bar. Gated on read_only as well as the selection:
          a bulk approve is the single most damaging control to leave
          reachable here. */}
      {!readOnly && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-muted rounded-xl border">
          <Checkbox checked={true} />
          <span className="text-sm font-medium text-foreground">
            {selectedIds.size} timesheets selected
          </span>
          <span className="text-xs text-muted-foreground">
            Perform bulk actions on the selected records
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => setBulkRejectDialog(true)}
            >
              <XCircle /> Reject Selected
            </Button>
            <Button
              size="sm"
              onClick={handleBulkApprove}
              disabled={isBulkApproving}
            >
              {isBulkApproving && <Loader2 className="animate-spin" />}
              <CheckCircle2 /> Approve Selected
            </Button>
          </div>
        </div>
      )}

      {/* List View */}
      {viewMode === "list" && (
        <div className="rounded-xl border overflow-x-auto bg-card">
          {isLoading ? (
            <PageLoader message="Loading timesheets…" />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="w-10">
                      {/* Selection only exists to feed the bulk bar, so it goes
                          when the bulk bar does. */}
                      {!readOnly && (
                        <Checkbox
                          checked={
                            approvableIds.length > 0 &&
                            selectedIds.size === approvableIds.length
                          }
                          onCheckedChange={toggleAll}
                        />
                      )}
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Emp Code
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Period
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Total Hrs
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Weeks
                    </TableHead>
                    {/* Status shares its cell with the row actions, which
                        sit at its right edge — so the scope switch goes here,
                        directly above the controls it governs. */}
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      <div className="flex items-center justify-between gap-3">
                        <span>Status</span>
                        <div className="flex items-center gap-2 normal-case">
                          <div className="flex shrink-0 items-center overflow-hidden rounded-lg border bg-card">
                            <button
                              type="button"
                              onClick={() => {
                                setScope("own");
                                setPage(1);
                                setSelectedIds(new Set());
                              }}
                              aria-pressed={scope === "own"}
                              className={`flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors ${scope === "own" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                            >
                              <Users className="size-3.5" /> My Team
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setScope("reporting");
                                setPage(1);
                                // Anything ticked under My Team can't be acted
                                // on here, and a carried-over selection would
                                // resurface on the way back.
                                setSelectedIds(new Set());
                              }}
                              aria-pressed={scope === "reporting"}
                              className={`flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors ${scope === "reporting" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                            >
                              <Eye className="size-3.5" /> Reporting Line
                            </button>
                          </div>
                        </div>
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedTimesheets.map((bucket) => {
                    const key = bucketKey(bucket);
                    const isExpanded = expandedBuckets.has(key);
                    const pendingIds = getPendingWeekIds(bucket);
                    const bucketSelected =
                      pendingIds.length > 0 &&
                      pendingIds.every((id) => selectedIds.has(id));
                    return (
                      <Fragment key={key}>
                        {/* Bucket (employee-month) row */}
                        <TableRow
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => toggleBucket(key)}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            {!readOnly && pendingIds.length > 0 && (
                              <Checkbox
                                checked={bucketSelected}
                                onCheckedChange={() => toggleSelect(bucket)}
                              />
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-1.5">
                              <ChevronRight
                                className={`size-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                              />
                              {bucket.user_name ?? bucket.user_id}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {bucket.emp_code ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {MONTHS[bucket.month - 1]} {bucket.year}
                          </TableCell>
                          <TableCell className="text-sm">
                            {bucket.total_hours}h
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {bucket.week_count}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-between gap-2">
                              <StatusBadge
                                status={
                                  bucket.timesheet_status as Parameters<
                                    typeof StatusBadge
                                  >[0]["status"]
                                }
                              />
                              <div
                                className="flex items-center gap-1.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {/* Month-row approve-all / reject-all. Export
                                    sits in the same cell and stays — reading is
                                    the point of the read-only view.
 */}
                                {!readOnly && pendingIds.length > 0 && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 text-success hover:text-success hover:bg-success/10"
                                      onClick={() =>
                                        handleApproveAll(pendingIds)
                                      }
                                      disabled={isBulkApproving}
                                      title={`Approve all ${pendingIds.length} pending week(s)`}
                                    >
                                      <CheckCheck className="size-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={() =>
                                        setRejectDialog(pendingIds)
                                      }
                                      title={`Reject all ${pendingIds.length} pending week(s)`}
                                    >
                                      <ListX className="size-4" />
                                    </Button>
                                  </>
                                )}
                                {/* A grant covers the whole employee-month,
                                    so the control belongs on the month row. */}
                                {canReopenBucket(bucket) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 shrink-0"
                                      title={`Reopen ${MONTHS[bucket.month - 1]} ${bucket.year} for ${bucket.user_name ?? "this employee"}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setReopenTarget({
                                          userId: bucket.user_id,
                                          userName: bucket.user_name,
                                          // Buckets are 1-12; the dialog works
                                          // in JS months.
                                          month: bucket.month - 1,
                                          year: bucket.year,
                                        });
                                      }}
                                    >
                                      <LockOpen className="size-4 text-muted-foreground" />
                                    </Button>
                                  )}
                                {!isExpanded && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-7 shrink-0"
                                        title="Export month"
                                      >
                                        <Download className="size-4 text-muted-foreground" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onClick={() =>
                                          handleMonthlyExport(bucket, "excel")
                                        }
                                      >
                                        <FileSpreadsheet className="size-4 mr-2" />{" "}
                                        Export Excel
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          handleMonthlyExport(bucket, "pdf")
                                        }
                                      >
                                        <FileText /> Export PDF
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>

                        {/* Week sub-rows */}
                        {isExpanded &&
                          bucket.weeks.map((week: WeekSummaryItem) => {
                            const weekPending = [
                              "submitted",
                              "resubmitted",
                            ].includes(week.timesheet_status);
                            const weekRejectable =
                              weekPending ||
                              week.timesheet_status === "l1_approved";
                            // A `not_submitted` week is a gap, not a record:
                            // it has no timesheet document, so `id` is null and
                            // there's nothing to open. Clicking one would fire
                            // the detail query for null.
                            const openable = Boolean(week.id);
                            return (
                              <TableRow
                                // week_start_date, not id — a month can hold
                                // several gaps and they'd all key on null.
                                key={week.week_start_date}
                                className={`bg-muted/20 ${openable ? "cursor-pointer hover:bg-muted/40" : ""}`}
                                onClick={
                                  openable
                                    ? () => setDetailId(week.id)
                                    : undefined
                                }
                              >
                                <TableCell />
                                <TableCell className="pl-8 text-sm text-muted-foreground">
                                  Week{" "}
                                  {getWeekNumberInMonth(week.week_start_date)}
                                </TableCell>
                                <TableCell />
                                <TableCell className="text-sm text-muted-foreground">
                                  {formatWeekRange(
                                    week.week_start_date,
                                    week.week_end_date,
                                  )}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {week.total_hours}h
                                </TableCell>
                                <TableCell />
                                <TableCell>
                                  <div
                                    className="flex items-center justify-between gap-2"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <StatusBadge
                                      status={
                                        week.timesheet_status as Parameters<
                                          typeof StatusBadge
                                        >[0]["status"]
                                      }
                                    />
                                    <div className="flex items-center gap-1">
                                      {!readOnly && weekPending && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="size-7 text-success hover:text-success hover:bg-success/10"
                                          onClick={() => handleApprove(week.id)}
                                          disabled={isApproving}
                                          title="Approve"
                                        >
                                          <CheckCircle2 />
                                        </Button>
                                      )}
                                      {/* Also on l1_approved — a manager can
                                          send back their own approval. Not on
                                          client_approved: reversing a client
                                          sign-off is TSM-010. */}
                                      {!readOnly && weekRejectable && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="size-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                          onClick={() =>
                                            setRejectDialog([week.id])
                                          }
                                          title="Reject"
                                        >
                                          <XCircle />
                                        </Button>
                                      )}
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7 shrink-0"
                                            title="Export this week"
                                          >
                                            <Download className="size-4 text-muted-foreground" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                          <DropdownMenuItem
                                            onClick={() =>
                                              handleWeekExport(
                                                bucket,
                                                week,
                                                "excel",
                                              )
                                            }
                                          >
                                            <FileSpreadsheet className="size-4 mr-2" />{" "}
                                            Export Excel
                                          </DropdownMenuItem>
                                          <DropdownMenuItem
                                            onClick={() =>
                                              handleWeekExport(
                                                bucket,
                                                week,
                                                "pdf",
                                              )
                                            }
                                          >
                                            <FileText /> Export PDF
                                          </DropdownMenuItem>
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                  {displayedTimesheets.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      {/* colSpan 7 — the header's cell count. */}
                      <TableCell colSpan={7} className="p-0">
                        <EmptyState
                          icon={Filter}
                          title={
                            scope === "reporting"
                              ? "No timesheets in your reporting line"
                              : "No timesheets found"
                          }
                          description={
                            activeFilter === "all"
                              ? `No timesheets for ${MONTHS[selectedMonth]} ${selectedYear}.`
                              : `Nothing ${activeFilter === "not_submitted" ? "unfiled" : activeFilter} for ${MONTHS[selectedMonth]} ${selectedYear}.`
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {displayedTimesheets.length > 0 && (
              <div className="flex items-center justify-end px-4 py-3 text-sm text-muted-foreground border-t">
                <TablePagination
                  currentPage={page}
                  totalPages={Math.max(1, Math.ceil(total / pageSize))}
                  startIndex={(page - 1) * pageSize + 1}
                  endIndex={Math.min(page * pageSize, total)}
                  total={total}
                  pageSize={pageSize}
                  onPageChange={(p) => {
                    setPage(p);
                    setSelectedIds(new Set());
                  }}
                  onPageSizeChange={(s) => {
                    setPageSize(s);
                    setPage(1);
                    setSelectedIds(new Set());
                  }}
                />
              </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Calendar View */}
      {viewMode === "calendar" && (
        <div className="rounded-xl border overflow-x-auto bg-card">
          {isLoading ? (
            <PageLoader message="Loading calendar…" />
          ) : (
            <>
              <table className="w-full table-fixed">
                <thead>
                  <tr className="bg-table-header">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                      (d) => (
                        <th
                          key={d}
                          className="px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide border-b border-table-border text-center"
                        >
                          {d}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((week, wi) => {
                    const today = new Date();
                    const isToday = (day: number | null) =>
                      day !== null &&
                      today.getFullYear() === selectedYear &&
                      today.getMonth() === selectedMonth &&
                      today.getDate() === day;

                    return (
                      <tr key={wi} className="border-b last:border-b-0">
                        {week.map((day, di) => {
                          const dateKey =
                            day !== null
                              ? `${selectedYear}-${String(selectedMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                              : null;
                          const dayHolidays = dateKey
                            ? (holidaysByDate.get(dateKey) ?? [])
                            : [];
                          const dayLeaves = dateKey
                            ? (leavesByDate.get(dateKey) ?? [])
                            : [];
                          const hasBg =
                            dayHolidays.length > 0 || dayLeaves.length > 0;

                          return (
                            <td
                              key={di}
                              className={`px-2 py-2 align-top border-r last:border-r-0 min-h-[90px] ${
                                day === null ? "bg-muted" : ""
                              } ${isToday(day) ? "bg-primary/5" : ""}`}
                              style={
                                !isToday(day) && hasBg && dayHolidays.length > 0
                                  ? {
                                      backgroundColor:
                                        dayHolidays[0].classification_color +
                                        "12",
                                    }
                                  : !isToday(day) && dayLeaves.length > 0
                                    ? {
                                        backgroundColor:
                                          "oklch(var(--warning) / 0.07)",
                                      }
                                    : undefined
                              }
                            >
                              {day !== null && (
                                <div className="space-y-1">
                                  <span
                                    className={`text-xs font-medium ${isToday(day) ? "text-primary font-bold" : "text-muted-foreground"}`}
                                  >
                                    {day}
                                  </span>

                                  {/* Holiday bars */}
                                  {dayHolidays.map((h) => (
                                    <div
                                      key={h.id}
                                      className="px-1.5 py-0.5 rounded text-[10px] leading-tight truncate font-medium"
                                      style={{
                                        backgroundColor:
                                          h.classification_color + "22",
                                        color: h.classification_color,
                                      }}
                                    >
                                      {h.name}
                                    </div>
                                  ))}

                                  {/* Employee leave entries */}
                                  {dayLeaves.slice(0, 3).map((l, i) => (
                                    <div
                                      key={i}
                                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-warning/10 text-warning truncate"
                                      title={`${l.name} · ${l.leave_type_name}`}
                                    >
                                      <span className="size-1.5 rounded-full bg-warning shrink-0" />
                                      <span className="font-medium truncate">
                                        {l.name}
                                      </span>
                                    </div>
                                  ))}
                                  {dayLeaves.length > 3 && (
                                    <div className="text-[10px] text-muted-foreground px-1.5">
                                      +{dayLeaves.length - 3} more
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Legend */}
              <div className="flex items-center gap-4 flex-wrap px-4 py-3 border-t text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-warning" />
                  On Leave
                </div>
                {(() => {
                  const classifications = Array.from(
                    new Map(
                      Array.from(holidaysByDate.values())
                        .flat()
                        .map((h) => [
                          h.classification_name,
                          h.classification_color,
                        ]),
                    ).entries(),
                  );
                  if (classifications.length === 0) {
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="size-2.5 rounded-sm bg-info/20 border border-info/40" />
                        Holiday
                      </div>
                    );
                  }
                  return classifications.map(([name, color]) => (
                    <div key={name} className="flex items-center gap-1.5">
                      <span
                        className="size-2.5 rounded-sm"
                        style={{
                          backgroundColor: color + "44",
                          border: `1px solid ${color}66`,
                        }}
                      />
                      {name}
                    </div>
                  ));
                })()}
              </div>
            </>
          )}
        </div>
      )}

      {/* Reject Dialog (single week or all pending weeks) */}
      <Dialog
        open={!!rejectDialog}
        onOpenChange={(v) => {
          if (!v) {
            setRejectDialog(null);
            setRejectComment("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {(rejectDialog?.length ?? 0) > 1
                ? `Reject ${rejectDialog?.length} Timesheets`
                : "Reject Timesheet"}
            </DialogTitle>
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
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleReject}
              disabled={!rejectComment || isBulkRejecting}
            >
              {isBulkRejecting && <Loader2 className="animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Reject Dialog */}
      <Dialog
        open={bulkRejectDialog}
        onOpenChange={() => {
          setBulkRejectDialog(false);
          setBulkRejectComment("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject {selectedIds.size} Timesheets</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Label>
              Reason for rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={bulkRejectComment}
              onChange={(e) => setBulkRejectComment(e.target.value)}
              placeholder="Provide reason..."
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleBulkReject}
              disabled={!bulkRejectComment || isBulkRejecting}
            >
              {isBulkRejecting && <Loader2 className="animate-spin" />}
              Reject All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {reopenTarget && (
        <ReopenMonthDialog
          open
          onOpenChange={(v) => !v && setReopenTarget(null)}
          userId={reopenTarget.userId}
          userName={reopenTarget.userName}
          month={reopenTarget.month}
          year={reopenTarget.year}
        />
      )}

      <EmployeeTimesheetDetail
        timesheetId={detailId}
        open={!!detailId}
        // Straight from the list's read_only, so a week opened from the
        // reporting view can't be actioned in the sheet either.
        readOnly={readOnly}
        // Anchor the week numbering and the month scope to the dashboard's
        // selection — a week spanning a month boundary belongs to the month
        // being viewed, not to whichever month its Monday falls in.
        month={selectedMonth}
        year={selectedYear}
        onOpenChange={(v) => {
          if (!v) setDetailId(null);
        }}
      />
    </div>
  );
};

export default ManagerApproval;
