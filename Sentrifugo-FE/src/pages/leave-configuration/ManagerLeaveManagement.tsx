import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { EmptyState } from "@/components/shared/EmptyState";
import { LeaveUsageWarning } from "@/components/shared/LeaveUsageWarning";
import { useAppSelector } from "@/store";
import { formatOrgDate, formatOrgDateTime } from "@/lib/utils";
import { InfiniteScrollSentinel } from "@/components/shared/InfiniteScrollSentinel";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Check,
  X,
  Search,
  List,
  Calendar as CalendarIcon,
  Eye,
  Loader2,
  AlertTriangle,
  Inbox,
} from "lucide-react";
import {
  useLazyGetManagerLeaveRequestsQuery,
  useGetManagerPendingApprovalsQuery,
  useGetManagerLeaveRequestQuery,
  useApproveManagerLeaveRequestMutation,
  useRejectManagerLeaveRequestMutation,
  useGetTeamAvailabilityQuery,
  useGetTeamLeaveSummaryQuery,
  useGetTeamCalendarQuery,
  useGetLeaveTypesQuery,
} from "@/store/api/lmsApi";
import type {
  LeaveRequestResponse,
  TeamMember,
  TeamAvailabilityDay,
  TeamCalendarMember,
  TeamCalendarEvent,
  TeamCalendarHoliday,
  ManagerLeaveRequestDetail,
} from "@/types/leave";
import { PageHeader } from "@/components/shared/PageHeader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";

