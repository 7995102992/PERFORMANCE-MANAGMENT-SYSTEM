import { useState, useMemo, Fragment } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { Label } from "@/components/ui/label";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  CheckCheck,
  ListX,
  Search,
  Download,
  UserCircle,
  AlertTriangle,
  Clock,
  LayoutDashboard,
  History,
  FileText,
  FileSpreadsheet,
  ChevronRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useGetClientDashboardQuery,
  useGetClientTimesheetsQuery,
  useClientApproveTimesheetMutation,
  useClientBulkApproveMutation,
  useClientBulkRejectMutation,
  useLazyExportClientReviewExcelQuery,
  useGetClientActivityHistoryQuery,
  useLazyExportActivityHistoryExcelQuery,
  useLazyExportActivityFullReportQuery,
} from "@/store/api/timesheetApi";
import type {
  ClientMonthlyBucket,
  ClientWeekSummaryItem,
} from "@/store/api/timesheetApi";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";
import ClientTimesheetDetail from "./ClientTimesheetDetail";
import { downloadAuthed } from "@/lib/download";
import { getWeekNumberInMonth } from "@/lib/week";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const tsStatusVariant = (status: string, clientApprovalRequired?: boolean) => {
  if (status === "l1_approved" && clientApprovalRequired === false)
    return "l1_approved";
  const map: Record<
    string,
    "pending_approval" | "client_approved" | "client_rejected"
  > = {
    l1_approved: "pending_approval",
    client_approved: "client_approved",
    client_rejected: "client_rejected",
  };
  return map[status] ?? "pending";
};

const formatDate = (d: string) => formatDateIST(d);

const formatDateTime = (d: string | null) => (d ? formatDateTimeIST(d) : "-");

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



// A client week is actionable when L1-approved AND client approval is required
const isWeekPending = (w: ClientWeekSummaryItem) =>
  w.timesheet_status === "l1_approved" && w.client_approval_required;