function getInitials(name: string | undefined | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function initialsFromParts(
  first?: string | null,
  last?: string | null,
  fallbackName?: string | null,
): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (f || l) return ((f[0] ?? "") + (l[0] ?? "")).toUpperCase() || "?";
  return getInitials(fallbackName);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, "0");
  const month = d.toLocaleString("default", { month: "short" });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function mapStatus(status: LeaveRequestResponse["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

function formatLeaveRange(start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
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
  if (s.toDateString() === e.toDateString())
    return `${s.getDate()} ${months[s.getMonth()]}`;
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.getDate()}–${e.getDate()} ${months[s.getMonth()]}`;
  }
  return `${s.getDate()} ${months[s.getMonth()]} – ${e.getDate()} ${months[e.getMonth()]}`;
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

// The Team Leave Stats panel is switched off so the leave requests list gets the
// full height of the column. Set to true to bring the panel back.
const SHOW_TEAM_LEAVE_STATS = false;

// Ordering for the "All" listing — actionable requests bubble to the top.
const STATUS_SORT_RANK: Record<string, number> = {
  Pending: 0,
  Approved: 1,
  Rejected: 2,
  Cancelled: 3,
};

const ManagerLeaveManagement = () => {
  // Defaults to Pending — that's the actionable subset a manager opens this
  // page for; "All" is opt-in via the dropdown, not the landing state.
  const [filterStatus, setFilterStatus] = useState<string | undefined>(
    "PENDING",
  );
  const [viewMode, setViewMode] = useState<"dashboard" | "list" | "calendar">(
    "dashboard",
  );
  const [currentMonthDate, setCurrentMonthDate] = useState(
    () => new Date(2025, 3, 1),
  ); // April 2025
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [isTeamCalendarOpen, setIsTeamCalendarOpen] = useState(false);
  // The detail drawer is URL-driven: `?view=true&leave_id=<id>` opens it, so it
  // survives a refresh, can be shared, and browser back closes it. The detail is
  // fetched by id below, so it opens regardless of the current list filter.
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as {
    view?: string;
    leave_id?: string;
    request?: string;
  };
  const selectedRequestId =
    searchParams.view === "true" && searchParams.leave_id
      ? searchParams.leave_id
      : null;

  const openRequest = (id: string) =>
    navigate({
      to: "/leave-management/manager-leave-management",
      search: { view: "true", leave_id: id },
    });

  // Replace rather than push so closing doesn't leave the drawer in history for
  // a back press to reopen.
  const closeRequest = () =>
    navigate({
      to: "/leave-management/manager-leave-management",
      search: {},
      replace: true,
    });

  // Legacy deep link from the approval-pending / escalated-to-HR emails:
  // `?request=<id>`. Rewritten to the params above so those links keep working.
  useEffect(() => {
    if (!searchParams.request) return;
    navigate({
      to: "/leave-management/manager-leave-management",
      search: { view: "true", leave_id: searchParams.request },
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.request]);

  // Paged via infinite scroll instead of fetched all at once — "All" can be
  // thousands of rows for a large org. Same shape as useInfiniteEmployees /
  // InfiniteScrollSentinel used elsewhere (e.g. ManageCalendarEmployees).
  const LEAVE_REQUEST_PAGE_SIZE = 30;
  const [triggerLeaveRequestsPage] = useLazyGetManagerLeaveRequestsQuery();
  const [pagedRequests, setPagedRequests] = useState<LeaveRequestResponse[]>(
    [],
  );
  const [hasMoreRequests, setHasMoreRequests] = useState(true);
  const [isFetchingRequests, setIsFetchingRequests] = useState(false);
  // Bumped on every filter change; a slow page from the previous filter
  // resolves too late and is dropped instead of appending onto the new list.
  const requestsSeq = useRef(0);
  const loadedRequestPages = useRef(0);
  const requestsInFlight = useRef(false);

  const fetchRequestsPage = useCallback(
    async (page: number, seq: number) => {
      if (requestsInFlight.current) return;
      requestsInFlight.current = true;
      setIsFetchingRequests(true);
      try {
        const result = await triggerLeaveRequestsPage(
          {
            ...(filterStatus ? { status: filterStatus } : {}),
            skip: page * LEAVE_REQUEST_PAGE_SIZE,
            limit: LEAVE_REQUEST_PAGE_SIZE,
          },
          true,
        ).unwrap();
        if (seq !== requestsSeq.current) return;
        setPagedRequests((prev) => (page === 0 ? result : [...prev, ...result]));
        // Exhausted when the server returns a short page — simpler than an
        // exact total, and the endpoint doesn't provide one.
        setHasMoreRequests(result.length >= LEAVE_REQUEST_PAGE_SIZE);
        loadedRequestPages.current = page + 1;
      } catch {
        if (seq === requestsSeq.current) setHasMoreRequests(false);
      } finally {
        if (seq === requestsSeq.current) {
          requestsInFlight.current = false;
          setIsFetchingRequests(false);
        }
      }
    },
    [triggerLeaveRequestsPage, filterStatus],
  );

  // A filter change restarts pagination from page one.
  useEffect(() => {
    const seq = ++requestsSeq.current;
    requestsInFlight.current = false;
    loadedRequestPages.current = 0;
    setPagedRequests([]);
    setHasMoreRequests(true);
    fetchRequestsPage(0, seq);
  }, [filterStatus, fetchRequestsPage]);

  const loadMoreRequests = useCallback(() => {
    if (requestsInFlight.current || !hasMoreRequests) return;
    fetchRequestsPage(loadedRequestPages.current, requestsSeq.current);
  }, [hasMoreRequests, fetchRequestsPage]);

  // isLoading only covers the very first page — once any page has landed,
  // the sentinel's own spinner (isFetchingRequests) takes over.
  const isLoading = isFetchingRequests && pagedRequests.length === 0;

  const { data: pendingApprovalsData } = useGetManagerPendingApprovalsQuery();
  const [approveLeaveRequest] = useApproveManagerLeaveRequestMutation();
  const [rejectLeaveRequest] = useRejectManagerLeaveRequestMutation();
  const confirm = useConfirm();

  const handleApprove = (
    id: string,
    employeeName?: string,
    willExtendNotice?: boolean,
    comment?: string,
  ) => {
    const noticeWarning = willExtendNotice
      ? " This employee is in notice period — approving will extend their last working day."
      : "";
    confirm({
      title: "Approve this leave request?",
      description: employeeName
        ? `This will approve ${employeeName}'s leave request. The employee will be notified.${noticeWarning}`
        : `This will approve the selected leave request. The employee will be notified.${noticeWarning}`,
      confirmText: "Approve",
      onConfirm: async () => {
        try {
          await approveLeaveRequest({ id, body: { comment } }).unwrap();
          toast.success("Leave request approved");
        } catch (err) {
          toast.error(err, "Failed to approve leave request");
        }
      },
    });
  };

  const handleReject = (
    id: string,
    employeeName?: string,
    comment?: string,
  ) => {
    confirm({
      title: "Reject this leave request?",
      description: employeeName
        ? `This will reject ${employeeName}'s leave request. The employee will be notified and cannot resubmit the same request.`
        : "This will reject the selected leave request. The employee will be notified.",
      confirmText: "Reject",
      cancelText: "Keep pending",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await rejectLeaveRequest({ id, body: { comment } }).unwrap();
          toast.success("Leave request rejected");
        } catch (err) {
          toast.error(err, "Failed to reject leave request");
        }
      },
    });
  };
  const [calendarModalStatus, setCalendarModalStatus] = useState("Approve");

  const { data: selectedRequestDetail, isFetching: isFetchingDetail } =
    useGetManagerLeaveRequestQuery(selectedRequestId ?? "", {
      skip: !selectedRequestId,
    });

  // RTK Query's `data` still holds the previously viewed request while the next
  // one is in flight, so the detail is only handed to the drawer once it matches
  // the id being viewed — a stale request can never be rendered or acted on. The
  // mismatch is tolerated while closing (id already null) so the sheet keeps its
  // content through the exit animation.
  const selectedRequestData =
    selectedRequestId &&
    selectedRequestDetail?._id !== selectedRequestId &&
    selectedRequestDetail?.id !== selectedRequestId
      ? undefined
      : selectedRequestDetail;

  const availabilityRange = useMemo(() => {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 6);
    return { start_date: toDateStr(start), end_date: toDateStr(end) };
  }, []);

  const { data: teamAvailabilityData, isLoading: isLoadingAvailability } =
    useGetTeamAvailabilityQuery(availabilityRange);

  // Team Leave Stats period — defaults to the current year; "all" = all time.
  const [statsYear, setStatsYear] = useState<string>(() =>
    String(new Date().getFullYear()),
  );
  const statsYearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => String(current - i));
  }, []);
  const { data: teamSummaryData } = useGetTeamLeaveSummaryQuery(
    statsYear === "all"
      ? undefined
      : { from_date: `${statsYear}-01-01`, to_date: `${statsYear}-12-31` },
  );

  const todayAvailability = useMemo((): TeamAvailabilityDay | undefined => {
    const todayStr = toDateStr(new Date());
    return teamAvailabilityData?.daily_availability.find(
      (d) => d.date === todayStr,
    );
  }, [teamAvailabilityData]);

  const memberHasConflict = useMemo(() => {
    const conflictSet = new Set<string>();
    for (const day of teamAvailabilityData?.daily_availability ?? []) {
      if (day.on_leave_count > 1) {
        for (const entry of day.on_leave) {
          conflictSet.add(entry.user_id);
        }
      }
    }
    return (userId: string) => conflictSet.has(userId);
  }, [teamAvailabilityData]);

  const requests = useMemo(
    () =>
      pagedRequests.map((r) => ({
        id: r._id,
        name: r.employee_name || r.employee_id,
        firstName: r.employee_first_name ?? "",
        lastName: r.employee_last_name ?? "",
        email: r.employee_email ?? "",
        from: formatDate(r.start_date),
        to: formatDate(r.end_date),
        type: r.leave_type_name || r.leave_type_id,
        days: r.duration_days ?? 0,
        status: mapStatus(r.status),
        agingStatus: r.aging_status ?? null,
        daysPending: r.days_pending ?? null,
        sortDate: r.created_on ?? r.start_date,
        selected: false,
      })),
    [pagedRequests],
  );

  // Pending first (they need action), then the rest — newest submission first
  // within each group.
  const filteredRequests = useMemo(
    () =>
      [...requests].sort((a, b) => {
        const rank = (s: string) => STATUS_SORT_RANK[s] ?? 99;
        const byStatus = rank(a.status) - rank(b.status);
        if (byStatus !== 0) return byStatus;
        return (b.sortDate ?? "").localeCompare(a.sortDate ?? "");
      }),
    [requests],
  );

  const pendingApprovals = useMemo(
    () =>
      (Array.isArray(pendingApprovalsData) ? pendingApprovalsData : []).map(
        (r) => ({
          id: r._id,
          name: r.employee_name || r.employee_id,
          firstName: r.employee_first_name ?? "",
          lastName: r.employee_last_name ?? "",
          email: r.employee_email ?? "",
          from: formatDate(r.start_date),
          to: formatDate(r.end_date),
          type: r.leave_type_name || r.leave_type_id,
          days: r.duration_days ?? 0,
          status: mapStatus(r.status),
          agingStatus: r.aging_status ?? null,
          daysPending: r.days_pending ?? null,
          selected: false,
        }),
      ),
    [pendingApprovalsData],
  );

  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "Pending"),
    [requests],
  );

  const pendingCount = pendingApprovals.length;

  const calendarGrid = useMemo(() => {
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const days: { day: number; isCurrentMonth: boolean; dateStr: string }[] =
      [];
    for (let i = firstDay - 1; i >= 0; i--) {
      const dStr = `${year}-${String(month === 0 ? 12 : month).padStart(2, "0")}-${String(prevMonthDays - i).padStart(2, "0")}`;
      days.push({
        day: prevMonthDays - i,
        isCurrentMonth: false,
        dateStr: dStr,
      });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      const dStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
      days.push({ day: i, isCurrentMonth: true, dateStr: dStr });
    }
    const trailingDays = (days.length <= 35 ? 35 : 42) - days.length;
    for (let i = 1; i <= trailingDays; i++) {
      const y = month === 11 ? year + 1 : year;
      const mStr = String(month === 11 ? 1 : month + 2).padStart(2, "0");
      days.push({
        day: i,
        isCurrentMonth: false,
        dateStr: `${y}-${mStr}-${String(i).padStart(2, "0")}`,
      });
    }
    return days;
  }, [currentMonthDate]);

  if (viewMode === "list") {
    return (
      <div className="flex flex-col w-full h-full p-4 sm:p-8 bg-background gap-6 font-sans">
        <PageHeader title="Leave Management" />

        {/* Toolbar */}
        <div className="flex justify-between items-center bg-muted/50 border border-border p-2.5 rounded-xl">
          <div className="flex items-center gap-4 pl-4 flex-1">
            <div className="flex items-center gap-2">
              <Checkbox />
              <span className="text-sm font-semibold text-foreground">
                Select All
              </span>
            </div>
            <div className="relative flex-1 max-w-md ml-8">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground z-10"
                size={16}
              />
              <Input
                placeholder="Search by employee name or ID..."
                className="w-full pl-10 pr-4 py-2.5 border-border rounded-lg text-sm bg-card"
              />
            </div>
          </div>
          <div className="flex bg-card rounded-lg border border-border overflow-hidden shadow-sm">
            <Button
              variant="ghost"
              className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-bold border-r border-border rounded-none h-auto hover:bg-primary hover:text-primary-foreground"
            >
              <List size={16} /> List View
            </Button>
            <Button
              variant="ghost"
              onClick={() => setViewMode("calendar")}
              className="flex items-center gap-2 px-5 py-2.5 bg-card text-muted-foreground hover:bg-muted text-sm font-bold rounded-none h-auto transition-colors"
            >
              <CalendarIcon size={16} /> Calendar View
            </Button>
          </div>
        </div>

        {/* List Content */}
        <div className="bg-card border border-border rounded-xl shadow-sm flex flex-col mt-4 overflow-hidden">
          <div className="p-6 pb-4">
            <h2 className="text-lg font-extrabold text-foreground">
              {filterStatus
                ? `${filterStatus.charAt(0) + filterStatus.slice(1).toLowerCase()} Leave Requests`
                : "All Leave Requests"}{" "}
              ({filteredRequests.length})
            </h2>
          </div>

          <div className="overflow-x-auto">
            <Table className="w-full text-left text-sm text-muted-foreground">
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-12">
                    <Checkbox />
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Employee Name
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    From
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    To
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Leave Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Days
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-border">
                {isLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="px-6 py-12 text-center text-sm text-muted-foreground"
                    >
                      Loading leave requests...
                    </TableCell>
                  </TableRow>
                ) : filteredRequests.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <EmptyState
                        icon={Inbox}
                        title="No leave requests found"
                        description="There are no requests matching your current filters."
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRequests.map((req) => (
                    <TableRow
                      key={req.id}
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <TableCell className="px-6 py-4">
                        <Checkbox defaultChecked={req.selected} />
                      </TableCell>
                      <TableCell className="px-6 py-4 font-bold text-foreground">
                        {req.name}
                      </TableCell>
                      <TableCell className="px-6 py-4 font-medium">
                        {req.from}
                      </TableCell>
                      <TableCell className="px-6 py-4 font-medium">
                        {req.to}
                      </TableCell>
                      <TableCell className="px-6 py-4 font-medium">
                        {req.type}
                      </TableCell>
                      <TableCell className="px-6 py-4 font-medium">
                        {req.days}
                      </TableCell>
                      <TableCell className="px-6 py-4">
                        <span
                          className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${req.status === "Pending" ? "bg-secondary text-warning border-warning/30" : req.status === "Rejected" ? "bg-secondary text-destructive border-destructive/30" : "bg-secondary text-success border-success/30"}`}
                        >
                          {req.status}
                        </span>
                      </TableCell>
                      <TableCell className="px-6 py-4">
                        <div className="flex justify-center items-center gap-3">
                          {req.status === "Pending" ? (
                            <>
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => handleApprove(req.id, req.name)}
                                className="px-4 py-1.5 h-auto text-xs font-bold shadow-sm"
                              >
                                Approve
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleReject(req.id, req.name)}
                                className="px-4 py-1.5 h-auto text-xs font-bold text-destructive border-destructive/30 hover:bg-destructive/10 shadow-sm"
                              >
                                Reject
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="icon"
                              className="w-8 h-8 text-muted-foreground shadow-sm"
                              onClick={() => openRequest(req.id)}
                            >
                              <Eye size={14} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-muted-foreground ml-2 w-6 h-6"
                          >
                            <ChevronRight size={14} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="p-6 flex items-center justify-between border-t border-border">
            <span className="text-sm font-semibold text-muted-foreground">
              Showing 1 to {filteredRequests.length} of{" "}
              {filteredRequests.length} employees
            </span>
            <div className="flex gap-2 text-sm font-semibold text-muted-foreground">
              <Button
                variant="outline"
                className="px-4 py-2 h-auto border-border bg-card"
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                size="icon-lg"
                className="bg-primary/10 text-primary font-bold"
              >
                1
              </Button>
              <Button variant="ghost" size="icon-lg" className="hover:bg-muted">
                2
              </Button>
              <Button variant="ghost" size="icon-lg">
                ...
              </Button>
              <Button variant="ghost" size="icon-lg" className="hover:bg-muted">
                8
              </Button>
              <Button
                variant="outline"
                className="px-4 py-2 h-auto border-border bg-card"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (viewMode === "calendar") {
    return (
      <div className="flex flex-col w-full h-full bg-card font-sans text-foreground">
        <div className="flex justify-between items-start p-6 pb-2 border-b border-border">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="flex border border-border rounded overflow-hidden">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="p-1.5 bg-card hover:bg-muted border-r border-border rounded-none h-auto"
                  onClick={() =>
                    setCurrentMonthDate(
                      (prev) =>
                        new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
                    )
                  }
                >
                  <ChevronLeft size={16} className="text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="p-1.5 bg-card hover:bg-muted rounded-none h-auto"
                  onClick={() =>
                    setCurrentMonthDate(
                      (prev) =>
                        new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
                    )
                  }
                >
                  <ChevronRight size={16} className="text-muted-foreground" />
                </Button>
              </div>
              <Button
                variant="secondary"
                onClick={() => setCurrentMonthDate(new Date())}
                className="px-4 py-1.5 h-auto text-sm font-semibold"
              >
                Today
              </Button>
            </div>
            <h1 className="text-xl font-semibold text-foreground">
              {currentMonthDate.toLocaleString("default", {
                month: "long",
                year: "numeric",
              })}
            </h1>
          </div>

          <div className="flex-1 flex justify-center px-4">
            <div className="border border-dashed border-border rounded p-4 text-center max-w-md w-full">
              <p className="text-[13px] text-muted-foreground">
                Click on a date to apply for 1 day of leave. Click and drag on
                the desired dates to apply for multiple days of leave.
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-3">
            <Button variant="default">Request Leave</Button>
            <div className="flex items-center gap-4">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
                  ×
                </span>
                <Input
                  placeholder="Employee Reporting To Me"
                  className="pl-8 pr-8 py-1.5 border-border rounded text-xs w-56 text-muted-foreground focus:border-indigo-300"
                  readOnly
                />
                <Search
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/40"
                  size={12}
                />
              </div>
              <div className="flex bg-card rounded-lg border border-border overflow-hidden shadow-sm">
                <Button
                  variant="ghost"
                  onClick={() => setViewMode("list")}
                  className="flex items-center gap-2 px-4 py-2 bg-card text-muted-foreground hover:bg-muted text-xs font-bold border-r border-border rounded-none h-auto transition-colors"
                >
                  <List size={14} /> List View
                </Button>
                <Button
                  variant="ghost"
                  className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-xs font-bold rounded-none h-auto hover:bg-primary hover:text-primary-foreground transition-colors"
                >
                  <CalendarIcon size={14} /> Calendar View
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 p-6 overflow-auto bg-muted/30">
          <div className="border border-border rounded bg-card">
            <div className="grid grid-cols-7 border-b border-border bg-card">
              {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => (
                <div
                  key={day}
                  className="py-4 text-center text-xs font-bold text-muted-foreground"
                >
                  {day}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {calendarGrid.map((cell, i) => {
                const isRightEdge = (i + 1) % 7 === 0;
                const borderClasses = `border-b ${!isRightEdge ? "border-r" : ""} border-border`;
                const textClass = cell.isCurrentMonth
                  ? "text-muted-foreground"
                  : "text-muted-foreground/40";

                // Mock Event Condition
                const hasEvent = cell.dateStr === "2025-04-13";

                return (
                  <div
                    key={`${cell.dateStr}-${i}`}
                    className={`min-h-[140px] p-2 flex flex-col ${borderClasses} bg-card`}
                  >
                    <div
                      className={`text-right text-xs font-semibold mb-1 pr-1 ${textClass}`}
                    >
                      {cell.day}
                    </div>
                    {hasEvent && (
                      <div
                        className="bg-destructive text-white text-[10px] font-bold px-2 py-1 rounded truncate shadow-sm cursor-pointer hover:bg-destructive/80 transition"
                        onClick={() => setIsLeaveModalOpen(true)}
                      >
                        John Doe, Leave, (A)
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <Dialog open={isLeaveModalOpen} onOpenChange={setIsLeaveModalOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Leave Request</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-[200px_1fr] gap-6">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-muted-foreground">
                    Status
                  </label>
                  <Select
                    value={calendarModalStatus}
                    onValueChange={setCalendarModalStatus}
                  >
                    <SelectTrigger className="w-full text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Approve">Approve</SelectItem>
                      <SelectItem value="Reject">Reject</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-muted-foreground">
                    Comments
                  </label>
                  <Textarea className="w-full text-sm resize-none min-h-10" />
                  <span className="text-[10px] text-muted-foreground text-center">
                    50 characters remaining (50 maximum)
                  </span>
                </div>
              </div>

              <div className="border border-border rounded">
                <div className="grid grid-cols-4 border-b border-border">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50">
                    Employee
                  </div>
                  <div className="p-3 text-sm text-foreground border-r border-border">
                    John JH
                  </div>
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50">
                    Leave Type
                  </div>
                  <div className="p-3 text-sm text-foreground">
                    Compensatory
                  </div>
                </div>
                <div className="grid grid-cols-4 border-b border-border">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50">
                    From
                  </div>
                  <div className="p-3 text-sm text-foreground border-r border-border">
                    14 Jun 2024
                  </div>
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50">
                    To
                  </div>
                  <div className="p-3 text-sm text-foreground">14 Jun 2024</div>
                </div>
                <div className="grid grid-cols-4 border-b border-border">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50">
                    Leave For
                  </div>
                  <div className="p-3 text-sm text-foreground border-r border-border">
                    Half day
                  </div>
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50">
                    Days
                  </div>
                  <div className="p-3 text-sm text-foreground">0.5</div>
                </div>
                <div className="grid grid-cols-2 border-b border-border">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50 border-r border-border">
                    Applied On
                  </div>
                  <div className="p-3 text-sm text-foreground">14 Jun 2024</div>
                </div>
                <div className="grid grid-cols-2 border-b border-border">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50 border-r border-border">
                    Leave Type
                  </div>
                  <div className="p-3 text-sm text-foreground">
                    Compensatory
                  </div>
                </div>
                <div className="grid grid-cols-2 border-b border-border">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50 border-r border-border">
                    To
                  </div>
                  <div className="p-3 text-sm text-foreground">14 Jun 2024</div>
                </div>
                <div className="grid grid-cols-2">
                  <div className="p-3 text-sm font-semibold text-muted-foreground bg-muted/50 border-r border-border">
                    Days
                  </div>
                  <div className="p-3 text-sm text-foreground">0.5</div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsLeaveModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="soft"
                onClick={() => {
                  const firstPending = pendingApprovals[0];
                  if (firstPending) {
                    if (calendarModalStatus === "Reject") {
                      handleReject(firstPending.id, firstPending.name);
                    } else {
                      handleApprove(firstPending.id, firstPending.name);
                    }
                  }
                  setIsLeaveModalOpen(false);
                }}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // h-[calc(100svh-7rem)] is the shared page-shell height: AdminLayout's Topbar
  // is h-16 (4rem) and #main-content adds p-6 (3rem vertical). Any taller and
  // the layout's overflow-y-auto gives the whole page a scrollbar — this page
  // is meant to scroll only inside its panels.
  return (
    <div className="flex flex-col w-full h-[calc(100svh-7rem)] p-4 sm:px-8 sm:py-4 font-sans overflow-hidden">
      {/* Main Grid Content */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-stretch flex-1 min-h-0">
        {/* Left Column — min-w-0 because a grid item defaults to min-width:auto,
            so the long "16 Sep 2026 – 18 Sep 2026 · 3 days" line in a request
            card would otherwise widen this column and push the availability
            panel off-screen below ~1400px. */}
        <div className="flex flex-col gap-3 min-h-0 min-w-0">
          {/* Leave Requests (filtered by active tab) */}
          {(() => {
            const sectionTitle = filterStatus
              ? `${filterStatus.charAt(0) + filterStatus.slice(1).toLowerCase()} leave requests`
              : "Team leave requests";
            // "All" shows every request from /manager/leave-requests (no status
            // param) — not the pending-approvals inbox, which is scoped to what
            // this manager can still act on and so hides everything already
            // decided.
            const displayList = filteredRequests;
            const statusBadgeClass = (s: string) =>
              s === "Pending"
                ? "bg-destructive/10 text-destructive"
                : s === "Approved"
                  ? "bg-success/10 text-success"
                  : s === "Rejected"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground";
            return (
              <div className="bg-card border border-border shadow-sm rounded-xl p-5 flex-1 min-h-0 flex flex-col">
                <div className="flex justify-between items-center gap-4 mb-4 shrink-0">
                  <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                    {sectionTitle}
                    <span className="bg-primary/10 text-primary text-xs font-bold leading-none w-5 h-5 flex items-center justify-center rounded-full">
                      {displayList.length}
                    </span>
                  </h2>
                  <div className="flex items-center gap-4 shrink-0">
                    <span
                      className="text-sm font-bold text-primary cursor-pointer hover:underline whitespace-nowrap"
                      onClick={() => setIsTeamCalendarOpen(true)}
                    >
                      View Full Calendar &gt;
                    </span>
                    <Select
                      value={filterStatus ?? "ALL"}
                      onValueChange={(v) =>
                        setFilterStatus(v === "ALL" ? undefined : v)
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-36 text-xs font-semibold"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">All</SelectItem>
                        <SelectItem value="PENDING">Pending</SelectItem>
                        <SelectItem value="APPROVED">Approved</SelectItem>
                        <SelectItem value="REJECTED">Rejected</SelectItem>
                        <SelectItem value="CANCELLED">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto pr-1">
                  {isLoading ? (
                    <div className="text-sm text-muted-foreground text-center py-8">
                      Loading...
                    </div>
                  ) : displayList.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-8">
                      No {filterStatus ? `${filterStatus.toLowerCase()} ` : ""}
                      leave requests.
                    </div>
                  ) : (
                    displayList.map((req) => (
                      <div
                        key={req.id}
                        className="border border-border rounded-xl p-4 flex justify-between items-center gap-3 bg-card hover:border-border transition-colors"
                      >
                        {/* min-w-0 lets this half shrink so the approve/reject
                            controls on the right are never pushed out of the
                            card on a narrow screen. */}
                        <div className="flex items-center gap-4 min-w-0">
                          <Avatar className="w-10 h-10 shrink-0">
                            <AvatarFallback className="text-xs">
                              {initialsFromParts(
                                req.firstName,
                                req.lastName,
                                req.name,
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col min-w-0">
                            <span className="text-sm font-bold text-foreground truncate">
                              {req.name}
                            </span>
                            {req.email && (
                              <span className="text-xs text-muted-foreground truncate">
                                {req.email}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground font-medium">
                              {req.from} – {req.to} ·{" "}
                              <span className="text-foreground font-bold">
                                {req.days} days
                              </span>
                            </span>
                          </div>
                          <span
                            className={`ml-4 shrink-0 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${statusBadgeClass(req.status)}`}
                          >
                            {req.status}
                          </span>
                          {req.agingStatus === "overdue" && (
                            <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider bg-destructive/10 text-destructive">
                              Overdue{typeof req.daysPending === "number" ? ` · ${req.daysPending}d` : ""}
                            </span>
                          )}
                          {req.agingStatus === "due_soon" && (
                            <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider bg-warning/10 text-warning">
                              Due soon
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-muted-foreground shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 shadow-sm text-xs font-semibold"
                            onClick={() => openRequest(req.id)}
                          >
                            View details
                          </Button>
                          {req.status === "Pending" && (
                            <>
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={() => handleApprove(req.id, req.name)}
                                className="w-7 h-7 rounded-full border-success/30 hover:bg-success/10"
                                title="Approve"
                              >
                                <Check size={14} className="text-success" />
                              </Button>
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={() => handleReject(req.id, req.name)}
                                className="w-7 h-7 rounded-full border-destructive/30 hover:bg-destructive/10"
                                title="Reject"
                              >
                                <X size={14} className="text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  <InfiniteScrollSentinel
                    onLoadMore={loadMoreRequests}
                    hasMore={hasMoreRequests}
                    isFetching={isFetchingRequests}
                  />
                </div>
              </div>
            );
          })()}

          {/* Team Leave Stats — hidden for now (kept so it can be switched back
              on by flipping SHOW_TEAM_LEAVE_STATS). While hidden the leave
              requests panel above takes the full height of this column. */}
          {SHOW_TEAM_LEAVE_STATS && (
          <div className="bg-card border border-border shadow-sm rounded-xl p-6 flex-1 min-h-0 flex flex-col">
            <div className="flex justify-between items-center mb-6 shrink-0">
              <h2 className="text-lg font-bold text-foreground">
                Team Leave Stats
              </h2>
              <div className="flex items-center gap-3">
                {teamSummaryData && (
                  <span className="text-xs text-muted-foreground font-medium">
                    {teamSummaryData.employees_with_leaves} of{" "}
                    {teamSummaryData.total_employees} employees with leaves
                  </span>
                )}
                <Select value={statsYear} onValueChange={setStatsYear}>
                  <SelectTrigger
                    size="sm"
                    className="w-28 text-xs font-semibold"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statsYearOptions.map((y) => (
                      <SelectItem key={y} value={y}>
                        {y}
                      </SelectItem>
                    ))}
                    <SelectItem value="all">All time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!teamSummaryData ||
            teamSummaryData.summary_by_type.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground flex-1 flex items-center justify-center">
                No team leave data available.
              </div>
            ) : (
              <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-1">
                {teamSummaryData.summary_by_type.map((item) => {
                  const pct =
                    teamSummaryData.total_employees > 0
                      ? Math.round(
                          (item.employee_count /
                            teamSummaryData.total_employees) *
                            100,
                        )
                      : 0;
                  return (
                    <div
                      key={item.leave_type_id}
                      className="flex items-center gap-4"
                    >
                      <span className="text-xs font-semibold text-foreground w-32 truncate">
                        {item.leave_type_name}
                      </span>
                      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex gap-4 text-xs text-muted-foreground shrink-0 min-w-[120px]">
                        <span>
                          <span className="font-bold text-foreground">
                            {item.employee_count}
                          </span>{" "}
                          emp
                        </span>
                        <span>
                          <span className="font-bold text-foreground">
                            {item.total_days}
                          </span>{" "}
                          days
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}
        </div>

        {/* Right Column */}
        <div className="flex flex-col gap-8 min-h-0">
          {/* Team Leave Requests Small */}
          {/* <div className="bg-card border border-border shadow-sm rounded-xl p-5">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-sm font-extrabold text-foreground">Team Leave Requests</h2>
              <span className="text-[10px] font-bold text-primary cursor-pointer hover:underline">View All »</span>
            </div>

            <div className="flex flex-col gap-4">
              {isLoading ? (
                <div className="text-[10px] text-muted-foreground text-center py-4">Loading...</div>
              ) : pendingRequests.length === 0 ? (
                <div className="text-[10px] text-muted-foreground text-center py-4">No pending requests.</div>
              ) : pendingApprovals.map((req) => (
                <div key={req.id} className="flex justify-between items-center">
                  <div className="flex gap-3 items-center">
                    <Avatar className="w-8 h-8"><AvatarFallback className="text-[10px]">{getInitials(req.name)}</AvatarFallback></Avatar>
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-foreground">{req.name}</span>
                      <span className="text-[9px] font-medium text-muted-foreground">{req.from} – {req.to} · <span className="font-bold text-foreground">{req.days} days</span></span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <Button variant="outline" size="xs" className="text-muted-foreground border-border">View details</Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-border flex justify-center">
              <span className="text-[10px] font-bold text-primary cursor-pointer hover:underline">View full list »</span>
            </div>
          </div> */}

          {/* Team Calendar Small */}
          <div className="flex flex-col gap-4 flex-1 min-h-0">
            <h2 className="text-sm font-extrabold text-foreground px-2 shrink-0">
              Team Availability
            </h2>

            <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm flex flex-col flex-1 min-h-0">
              <div className="bg-muted/50 p-4 border-b border-border shrink-0">
                {isLoadingAvailability ? (
                  <span className="text-xs font-extrabold text-muted-foreground">
                    Loading availability...
                  </span>
                ) : todayAvailability ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-extrabold text-foreground">
                      {todayAvailability.available_count} of{" "}
                      {teamAvailabilityData!.total_team_size} team members
                      available today
                    </span>
                    {/* The count above is for today only, but the rows below list
                        every leave in the next 7 days — without this caption the
                        two read as contradicting each other. */}
                    <span className="text-[10px] font-medium text-muted-foreground">
                      Upcoming leave shown for the next 7 days
                    </span>
                  </div>
                ) : (
                  <span className="text-xs font-extrabold text-foreground">
                    {teamAvailabilityData?.total_team_size ?? 0} team members
                  </span>
                )}
              </div>

              <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
                {isLoadingAvailability ? (
                  <div className="px-4 py-6 text-center text-[10px] text-muted-foreground">
                    Loading...
                  </div>
                ) : (teamAvailabilityData?.team_members ?? []).length === 0 ? (
                  <div className="px-4 py-6 text-center text-[10px] text-muted-foreground">
                    No team members found.
                  </div>
                ) : (
                  (teamAvailabilityData!.team_members as TeamMember[]).map(
                    (member, idx, arr) => {
                      const onLeave = member.leaves_in_range.length > 0;
                      const hasConflict = memberHasConflict(member.user_id);
                      const isLast = idx === arr.length - 1;
                      const pendingLeave = member.leaves_in_range.find(
                        (l) => l.status === "PENDING",
                      );
                      const approvedLeave = member.leaves_in_range.find(
                        (l) => l.status === "APPROVED",
                      );
                      const primaryLeave = approvedLeave ?? pendingLeave;

                      return (
                        <div
                          key={member.user_id}
                          className={`px-4 py-3 flex justify-between items-center ${!isLast ? "border-b border-border" : ""}`}
                        >
                          <div className="flex items-center gap-2 text-xs font-bold text-foreground min-w-0">
                            <div
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${onLeave ? (pendingLeave && !approvedLeave ? "border-2 border-dashed border-warning bg-transparent" : "bg-destructive/70") : "bg-success/70"}`}
                            />
                            <span
                              className={`truncate ${onLeave && !approvedLeave && pendingLeave ? "text-muted-foreground" : ""}`}
                            >
                              {member.name}
                            </span>
                            {primaryLeave && (
                              <span className="text-muted-foreground font-medium shrink-0 ml-1">
                                –{" "}
                                {formatLeaveRange(
                                  primaryLeave.start_date,
                                  primaryLeave.end_date,
                                )}
                                {primaryLeave.status === "PENDING" && (
                                  <span className="italic text-[9px] ml-1">
                                    (pending)
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                          {hasConflict && (
                            <span
                              title="Overlapping leave: at least one other team member is off on the same day"
                              className="bg-destructive/10 text-destructive text-[8px] font-bold px-1.5 py-0.5 rounded border border-red-100 shrink-0 ml-2"
                            >
                              Overlap
                            </span>
                          )}
                        </div>
                      );
                    },
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <TeamCalendarDialog
        open={isTeamCalendarOpen}
        onClose={() => setIsTeamCalendarOpen(false)}
      />
      <LeaveDetailDialog
        requestId={selectedRequestId}
        data={selectedRequestData ?? null}
        isFetching={isFetchingDetail}
        onClose={closeRequest}
        onApprove={(id, comment) => {
          const name =
            selectedRequestData?.employee?.name ??
            selectedRequestData?.employee?.email;
          const willExtend =
            selectedRequestData?.notice_period_info?.will_extend_notice;
          closeRequest();
          // Wait for Sheet close animation so the AlertDialog isn't blocked
          // by Radix's body pointer-events lock from the closing Sheet.
          setTimeout(() => handleApprove(id, name, willExtend, comment), 200);
        }}
        onReject={(id, comment) => {
          const name =
            selectedRequestData?.employee?.name ??
            selectedRequestData?.employee?.email;
          closeRequest();
          setTimeout(() => handleReject(id, name, comment), 200);
        }}
      />
    </div>
  );
};

// ─── Leave Detail Dialog ─────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-success/10 text-success border-success/20",
  PENDING: "bg-badge-pending-bg text-badge-pending-text border-warning/20",
  REJECTED: "bg-destructive/10 text-destructive border-destructive/20",
  CANCELLED: "bg-muted text-muted-foreground border-border",
};

const ACTION_COLOR: Record<string, string> = {
  SUBMITTED: "bg-primary/10 text-primary",
  APPROVED: "bg-badge-active-bg text-badge-active-text",
  REJECTED: "bg-badge-inactive-bg text-badge-inactive-text",
  CANCELLED: "bg-muted text-muted-foreground",
};

function LeaveDetailDialog({
  requestId,
  data,
  isFetching,
  onClose,
  onApprove,
  onReject,
}: {
  requestId: string | null;
  data: ManagerLeaveRequestDetail | null;
  isFetching: boolean;
  onClose: () => void;
  onApprove: (id: string, comment?: string) => void;
  onReject: (id: string, comment?: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [renderedRequestId, setRenderedRequestId] = useState(requestId);

  const open = !!requestId;
  const isPending = data?.status === "PENDING";

  // The Sheet stays mounted between requests, so every piece of drawer-local
  // state has to be cleared explicitly whenever the request changes — otherwise
  // the previous request's draft comment carries over. Reset during render (the
  // documented React pattern) so the drawer never paints with stale state; add
  // any future drawer-local state to this block.
  if (requestId !== renderedRequestId) {
    setRenderedRequestId(requestId);
    setComment("");
  }

  // The request payload carries the type's name but not its flags, so the type
  // is resolved here to decide whether the usage warning applies.
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id) ?? "";
  const { data: leaveTypesData } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId || !open,
  });
  const detailLeaveType = (leaveTypesData ?? []).find(
    (lt) => lt._id === data?.leave_type_id,
  );

  // Handles both plain dates (start/end) and datetimes (Applied On) — the latter
  // would otherwise land on the wrong DAY for anything logged after 18:30 UTC.
  // const fmt = (iso: string) => formatOrgDate(iso);

  // Activity timestamps come back without an offset (see parseApiDate) — read as
  // UTC and rendered in the org's timezone, not the viewer's.
  // const fmtTime = (iso: string) => formatOrgDateTime(iso);
  const fmt = formatDateIST;
  const fmtTime = formatDateTimeIST;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[520px] flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 py-5 border-b">
          <SheetTitle className="text-base font-bold">
            Leave Request Details
          </SheetTitle>
        </SheetHeader>

        {isFetching || !data ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-10">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading…</span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5 text-sm">
            {/* Status badge */}
            <span
              className={`self-start text-[11px] font-bold px-2.5 py-0.5 rounded-full border uppercase tracking-wide ${STATUS_BADGE[data.status] ?? "bg-muted text-muted-foreground border-border"}`}
            >
              {data.status}
            </span>

            {/* Employee details */}
            <div className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg border border-border">
              <Avatar className="w-10 h-10 shrink-0">
                <AvatarFallback className="text-xs">
                  {getInitials(data.employee.name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-bold text-foreground">
                  {data.employee.name}
                </span>
                <span className="text-xs text-muted-foreground truncate">
                  {data.employee.email}
                </span>
                <span className="text-xs text-muted-foreground">
                  {data.employee.department_name}
                </span>
              </div>
            </div>

            {/* Unrestricted leave carries no balance for the approver to weigh
                the request against — this is what they get instead. Renders
                nothing unless the type is configured for it. */}
            <LeaveUsageWarning
              leaveType={detailLeaveType}
              leaveTypeId={data.leave_type_id}
              userId={data.employee.id}
              audience="approver"
            />

            {/* Leave info grid */}
            <div className="border border-border rounded-lg overflow-hidden">
              {(
                [
                  {
                    label: "Leave Type",
                    value: data.leave_type_name || data.leave_type_id || "—",
                  },
                  { label: "From", value: fmt(data.start_date) },
                  { label: "To", value: fmt(data.end_date) },
                  {
                    label: "Duration",
                    value: `${data.duration_days ?? 0} day${data.duration_days !== 1 ? "s" : ""}${data.duration_mode ? ` · ${data.duration_mode.replace(/_/g, " ")}` : ""}`,
                  },
                  data.worked_dates && data.worked_dates.length > 0
                    ? {
                        label: "Compensated days",
                        value: data.worked_dates.map((d) => fmt(d)).join(", "),
                      }
                    : null,
                  {
                    label: "Applied On",
                    value: data.created_on ? fmt(data.created_on) : "—",
                  },
                  data.l1_manager
                    ? { label: "L1 Manager", value: data.l1_manager.name }
                    : null,
                  data.l2_manager
                    ? { label: "L2 Manager", value: data.l2_manager.name }
                    : null,
                ] as ({ label: string; value: string } | null)[]
              )
                .filter(
                  (r): r is { label: string; value: string } => r !== null,
                )
                .map(({ label, value }, i, arr) => (
                  <div
                    key={label}
                    className={`grid grid-cols-[140px_1fr] ${i < arr.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <div className="px-4 py-2.5 text-xs font-semibold text-muted-foreground bg-muted/50">
                      {label}
                    </div>
                    <div className="px-4 py-2.5 text-xs text-foreground font-medium">
                      {value}
                    </div>
                  </div>
                ))}
            </div>

            {/* Reason */}
            {data.reason && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground">
                  Reason
                </span>
                <p className="text-xs text-foreground leading-relaxed bg-muted/40 rounded-lg px-3 py-2">
                  {data.reason}
                </p>
              </div>
            )}

            {/* Approval timeline */}
            {data.approval_timeline.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Activity
                </span>
                <div className="flex flex-col gap-1">
                  {data.approval_timeline.map((entry, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0"
                    >
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded shrink-0 mt-0.5 ${ACTION_COLOR[entry.action] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {entry.action}
                      </span>
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-semibold text-foreground">
                          {entry.actor_name}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {fmtTime(entry.timestamp)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notice period warning */}
            {isPending && data?.notice_period_info?.in_notice_period && (
              <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-3">
                <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
                <div className="text-xs leading-relaxed">
                  <p className="font-semibold text-foreground">
                    Employee is serving notice period
                  </p>
                  {data.notice_period_info.will_extend_notice ? (
                    <p className="text-muted-foreground mt-0.5">
                      Approving this leave will extend the notice period by{" "}
                      <span className="font-medium text-foreground">
                        {Math.ceil(data.duration_days ?? 0)} day
                        {Math.ceil(data.duration_days ?? 0) !== 1 ? "s" : ""}
                      </span>
                      .
                      {data.notice_period_info.current_lwd && (
                        <>
                          {" "}
                          Current last working day:{" "}
                          <span className="font-medium text-foreground">
                            {fmt(data.notice_period_info.current_lwd)}
                          </span>
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="text-muted-foreground mt-0.5">
                      This leave type is blocked during notice period.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Comment box for approve/reject */}
            {isPending && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-muted-foreground">
                  Comment (optional)
                </label>
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, 200))}
                  className="text-sm resize-none min-h-[72px]"
                  placeholder="Add a comment…"
                />
              </div>
            )}
          </div>
        )}

        <div className="border-t px-6 py-4 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {isPending && data && (
            <>
              <Button
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => onReject(data._id, comment.trim() || undefined)}
              >
                Reject
              </Button>
              <Button
                variant="default"
                onClick={() => onApprove(data._id, comment.trim() || undefined)}
              >
                Approve
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Team Calendar Dialog ────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATUS_COLORS: Record<string, string> = {
  APPROVED: "bg-badge-active-bg text-badge-active-text",
  PENDING: "bg-badge-pending-bg text-badge-pending-text",
};

const PILL_COLORS: Record<string, string> = {
  APPROVED: "bg-success text-white",
  PENDING: "bg-badge-pending-bg text-badge-pending-text",
};

function toISODate(d: Date): string {
  // Build from local Y/M/D — toISOString() converts to UTC and shifts the
  // date back by one in positive-offset zones (e.g. IST).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function TeamCalendarDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [calView, setCalView] = useState<"calendar" | "list">("calendar");
  const [monthDate, setMonthDate] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const statusFilter = ["APPROVED", "PENDING"];

  const fromDate = toISODate(monthDate);
  const lastDay = new Date(
    monthDate.getFullYear(),
    monthDate.getMonth() + 1,
    0,
  );
  const toDate = toISODate(lastDay);

  const { data, isFetching } = useGetTeamCalendarQuery(
    { from_date: fromDate, to_date: toDate, status: statusFilter },
    { skip: !open },
  );

  const prevMonth = () =>
    setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const nextMonth = () =>
    setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));

  const todayStr = toISODate(new Date());

  // Map date → holidays
  const holidayMap = useMemo(() => {
    const m = new Map<string, TeamCalendarHoliday[]>();
    for (const h of data?.holidays ?? []) {
      const arr = m.get(h.date) ?? [];
      arr.push(h);
      m.set(h.date, arr);
    }
    return m;
  }, [data]);

  // Map date → events (expand multi-day events to every covered date)
  const dateEventMap = useMemo(() => {
    const m = new Map<
      string,
      { member: TeamCalendarMember; event: TeamCalendarEvent }[]
    >();
    for (const member of data?.team_members ?? []) {
      for (const ev of member.events) {
        if (!statusFilter.includes(ev.status)) continue;
        const cur = new Date(ev.start_date + "T00:00:00");
        const end = new Date(ev.end_date + "T00:00:00");
        while (cur <= end) {
          const ds = toISODate(cur);
          const arr = m.get(ds) ?? [];
          arr.push({ member, event: ev });
          m.set(ds, arr);
          cur.setDate(cur.getDate() + 1);
        }
      }
    }
    return m;
  }, [data, statusFilter]);

  // Build calendar grid
  const calGrid = useMemo(() => {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();

    const cells: { dateStr: string; day: number; isCurrentMonth: boolean }[] =
      [];
    for (let i = firstDow - 1; i >= 0; i--) {
      const d = prevDays - i;
      const m2 = month === 0 ? 12 : month;
      const y2 = month === 0 ? year - 1 : year;
      cells.push({
        dateStr: `${y2}-${String(m2).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        day: d,
        isCurrentMonth: false,
      });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      cells.push({
        dateStr: `${year}-${String(month + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`,
        day: i,
        isCurrentMonth: true,
      });
    }
    const trailing = (cells.length <= 35 ? 35 : 42) - cells.length;
    for (let i = 1; i <= trailing; i++) {
      const y2 = month === 11 ? year + 1 : year;
      const m2 = month === 11 ? 1 : month + 2;
      cells.push({
        dateStr: `${y2}-${String(m2).padStart(2, "0")}-${String(i).padStart(2, "0")}`,
        day: i,
        isCurrentMonth: false,
      });
    }
    return cells;
  }, [monthDate]);

  // Flat list of all events for list view
  const allEvents = useMemo(() => {
    const rows: {
      memberName: string;
      leaveTypeName: string;
      startDate: string;
      endDate: string;
      days: number;
      status: string;
    }[] = [];
    for (const member of data?.team_members ?? []) {
      for (const ev of member.events) {
        if (!statusFilter.includes(ev.status)) continue;
        rows.push({
          memberName: member.employee_name,
          leaveTypeName: ev.leave_type_name,
          startDate: ev.start_date,
          endDate: ev.end_date,
          days: ev.duration_days,
          status: ev.status,
        });
      }
    }
    rows.sort((a, b) => a.startDate.localeCompare(b.startDate));
    return rows;
  }, [data, statusFilter]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-[92vw] w-full max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="flex-row items-center justify-between border-b px-6 py-4 gap-0 flex-shrink-0">
          <div className="flex items-center gap-4">
            <DialogTitle className="text-base font-bold">
              Team Calendar
            </DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 border border-border"
                onClick={prevMonth}
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-sm font-semibold min-w-[130px] text-center">
                {monthDate.toLocaleString("default", {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 border border-border"
                onClick={nextMonth}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 mr-8">
            <div className="flex border border-border rounded overflow-hidden">
              <button
                onClick={() => setCalView("calendar")}
                className={`px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 transition-colors ${calView === "calendar" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
              >
                <CalendarIcon size={12} /> Calendar
              </button>
              <button
                onClick={() => setCalView("list")}
                className={`px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 border-l border-border transition-colors ${calView === "list" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
              >
                <List size={12} /> List
              </button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0">
          {isFetching ? (
            <div className="flex items-center justify-center h-64 gap-2 text-muted-foreground">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Loading team calendar…</span>
            </div>
          ) : calView === "calendar" ? (
            <div className="p-4">
              {/* Day headers */}
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
              {/* Grid */}
              <div className="grid grid-cols-7 border-t border-l border-border rounded overflow-hidden">
                {calGrid.map((cell, i) => {
                  const events = dateEventMap.get(cell.dateStr) ?? [];
                  const holidays = holidayMap.get(cell.dateStr) ?? [];
                  const isToday = cell.dateStr === todayStr;
                  const shown = events.slice(0, 3);
                  const overflow = events.length - shown.length;

                  return (
                    <div
                      key={`${cell.dateStr}-${i}`}
                      className={`border-r border-b border-border min-h-[110px] p-1.5 flex flex-col ${cell.isCurrentMonth ? "bg-card" : "bg-muted/30"}`}
                    >
                      <div
                        className={`text-right text-xs font-semibold mb-1 pr-0.5 ${cell.isCurrentMonth ? "text-foreground" : "text-muted-foreground/40"}`}
                      >
                        {isToday ? (
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                            {cell.day}
                          </span>
                        ) : (
                          cell.day
                        )}
                      </div>
                      {holidays.map((h) => (
                        <div
                          key={h.name}
                          className="text-[9px] font-semibold bg-primary/5 text-primary px-1 py-0.5 rounded mb-0.5 truncate"
                          title={h.name}
                        >
                          {h.name}
                        </div>
                      ))}
                      {shown.map(({ member, event }, idx) => (
                        <div
                          key={`${event.request_id}-${idx}`}
                          className={`text-[9px] font-semibold px-1 py-0.5 rounded mb-0.5 truncate ${PILL_COLORS[event.status]}`}
                          title={`${member.employee_name} – ${event.leave_type_name}`}
                        >
                          {member.employee_name}
                        </div>
                      ))}
                      {overflow > 0 && (
                        <div className="text-[9px] text-muted-foreground font-medium px-1">
                          +{overflow} more
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Employee
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Leave Type
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      From
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      To
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Days
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allEvents.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-12 text-sm text-muted-foreground"
                      >
                        No leave events for this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    allEvents.map((row, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-sm font-semibold">
                          {row.memberName}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {row.leaveTypeName}
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.startDate}
                        </TableCell>
                        <TableCell className="text-sm">{row.endDate}</TableCell>
                        <TableCell className="text-sm">{row.days}</TableCell>
                        <TableCell>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_COLORS[row.status] ?? "bg-muted text-muted-foreground"}`}
                          >
                            {row.status}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="border-t px-6 py-3 flex items-center gap-4 flex-shrink-0 bg-muted/30">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-success inline-block" />
            <span className="text-[11px] text-muted-foreground">Approved</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-badge-pending-bg inline-block" />
            <span className="text-[11px] text-muted-foreground">Pending</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-primary/20 inline-block" />
            <span className="text-[11px] text-muted-foreground">Holiday</span>
          </div>
          {data && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              {data.team_members.length} team members · {data.holidays.length}{" "}
              holidays
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ManagerLeaveManagement;