const ClientReviewDashboard = () => {
  const [activeTab, setActiveTab] = useState<"dashboard" | "activity">(
    "dashboard",
  );

  // Dashboard tab state
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailWeeks, setDetailWeeks] = useState<ClientWeekSummaryItem[]>([]);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [weekStart, setWeekStart] = useState("");
  const [weekEnd, setWeekEnd] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(
    new Set(),
  );
  const [rejectDialog, setRejectDialog] = useState<string[] | null>(null);
  const [rejectComment, setRejectComment] = useState("");
  const [bulkRejectDialog, setBulkRejectDialog] = useState(false);
  const [bulkRejectComment, setBulkRejectComment] = useState("");

  // Activity History tab state
  const [actPage, setActPage] = useState(1);
  const [actPageSize, setActPageSize] = useState(20);
  const [actSearch, setActSearch] = useState("");
  const [actStartDate, setActStartDate] = useState("");
  const [actEndDate, setActEndDate] = useState("");
  const [actorFilter, setActorFilter] = useState("all");

  const { data: dashboard } = useGetClientDashboardQuery();
  const { data: timesheetsData, isLoading } = useGetClientTimesheetsQuery({
    page,
    page_size: pageSize,
    timesheet_status: statusFilter !== "all" ? statusFilter : undefined,
    search: searchQuery || undefined,
    week_start: weekStart || undefined,
    week_end: weekEnd || undefined,
  });

  const { data: actData, isLoading: isActLoading } =
    useGetClientActivityHistoryQuery({
      page: actPage,
      page_size: actPageSize,
      search: actSearch || undefined,
      start_date: actStartDate || undefined,
      end_date: actEndDate || undefined,
      actor: actorFilter !== "all" ? actorFilter : undefined,
    });

  const [approveTs, { isLoading: isApproving }] =
    useClientApproveTimesheetMutation();
  const [bulkApprove, { isLoading: isBulkApproving }] =
    useClientBulkApproveMutation();
  const [bulkReject, { isLoading: isBulkRejecting }] =
    useClientBulkRejectMutation();
  const [triggerExport, { isFetching: isExporting }] =
    useLazyExportClientReviewExcelQuery();
  const [triggerActExport, { isFetching: isActExporting }] =
    useLazyExportActivityHistoryExcelQuery();
  const [triggerFullReport, { isFetching: isFullReporting }] =
    useLazyExportActivityFullReportQuery();

  const buckets = timesheetsData?.items ?? [];
  const total = timesheetsData?.total ?? 0;
  const actItems = actData?.items ?? [];
  const actSummary = actData?.summary;
  const actTotal = actData?.total ?? 0;

  const bucketKey = (b: ClientMonthlyBucket) =>
    `${b.user_id}-${b.year}-${b.month}`;
  const getPendingWeekIds = (b: ClientMonthlyBucket) =>
    b.weeks.filter(isWeekPending).map((w) => w.id);

  const approvableIds = useMemo(
    () => buckets.flatMap(getPendingWeekIds),
    [buckets],
  );

  // Map selected week ids back to display rows for the bulk reject dialog
  const selectedWeeks = useMemo(() => {
    const rows: {
      id: string;
      name: string;
      emp_code: string | null;
      hours: number;
      range: string;
    }[] = [];
    for (const b of buckets) {
      for (const w of b.weeks) {
        if (selectedIds.has(w.id)) {
          rows.push({
            id: w.id,
            name: b.user_name ?? b.user_id,
            emp_code: b.emp_code,
            hours: w.total_hours,
            range: formatWeekRange(w.week_start_date, w.week_end_date),
          });
        }
      }
    }
    return rows;
  }, [buckets, selectedIds]);
  const selectedTotalHours = selectedWeeks.reduce((sum, w) => sum + w.hours, 0);

  const uniqueActors = [...new Set(actItems.map((i) => i.approver_id))];

  void formatDate;

  const toggleBucketSelect = (bucket: ClientMonthlyBucket) => {
    const ids = getPendingWeekIds(bucket);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
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

  const toggleBucket = (key: string) => {
    setExpandedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleMonthlyExport = async (
    bucket: ClientMonthlyBucket,
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
        `${TIMESHEET_BASE_URL}client-portal/timesheets/monthly/export/${format}?${params.toString()}`,
        fallback,
      );
    } catch {
      toast.error("Export failed. Please try again.");
    }
  };

  const handleWeekExport = async (
    bucket: ClientMonthlyBucket,
    week: ClientWeekSummaryItem,
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
        `${TIMESHEET_BASE_URL}client-portal/timesheets/${week.id}/export/${format}`,
        fallback,
      );
    } catch {
      toast.error("Export failed. Please try again.");
    }
  };

  const extractErrorMsg = (err: unknown, fallback: string) => {
    const e = err as {
      data?: { detail?: string; code?: string };
      status?: number;
    };
    return e?.data?.detail ?? fallback;
  };

  const handleApprove = async (id: string) => {
    try {
      await approveTs({ id, body: {} }).unwrap();
    } catch (err) {
      toast.error(extractErrorMsg(err, "Failed to approve timesheet"));
    }
  };

  const handleApproveAll = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await bulkApprove({ timesheet_ids: ids }).unwrap();
    } catch (err) {
      toast.error(extractErrorMsg(err, "Failed to approve timesheets"));
    }
  };

  const handleReject = async () => {
    if (!rejectDialog || rejectDialog.length === 0 || !rejectComment) return;
    try {
      await bulkReject({
        timesheet_ids: rejectDialog,
        comments: rejectComment,
      }).unwrap();
      setRejectDialog(null);
      setRejectComment("");
    } catch (err) {
      toast.error(extractErrorMsg(err, "Failed to reject timesheet"));
    }
  };

  const handleBulkApprove = async () => {
    try {
      await bulkApprove({ timesheet_ids: Array.from(selectedIds) }).unwrap();
      setSelectedIds(new Set());
    } catch (err) {
      toast.error(extractErrorMsg(err, "Failed to approve timesheets"));
    }
  };

  const handleBulkReject = async () => {
    if (!bulkRejectComment) return;
    try {
      await bulkReject({
        timesheet_ids: Array.from(selectedIds),
        comments: bulkRejectComment,
      }).unwrap();
      setSelectedIds(new Set());
      setBulkRejectDialog(false);
      setBulkRejectComment("");
    } catch (err) {
      toast.error(extractErrorMsg(err, "Failed to reject timesheets"));
    }
  };

  const handleExport = async () => {
    try {
      const result = await triggerExport({
        timesheet_status: statusFilter !== "all" ? statusFilter : undefined,
        search: searchQuery || undefined,
        week_start: weekStart || undefined,
        week_end: weekEnd || undefined,
      }).unwrap();
      const url = URL.createObjectURL(result);
      const a = document.createElement("a");
      a.href = url;
      a.download = "client_review_export.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err, "Export failed. Please try again.");
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleActExport = async () => {
    try {
      const result = await triggerActExport({
        search: actSearch || undefined,
        start_date: actStartDate || undefined,
        end_date: actEndDate || undefined,
        actor: actorFilter !== "all" ? actorFilter : undefined,
      }).unwrap();
      downloadBlob(result, "activity_history_export.xlsx");
    } catch (err) {
      toast.error(err, "Export failed. Please try again.");
    }
  };

  const handleFullReport = async () => {
    try {
      const result = await triggerFullReport().unwrap();
      downloadBlob(result, "activity_full_report.xlsx");
    } catch (err) {
      toast.error(err, "Report download failed. Please try again.");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Timesheet Review"
        subtitle="Manage and approve employee billable hours."
        action={
          activeTab === "dashboard" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={isExporting}
            >
              {isExporting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              Export Data
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleActExport}
                disabled={isActExporting}
              >
                {isActExporting ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                Export
              </Button>
              <Button
                size="sm"
                onClick={handleFullReport}
                disabled={isFullReporting}
              >
                {isFullReporting ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FileText />
                )}
                Full Report
              </Button>
            </div>
          )
        }
      />

      {/* Tabs */}
      <div className="flex border-b">
        {[
          {
            key: "dashboard" as const,
            label: "Dashboard",
            icon: <LayoutDashboard className="size-4" />,
          },
          {
            key: "activity" as const,
            label: "Activity History",
            icon: <History className="size-4" />,
          },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Dashboard Tab ── */}
      {activeTab === "dashboard" && (
        <>
          {/* Summary Cards */}
          {dashboard && (
            <div className="grid grid-cols-3 gap-4">
              {[
                {
                  icon: Clock,
                  label: "Total",
                  value: dashboard.total,
                },
                {
                  icon: Clock,
                  label: "Pending Review",
                  value: dashboard.pending,
                },
                {
                  icon: CheckCircle2,
                  label: "Approved",
                  value: dashboard.approved,
                },
              ].map(({ icon: Icon, label, value }) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-xl border bg-card px-5 py-4"
                >
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">
                      {label}
                    </p>
                    <p className="text-2xl font-bold text-foreground">
                      {value}
                    </p>
                  </div>
                  <Icon className="size-8 shrink-0 text-muted-foreground" />
                </div>
              ))}
            </div>
          )}

          {/* Filters */}
          <div className="flex items-center gap-4 flex-wrap rounded-xl border bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Review Week</span>
              <Input
                type="date"
                className="w-40 h-8"
                value={weekStart}
                onChange={(e) => {
                  setWeekStart(e.target.value);
                  setPage(1);
                }}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                className="w-40 h-8"
                value={weekEnd}
                onChange={(e) => {
                  setWeekEnd(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="l1_approved">Pending</SelectItem>
                <SelectItem value="client_approved">Approved</SelectItem>
                <SelectItem value="client_rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search employees or projects..."
                className="pl-9 h-8"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>

          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
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

          {/* Table */}
          {isLoading ? (
            <PageLoader message="Loading timesheets…" />
          ) : buckets.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No timesheets found"
              description="Timesheets pending client review will appear here."
            />
          ) : (
            <div className="rounded-xl border overflow-x-auto bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={
                          approvableIds.length > 0 &&
                          selectedIds.size === approvableIds.length
                        }
                        onCheckedChange={toggleAll}
                      />
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Period
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                      Total Hours
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Weeks
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buckets.map((bucket) => {
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
                            {pendingIds.length > 0 && (
                              <Checkbox
                                checked={bucketSelected}
                                onCheckedChange={() =>
                                  toggleBucketSelect(bucket)
                                }
                              />
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-1.5">
                              <ChevronRight
                                className={`size-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                              />
                              <div>
                                <div className="text-sm">
                                  {bucket.user_name ?? bucket.user_id}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {bucket.emp_code ?? bucket.user_id}
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {MONTHS[bucket.month - 1]} {bucket.year}
                          </TableCell>
                          <TableCell className="text-center font-medium">
                            {bucket.total_hours} hrs
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {bucket.week_count}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-between gap-2">
                              <StatusBadge
                                status={
                                  tsStatusVariant(
                                    bucket.timesheet_status,
                                    // Same second argument the week rows pass.
                                    // Without it an l1_approved month always
                                    // read "Pending Approval" while its weeks
                                    // read "L1 Approved" — the month is only
                                    // waiting on the client when it actually
                                    // has a week the client can act on, which
                                    // is what pendingIds already means.
                                    pendingIds.length > 0,
                                  ) as Parameters<
                                    typeof StatusBadge
                                  >[0]["status"]
                                }
                              />
                              <div
                                className="flex items-center gap-1.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {pendingIds.length > 0 && (
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
                          bucket.weeks.map((week) => {
                            const weekPending = isWeekPending(week);
                            return (
                              <TableRow
                                key={week.id}
                                className="bg-muted/20 cursor-pointer hover:bg-muted/40"
                                onClick={() => {
                                  setDetailId(week.id);
                                  setDetailWeeks(bucket.weeks);
                                }}
                              >
                                <TableCell />
                                <TableCell className="pl-8 text-sm text-muted-foreground">
                                  Week{" "}
                                  {getWeekNumberInMonth(week.week_start_date)}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {formatWeekRange(
                                    week.week_start_date,
                                    week.week_end_date,
                                  )}
                                </TableCell>
                                <TableCell className="text-center text-sm">
                                  {week.total_hours} hrs
                                </TableCell>
                                <TableCell />
                                <TableCell>
                                  <div
                                    className="flex items-center justify-between gap-2"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <StatusBadge
                                      status={
                                        tsStatusVariant(
                                          week.timesheet_status,
                                          week.client_approval_required,
                                        ) as Parameters<
                                          typeof StatusBadge
                                        >[0]["status"]
                                      }
                                    />
                                    <div className="flex items-center gap-1">
                                      {weekPending && (
                                        <>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7 text-success hover:text-success hover:bg-success/10"
                                            onClick={() =>
                                              handleApprove(week.id)
                                            }
                                            disabled={isApproving}
                                            title="Approve"
                                          >
                                            <CheckCircle2 />
                                          </Button>
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
                                        </>
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
                </TableBody>
              </Table>
              <TablePagination
                currentPage={page}
                totalPages={Math.ceil(total / pageSize)}
                startIndex={total === 0 ? 0 : (page - 1) * pageSize + 1}
                endIndex={Math.min(page * pageSize, total)}
                total={total}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setPage(1);
                }}
              />
            </div>
          )}
        </>
      )}

      {/* ── Activity History Tab ── */}
      {activeTab === "activity" && (
        <>
          {/* Summary Cards */}
          {actSummary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                {
                  icon: Clock,
                  label: "Total Reviews",
                  value: actSummary.total_reviews.toLocaleString(),
                },
                {
                  icon: CheckCircle2,
                  label: "Approved (MTD)",
                  value: actSummary.approved_mtd.toLocaleString(),
                },
                {
                  icon: XCircle,
                  label: "Rejected (MTD)",
                  value: actSummary.rejected_mtd.toLocaleString(),
                },
                {
                  icon: UserCircle,
                  label: "Avg. Decision Time",
                  value: `${actSummary.avg_decision_time_hours}h`,
                },
              ].map(({ icon: Icon, label, value }) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-xl border bg-card px-5 py-4"
                >
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">
                      {label}
                    </p>
                    <p className="text-2xl font-bold text-foreground">
                      {value}
                    </p>
                  </div>
                  <Icon className="size-8 shrink-0 text-muted-foreground" />
                </div>
              ))}
            </div>
          )}

          {/* Filters */}
          <div className="flex items-center gap-4 flex-wrap rounded-xl border bg-card px-4 py-3">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search by employee, project, or ID..."
                className="pl-9 h-8"
                value={actSearch}
                onChange={(e) => {
                  setActSearch(e.target.value);
                  setActPage(1);
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="w-40 h-8"
                value={actStartDate}
                onChange={(e) => {
                  setActStartDate(e.target.value);
                  setActPage(1);
                }}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                className="w-40 h-8"
                value={actEndDate}
                onChange={(e) => {
                  setActEndDate(e.target.value);
                  setActPage(1);
                }}
              />
            </div>
            <Select
              value={actorFilter}
              onValueChange={(v) => {
                setActorFilter(v);
                setActPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All Actors" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actors</SelectItem>
                {uniqueActors.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActSearch("");
                setActStartDate("");
                setActEndDate("");
                setActorFilter("all");
                setActPage(1);
              }}
            >
              Reset
            </Button>
          </div>

          {/* Table */}
          {isActLoading ? (
            <PageLoader message="Loading activity history…" />
          ) : actItems.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No activity history found"
              description="Approval and rejection decisions will appear here."
            />
          ) : (
            <div className="rounded-xl border overflow-x-auto bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Decision Maker (Actor)
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee & Project
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                      Hours
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Action
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Comment
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">
                            {formatDateTime(item.acted_at)}
                          </div>
                          <div className="flex items-center gap-2">
                            <UserCircle className="size-8 text-muted-foreground" />
                            <div>
                              <div className="text-sm font-medium">
                                {item.approver_name ?? item.approver_id}
                              </div>
                              <div className="text-xs text-muted-foreground capitalize">
                                {item.approver_role}
                              </div>
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <UserCircle className="size-8 text-muted-foreground" />
                          <div>
                            <div className="text-sm font-medium">
                              {item.employee_name || item.employee_id}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {item.project_names.length > 0
                                ? item.project_names.join(", ")
                                : "-"}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="text-sm font-medium text-foreground">
                          {item.hours} hrs
                        </span>
                      </TableCell>
                      <TableCell>
                        {item.action === "approved" ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                            <CheckCircle2 /> Approved
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                            <XCircle /> Rejected
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        {item.comments ? (
                          <p
                            className="text-sm text-muted-foreground italic truncate"
                            title={item.comments}
                          >
                            "{item.comments}"
                          </p>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            -
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <TablePagination
                currentPage={actPage}
                totalPages={Math.ceil(actTotal / actPageSize)}
                startIndex={Math.min((actPage - 1) * actPageSize + 1, actTotal)}
                endIndex={Math.min(actPage * actPageSize, actTotal)}
                total={actTotal}
                pageSize={actPageSize}
                onPageChange={setActPage}
                onPageSizeChange={(s) => {
                  setActPageSize(s);
                  setActPage(1);
                }}
              />
            </div>
          )}
        </>
      )}

      {/* Reject Dialog (single week or all pending weeks) */}
      <Dialog
        open={!!rejectDialog}
        onOpenChange={() => {
          setRejectDialog(null);
          setRejectComment("");
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
              <Button variant="outline" autoFocus>
                Cancel
              </Button>
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Confirm Bulk Rejection
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You are about to reject {selectedWeeks.length} weekly timesheet
            {selectedWeeks.length === 1 ? "" : "s"}.
          </p>
          <div className="flex items-center justify-between text-xs text-muted-foreground uppercase font-medium mt-2">
            <span>Selected Weeks</span>
            <span>{selectedTotalHours} Total Hours</span>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {selectedWeeks.map((w) => (
              <div
                key={w.id}
                className="flex items-center justify-between p-2 bg-muted rounded"
              >
                <div className="flex items-center gap-2">
                  <UserCircle className="size-8 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{w.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {w.emp_code ?? "—"} · {w.range}
                    </div>
                  </div>
                </div>
                <span className="text-sm font-medium text-muted-foreground">
                  {w.hours} hrs
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-2">
            <Label>
              Reason for Rejection <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={bulkRejectComment}
              onChange={(e) => setBulkRejectComment(e.target.value)}
              placeholder="Please explain why these timesheets are being rejected..."
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button variant="outline">
                <XCircle /> Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleBulkReject}
              disabled={!bulkRejectComment || isBulkRejecting}
            >
              {isBulkRejecting && <Loader2 className="animate-spin" />}
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ClientTimesheetDetail
        timesheetId={detailId}
        weeks={detailWeeks}
        open={!!detailId}
        onOpenChange={(v) => {
          if (!v) setDetailId(null);
        }}
      />
    </div>
  );
};

export default ClientReviewDashboard;
