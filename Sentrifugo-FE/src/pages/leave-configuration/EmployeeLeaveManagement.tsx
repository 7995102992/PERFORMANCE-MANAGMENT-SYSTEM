import {
  useState,
  useMemo,
  useRef,
  useCallback,
  useEffect,
  Fragment,
} from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Calendar,
  FileText,
  Info,
  ArrowRight,
  X,
  List as ListIcon,
  ChevronDown,
  ArrowLeft,
  Zap,
  Paperclip,
  UploadCloud,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Loader2,
  AlertCircle,
  History,
  XCircle,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { LeaveUsageWarning } from "@/components/shared/LeaveUsageWarning";
import { ORG_TIME_ZONE, parseApiDate } from "@/lib/utils";

import {
  useGetMyLeaveRequestsQuery,
  useGetLeaveRequestQuery,
  useCreateLeaveRequestMutation,
  useUpdateLeaveRequestMutation,
  useCancelLeaveRequestMutation,
  useGetLeaveTypesQuery,
  useGetEligibleLeaveTypesQuery,
  useGetLeaveBalancesQuery,
  useLazyGetLeaveBalanceEstimateQuery,
  useUploadAssetMutation,
  useGetMyApprovalChainQuery,
  useGetMyCalendarQuery,
  useGetEmployeeWorkCalendarQuery,
  useGetResolvedPlanEntitlementQuery,
  useGetLeaveRequestFieldConfigQuery,
  useGetMyPlanLeaveTypeIdsQuery,
} from "@/store/api/lmsApi";
import type { MyCalendarHoliday } from "@/store/api/lmsApi";
import { useGetMyManagersQuery } from "@/store/api/iamApi";
import type {
  LeaveRequestResponse,
  LeaveTypeResponse,
  DurationMode,
  SessionHalf,
  ApprovalTimelineEntry,
} from "@/types/leave";
import { useAppSelector } from "@/store";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { TablePagination } from "@/components/shared/TablePagination";

const getInitials = (name: string | undefined | null): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/** Format an ISO date string to "DD Mon YYYY" for display, in IST */
const formatDateDisplay = (isoDate: string): string => formatDateIST(isoDate);

/** Format an ISO date string to "Mon DD, YYYY" for summary cards, in IST */
const formatDateSummary = (isoDate: string): string => formatDateIST(isoDate);

/** Format an ISO datetime to "Mon DD, HH:MM AM/PM" for timeline display, in IST */
const formatTimelineDate = (iso: string | null): string => {
  if (!iso) return "-";
  return formatDateTimeIST(iso);
};

/** Map API status to display-friendly status */
const mapStatus = (status: LeaveRequestResponse["status"]): string | null => {
  switch (status) {
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "CANCELLED":
      return "Cancelled";
    case "PENDING":
      return "Pending";
    default:
      return null; // unknown status — the row falls back to the day count
  }
};

/** Get leave type name from leave types list */
const getLeaveTypeName = (
  leaveTypeId: string,
  leaveTypes: LeaveTypeResponse[] | undefined,
): string => {
  if (!leaveTypes) return leaveTypeId;
  const found = leaveTypes.find((lt) => lt._id === leaveTypeId);
  return found ? found.name : leaveTypeId;
};

/** Map a LeaveRequestResponse to the shape used by the existing UI table rows */
const mapLeaveRequestToRow = (
  req: LeaveRequestResponse,
  leaveTypes: LeaveTypeResponse[] | undefined,
) => ({
  id: req._id,
  type: getLeaveTypeName(req.leave_type_id, leaveTypes),
  reason: req.reason,
  from: formatDateDisplay(req.start_date),
  to: formatDateDisplay(req.end_date),
  days: String(req.duration_days ?? 0),
  status: mapStatus(req.status),
  appliedOn: formatDateDisplay(req.created_on),
  // Keep raw data for detail view
  _raw: req,
});
const EmployeeLeaveManagement = () => {
  const user = useAppSelector((s) => s.auth.user);
  const employeeId = user?.id ?? "";
  const orgId = user?.organisation_id ?? "";
  const search = useSearch({ strict: false }) as {
    view?: "all" | "detail";
    leaveId?: string;
    from?: "all";
    new?: string;
  };
  const navigate = useNavigate();
  const ROUTE = "/leave-management/employee-leave-management" as any;

  const showAllLeaves = search.view === "all";

  const [allLeavesViewMode, setAllLeavesViewMode] = useState<
    "list" | "calendar"
  >("list");
  const [currentMonthDate, setCurrentMonthDate] = useState(() => new Date());
  const [filterStatus, setFilterStatus] = useState<string | undefined>(
    "PENDING",
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    setPage(1);
  }, [filterStatus]);

  // Calendar date-selection dialog (click / drag-to-select)
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false);
  const [calendarFrom, setCalendarFrom] = useState<Date | undefined>(undefined);
  const [calendarTo, setCalendarTo] = useState<Date | undefined>(undefined);

  useEffect(() => {
    if (search.new === "true") {
      setCalendarDialogOpen(true);
      navigate({ to: ROUTE, search: {} } as any);
    }
  }, [search.new]);
  const calDragRef = useRef<{
    active: boolean;
    start: string | null;
    end: string | null;
  }>({ active: false, start: null, end: null });
  const [calDragRange, setCalDragRange] = useState<{
    start: string | null;
    end: string | null;
  }>({ start: null, end: null });

  const setShowAllLeaves = (val: boolean) => {
    navigate({ to: ROUTE, search: val ? { view: "all" } : {} } as any);
  };

  const openLeaveDetail = (leave: any, fromView?: "all") => {
    navigate({
      to: ROUTE,
      search: {
        view: "detail",
        leaveId: leave.id,
        ...(fromView ? { from: fromView } : {}),
      },
    } as any);
  };

  const closeLeaveDetail = () => {
    navigate({
      to: ROUTE,
      search: search.from === "all" ? { view: "all" } : {},
    } as any);
  };

  // API hooks
  const {
    data: leaveRequestsRaw,
    isLoading: isLoadingLeaves,
    isError: isErrorLeaves,
  } = useGetMyLeaveRequestsQuery({
    ...(filterStatus ? { status: filterStatus } : {}),
    page,
    page_size: pageSize,
  });
  const { data: leaveTypesData } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId,
  });
  const { data: leaveBalancesData, isLoading: isLoadingBalances } =
    useGetLeaveBalancesQuery();
  // Allowlist of leave types mapped to this employee's assigned plan. A null
  // `typeIds` means "no plan resolved / plan maps nothing" — in that case we
  // don't filter, so a missing plan assignment never hides everything.
  const { data: planTypes } = useGetMyPlanLeaveTypeIdsQuery(
    { userId: employeeId, orgId },
    { skip: !employeeId || !orgId },
  );
  const planLeaveTypeIds = planTypes?.typeIds ?? null;

  // The backend rejects every submit in these two states (NO_LEAVE_PLAN /
  // LEAVE_TYPE_NOT_IN_PLAN), so warn up front rather than after the form is
  // filled. `error` is transient and intentionally not surfaced.
  const planWarning =
    planTypes?.reason === "no_plan"
      ? "No leave plan is assigned to you yet, so leave requests can't be submitted. Please contact HR."
      : planTypes?.reason === "no_types"
        ? "Your leave plan has no leave types configured, so leave requests can't be submitted. Please contact HR."
        : null;
  const [cancelLeaveRequest, cancelLeaveRequestResult] =
    useCancelLeaveRequestMutation();
  const confirm = useConfirm();

  // Calendar data (leaves + holidays) via unified API
  const calendarDateRange = useMemo(() => {
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth();
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDate = new Date(year, month, 1 - firstDayOfWeek);
    const totalCells = firstDayOfWeek + daysInMonth <= 35 ? 35 : 42;
    const endDate = new Date(year, month, 1 - firstDayOfWeek + totalCells - 1);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { from: fmt(startDate), to: fmt(endDate) };
  }, [currentMonthDate]);

  const { data: myCalendarData } = useGetMyCalendarQuery(calendarDateRange);

  // Weekoffs from work calendar — single call resolves the employee's assigned calendar
  const { data: employeeWorkCalendar } = useGetEmployeeWorkCalendarQuery(
    employeeId ?? "",
    { skip: !employeeId },
  );
  const weekendMatrix = employeeWorkCalendar?.weekend_matrix ?? null;

  const holidaysByDate = useMemo(() => {
    const map = new Map<string, MyCalendarHoliday[]>();
    const holidays = myCalendarData?.holidays ?? [];
    for (const h of holidays) {
      const dateStr = typeof h.date === "string" ? h.date : String(h.date);
      const key = dateStr.split("T")[0];
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(h);
    }
    return map;
  }, [myCalendarData?.holidays]);

  const isWeekoff = useCallback(
    (dateStr: string) => {
      if (!weekendMatrix) return false;
      const [y, m, d] = dateStr.split("-").map(Number);
      const jsDay = new Date(y, m - 1, d).getDay();
      const matrixDayIndex = (jsDay + 6) % 7; // 0=Mon...6=Sun
      const weekOfMonth = String(Math.min(Math.ceil(d / 7), 5));
      const weekPattern = weekendMatrix[weekOfMonth];
      if (!weekPattern) return false;
      // Matrix convention: 1=working, 0=off (matches DEFAULT_MATRIX [1,1,1,1,1,0,0])
      return weekPattern[matrixDayIndex] === 0;
    },
    [weekendMatrix],
  );

  // Map API responses to existing UI data shape
  const leaveTypes = Array.isArray(leaveTypesData) ? leaveTypesData : [];

  const leavesData = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = leaveRequestsRaw as any;
    const requests: LeaveRequestResponse[] = Array.isArray(raw)
      ? raw
      : (raw?.items ?? []);
    return requests.map((req) => mapLeaveRequestToRow(req, leaveTypes));
  }, [leaveRequestsRaw, leaveTypes]);

  // A deep link from a notification email can name a leave that isn't in the
  // loaded page — the list defaults to the PENDING filter, so an approval /
  // rejection / cancellation mail points at a row that was filtered out. Fetch
  // that one by id instead of showing an empty detail view.
  const deepLinkLeaveId =
    search.view === "detail" && search.leaveId ? search.leaveId : "";
  const deepLinkInList = leavesData.some((l) => l.id === deepLinkLeaveId);
  const { data: deepLinkLeave } = useGetLeaveRequestQuery(deepLinkLeaveId, {
    skip: !deepLinkLeaveId || deepLinkInList,
  });

  const selectedLeaveDetail = useMemo(() => {
    if (search.view !== "detail" || !search.leaveId) return null;
    const fromList = leavesData.find((l) => l.id === search.leaveId);
    if (fromList) return fromList;
    if (deepLinkLeave && deepLinkLeave._id === search.leaveId) {
      return mapLeaveRequestToRow(deepLinkLeave, leaveTypes);
    }
    return null;
  }, [search.view, search.leaveId, leavesData, deepLinkLeave, leaveTypes]);

  // Counts come from the API (unaffected by `status` filter) — see
  // contract for /leave-requests/me.
  const statCards = useMemo(() => {
    const counts = leaveRequestsRaw?.counts ?? {
      all: 0,
      pending: 0,
      approved: 0,
      cancelled: 0,
      rejected: 0,
    };
    return [
      {
        label: "All Requests",
        value: String(counts.all),
        icon: FileText,
        status: undefined as string | undefined,
      },
      {
        label: "Pending Requests",
        value: String(counts.pending),
        icon: History,
        status: "PENDING",
      },
      {
        label: "Approved",
        value: String(counts.approved),
        icon: CheckCircle2,
        status: "APPROVED",
      },
      {
        label: "Cancelled",
        value: String(counts.cancelled),
        icon: AlertCircle,
        status: "CANCELLED",
      },
      {
        label: "Rejected",
        value: String(counts.rejected),
        icon: XCircle,
        status: "REJECTED",
      },
    ];
  }, [leaveRequestsRaw]);

  // Pending leave requests for the summary view
  const pendingLeaves = useMemo(() => {
    return leavesData.filter((l) => l._raw.status === "PENDING");
  }, [leavesData]);

  // Leave balance cards from /leave-requests/balances, left in the order the
  // endpoint returns them — the backend-owned display order (leave type
  // `rank`), the same order as the apply dropdown. Not re-sorted by remaining
  // balance, so a card doesn't move around as leave is taken.
  // The endpoint returns every org leave type, so narrow it to the types mapped
  // to this employee's plan (no-op when no plan resolves).
  const balanceCards = useMemo(() => {
    const allowed = planLeaveTypeIds ? new Set(planLeaveTypeIds) : null;
    return (leaveBalancesData?.balances ?? [])
      .filter((b) => !allowed || allowed.has(b.leave_type_id))
      .map((b) => ({
        typeName: b.leave_type_name,
        typeCode: b.leave_type_code,
        available: b.available_days,
        availableHours: b.available_hours,
        onHold: b.on_hold_days ?? 0,
        unit: b.unit,
        _raw: b,
      }));
  }, [leaveBalancesData, planLeaveTypeIds]);

  const handleWithdraw = useCallback(
    (leaveId: string) => {
      confirm({
        title: "Withdraw this leave request?",
        description:
          "This will cancel the pending leave request. This action cannot be undone.",
        confirmText: "Withdraw",
        cancelText: "Keep request",
        variant: "destructive",
        onConfirm: async () => {
          try {
            await cancelLeaveRequest(leaveId).unwrap();
            toast.success("Leave request withdrawn");
          } catch (err) {
            toast.error(err, "Failed to withdraw leave request");
          }
        },
      });
    },
    [cancelLeaveRequest, confirm],
  );

  // Helpers for calendar click / drag-to-select
  const handleLeaveDialogChange = (open: boolean) => {
    setCalendarDialogOpen(open);
    if (!open) {
      setCalendarFrom(undefined);
      setCalendarTo(undefined);
    }
  };

  const onCalCellMouseDown = (dateStr: string) => (e: React.MouseEvent) => {
    if (getBlockedReason(dateStr)) return;
    e.preventDefault();
    calDragRef.current = { active: true, start: dateStr, end: dateStr };
    setCalDragRange({ start: dateStr, end: dateStr });
  };

  const onCalCellMouseEnter = (dateStr: string) => () => {
    if (!calDragRef.current.active) return;
    calDragRef.current.end = dateStr;
    setCalDragRange((prev) => ({ ...prev, end: dateStr }));
  };

  const onCalCellMouseUp = (dateStr: string) => () => {
    if (!calDragRef.current.active) return;
    const { start, end } = calDragRef.current;
    calDragRef.current = { active: false, start: null, end: null };
    setCalDragRange({ start: null, end: null });
    if (start) {
      const parse = (s: string) => {
        const [y, m, d] = s.split("-").map(Number);
        return new Date(y, m - 1, d);
      };
      const es = end ?? start;
      const a = parse(start),
        b = parse(es);
      setCalendarFrom(a <= b ? a : b);
      setCalendarTo(a <= b ? b : a);
      setCalendarDialogOpen(true);
    }
  };

  const isInCalDrag = (dateStr: string) => {
    if (!calDragRange.start || !calDragRange.end) return false;
    const [a, b] = [calDragRange.start, calDragRange.end].sort();
    return dateStr >= a && dateStr <= b;
  };

  // Global mouseup: finalize drag if released outside a calendar cell
  useEffect(() => {
    const handler = () => {
      if (!calDragRef.current.active) return;
      const { start, end } = calDragRef.current;
      calDragRef.current = { active: false, start: null, end: null };
      setCalDragRange({ start: null, end: null });
      if (start) {
        const parse = (s: string) => {
          const [y, m, d] = s.split("-").map(Number);
          return new Date(y, m - 1, d);
        };
        const es = end ?? start;
        const a = parse(start),
          b = parse(es);
        setCalendarFrom(a <= b ? a : b);
        setCalendarTo(a <= b ? b : a);
        setCalendarDialogOpen(true);
      }
    };
    document.addEventListener("mouseup", handler);
    return () => document.removeEventListener("mouseup", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const leavesByDate = useMemo(() => {
    const map = new Map<
      string,
      { type: string; status: string | null; reason: string | undefined }[]
    >();
    const calLeaves = myCalendarData?.leaves ?? [];
    for (const leave of calLeaves) {
      if (leave.status === "CANCELLED") continue;
      const startDate = leave.start_date.split("T")[0];
      const endDate = leave.end_date.split("T")[0];
      const mapped = {
        type: leave.leave_type_name ?? leave.leave_type_id,
        status:
          leave.status === "APPROVED"
            ? "Approved"
            : leave.status === "REJECTED"
              ? "Rejected"
              : leave.status === "CANCELLED"
                ? "Cancelled"
                : null,
        reason: leave.reason ?? undefined,
      };
      const start = new Date(startDate);
      const end = new Date(endDate);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(mapped);
      }
    }
    return map;
  }, [myCalendarData?.leaves]);

  const getLeavesForDate = useCallback(
    (dateStr: string) => leavesByDate.get(dateStr) ?? [],
    [leavesByDate],
  );

  const getBlockedReason = useCallback(
    (dateStr: string): string | null => {
      if (isWeekoff(dateStr)) return "Week off — cannot apply for leave";
      const holidays = holidaysByDate.get(dateStr);
      if (holidays?.length)
        return `Holiday (${holidays[0].name}) — cannot apply for leave`;
      if ((leavesByDate.get(dateStr) ?? []).length > 0)
        return "Leave already applied for this date";
      return null;
    },
    [isWeekoff, holidaysByDate, leavesByDate],
  );

  if (isLoadingLeaves) {
    return (
      <div className="flex items-center justify-center w-full h-full p-6 bg-muted">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground font-medium">
            Loading leave data...
          </span>
        </div>
      </div>
    );
  }

  if (isErrorLeaves) {
    return (
      <EmptyState
        variant="error"
        icon={AlertCircle}
        title="Failed to load leave data"
        description="Please try again later."
      />
    );
  }

  if (selectedLeaveDetail) {
    return (
      <LeaveDetailsView leave={selectedLeaveDetail} onBack={closeLeaveDetail} />
    );
  }

  if (showAllLeaves) {
    return (
      <div className="flex flex-col w-full h-full p-6 bg-background overflow-auto gap-8">
        <div
          className="flex items-center text-sm font-semibold text-primary cursor-pointer hover:underline -mb-2"
          onClick={() => setShowAllLeaves(false)}
        >
          <ArrowLeft size={16} /> Back to Summary
        </div>

        {/* Top Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {statCards.map((stat, idx) => {
            const isActive = filterStatus === stat.status;
            const Icon = stat.icon;
            return (
              <div
                key={idx}
                onClick={() => setFilterStatus(stat.status)}
                className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${isActive ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/50"}`}
              >
                <div>
                  <p className="text-xs text-muted-foreground font-medium">
                    {stat.label}
                  </p>
                  <p className="text-2xl font-bold text-foreground tabular-nums">
                    {stat.value}
                  </p>
                </div>
                <Icon className="size-8 shrink-0 text-muted-foreground" />
              </div>
            );
          })}
        </div>

        <div className="flex flex-col w-full">
          {/* Table Header Controls */}
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-2xl font-bold text-foreground">
              {filterStatus
                ? `My ${filterStatus.charAt(0) + filterStatus.slice(1).toLowerCase()} Leave`
                : "My Leave"}
            </h1>

            <div className="flex self-end border border-border rounded-md overflow-x-auto bg-card shadow-sm">
              <Button
                variant="ghost"
                onClick={() => setAllLeavesViewMode("list")}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-none transition-colors ${allLeavesViewMode === "list" ? "bg-[var(--btn-soft)] text-[var(--btn-soft-fg)] hover:bg-[var(--btn-soft)] hover:text-[var(--btn-soft-fg)]" : "text-muted-foreground hover:bg-muted"}`}
              >
                <ListIcon size={16} /> List View
              </Button>
              <Button
                variant="ghost"
                onClick={() => setAllLeavesViewMode("calendar")}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-none transition-colors ${allLeavesViewMode === "calendar" ? "bg-[var(--btn-soft)] text-[var(--btn-soft-fg)] hover:bg-[var(--btn-soft)] hover:text-[var(--btn-soft-fg)]" : "text-muted-foreground hover:bg-muted"}`}
              >
                Calendar View
              </Button>
            </div>
          </div>

          {/* Data Presentation */}
          {allLeavesViewMode === "list" ? (
            <div className="w-full rounded-xl border overflow-x-auto bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[18%] pl-6">
                      Leave Type
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[22%]">
                      Reason
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[15%]">
                      <span className="flex items-center gap-1 cursor-pointer">
                        From Date <ChevronDown size={14} />
                      </span>
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[15%]">
                      <span className="flex items-center gap-1 cursor-pointer">
                        To Date <ChevronDown size={14} />
                      </span>
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[15%]">
                      <span className="flex items-center gap-1 cursor-pointer">
                        Status <ChevronDown size={14} />
                      </span>
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[15%]">
                      <span className="flex items-center gap-1 cursor-pointer">
                        Applied On <ChevronDown size={14} />
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leavesData.map((row, i) => (
                    <TableRow
                      key={i}
                      onClick={() => openLeaveDetail(row, "all")}
                      className="border-b border-border last:border-0 hover:bg-muted cursor-pointer"
                    >
                      <TableCell className="pl-6 font-medium text-muted-foreground py-4">
                        {row.type}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.from}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.to}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-medium">
                        <div className="flex items-center gap-2">
                          {row.status ? (
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold
                              ${row.status === "Rejected" ? "bg-badge-inactive-bg text-badge-inactive-text" : ""}
                              ${row.status === "Cancelled" ? "bg-primary/10 text-primary" : ""}
                              ${row.status === "Approved" ? "bg-badge-active-bg text-badge-active-text" : ""}
                              ${row.status === "Pending" ? "bg-badge-pending-bg text-badge-pending-text" : ""}
                            `}
                            >
                              {row.status}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {row.days}
                            </span>
                          )}
                          {row._raw.aging_status === "overdue" && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-destructive/10 text-destructive">
                              Overdue
                              {typeof row._raw.days_pending === "number"
                                ? ` · ${row._raw.days_pending}d`
                                : ""}
                            </span>
                          )}
                          {row._raw.aging_status === "due_soon" && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-warning/10 text-warning">
                              Due soon
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.appliedOn}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(() => {
                const total = leaveRequestsRaw?.total ?? 0;
                const totalPages = leaveRequestsRaw?.total_pages ?? 1;
                const startIndex = total === 0 ? 0 : (page - 1) * pageSize + 1;
                const endIndex = Math.min(page * pageSize, total);
                return (
                  <TablePagination
                    currentPage={page}
                    totalPages={totalPages}
                    startIndex={startIndex}
                    endIndex={endIndex}
                    total={total}
                    pageSize={pageSize}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => {
                      setPageSize(size);
                      setPage(1);
                    }}
                  />
                );
              })()}
            </div>
          ) : (
            <div className="w-full bg-card border border-border rounded-xl overflow-x-auto">
              <div className="flex justify-between items-center px-4 py-3 border-b">
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setCurrentMonthDate(
                        (prev) =>
                          new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
                      )
                    }
                    className="size-8"
                  >
                    <ChevronLeft />
                  </Button>
                  <h2 className="text-sm font-semibold text-foreground text-center min-w-[130px]">
                    {currentMonthDate.toLocaleString("default", {
                      month: "long",
                    })}{" "}
                    {currentMonthDate.getFullYear()}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setCurrentMonthDate(
                        (prev) =>
                          new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
                      )
                    }
                    className="size-8"
                  >
                    <ChevronRight />
                  </Button>
                </div>
                <div className="flex border border-border rounded-xl overflow-x-auto text-sm font-medium">
                  <Button
                    variant="ghost"
                    onClick={() => setCurrentMonthDate(new Date())}
                    className="px-4 py-1.5 rounded-none bg-card text-muted-foreground border-r border-border hover:bg-muted h-auto text-xs"
                  >
                    Today
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-4 py-1.5 rounded-none bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary h-auto text-xs"
                  >
                    Month
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-4 py-1.5 rounded-none bg-card text-muted-foreground hover:bg-muted h-auto text-xs"
                  >
                    Year
                  </Button>
                </div>
              </div>

              <div>
                <div className="grid grid-cols-7 border-b border-table-border bg-table-header">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                    (day) => (
                      <div
                        key={day}
                        className="border-r border-table-border px-3 py-2.5 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
                      >
                        {day}
                      </div>
                    ),
                  )}
                </div>
                <TooltipProvider>
                  <div className="grid grid-cols-7 text-sm">
                    {calendarGrid.map((cell, i) => {
                      const cellLeaves = getLeavesForDate(cell.dateStr);
                      const cellHolidays =
                        holidaysByDate.get(cell.dateStr) ?? [];
                      const cellIsWeekoff =
                        cell.isCurrentMonth && isWeekoff(cell.dateStr);
                      const blockedReason = cell.isCurrentMonth
                        ? getBlockedReason(cell.dateStr)
                        : null;
                      const isRightEdge = (i + 1) % 7 === 0;
                      const borderClasses = `border-b ${!isRightEdge ? "border-r" : ""} border-table-border`;

                      const cellContent = (
                        <div
                          className={`min-h-[100px] p-2 ${borderClasses} ${isInCalDrag(cell.dateStr) ? "bg-primary/10" : cellIsWeekoff ? "bg-muted" : !cell.isCurrentMonth ? "bg-muted/20" : ""} relative ${blockedReason ? "cursor-not-allowed" : "cursor-pointer"} select-none`}
                          onMouseDown={onCalCellMouseDown(cell.dateStr)}
                          onMouseEnter={onCalCellMouseEnter(cell.dateStr)}
                          onMouseUp={onCalCellMouseUp(cell.dateStr)}
                        >
                          <div className="flex justify-end">
                            <span
                              className={`flex size-6 items-center justify-center rounded-full bg-table-header text-xs font-medium ${!cell.isCurrentMonth ? "text-muted-foreground/40" : "text-muted-foreground"}`}
                            >
                              {cell.day}
                            </span>
                          </div>
                          {cellIsWeekoff && (
                            <div className="text-[9px] font-semibold text-muted-foreground/50 uppercase leading-tight">
                              WO
                            </div>
                          )}
                          {cellHolidays.map((h, idx) => (
                            <div
                              key={`h-${idx}`}
                              className="mt-1 flex items-center gap-1"
                            >
                              <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                              <span className="truncate text-[11px] font-medium text-foreground leading-tight">
                                {h.name}
                              </span>
                            </div>
                          ))}
                          {cellLeaves.map((leave, idx) => {
                            const dotClass =
                              leave.status === "Approved"
                                ? "bg-success"
                                : leave.status === "Rejected"
                                  ? "bg-destructive"
                                  : leave.status === "Cancelled"
                                    ? "bg-muted-foreground/50"
                                    : "bg-info";

                            return (
                              <div
                                key={idx}
                                className="mt-1 flex items-center gap-1"
                              >
                                <span
                                  className={`size-1.5 shrink-0 rounded-full ${dotClass}`}
                                />
                                <span
                                  className="truncate text-[11px] text-muted-foreground leading-tight"
                                  title={leave.reason}
                                >
                                  {leave.type}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                      return blockedReason ? (
                        <Tooltip key={cell.dateStr}>
                          <TooltipTrigger asChild>{cellContent}</TooltipTrigger>
                          <TooltipContent side="top">
                            {blockedReason}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <Fragment key={cell.dateStr}>{cellContent}</Fragment>
                      );
                    })}
                  </div>
                </TooltipProvider>
              </div>

              <div className="flex items-center justify-center gap-4 px-4 py-3 border-t flex-wrap">
                <div className="flex items-center gap-1.5">
                  <div className="size-2 rounded-full bg-info" />
                  <span className="text-xs text-muted-foreground">Pending</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2 rounded-full bg-success" />
                  <span className="text-xs text-muted-foreground">
                    Approved
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2 rounded-full bg-destructive" />
                  <span className="text-xs text-muted-foreground">
                    Rejected
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2 rounded-full bg-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    Cancelled
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2 rounded-full bg-badge-pending-text" />
                  <span className="text-xs text-muted-foreground">Holiday</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-2 rounded bg-muted border border-border" />
                  <span className="text-xs text-muted-foreground">
                    Week Off
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
        <RequestLeavePanel
          open={calendarDialogOpen}
          onOpenChange={handleLeaveDialogChange}
          defaultFromDate={calendarFrom}
          defaultToDate={calendarTo}
        />
      </div>
    );
  }

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

  const actionsWidget = (
    <div className="bg-card border border-border shadow-sm rounded-xl p-4 flex flex-col gap-2">
      <h2 className="text-xs font-bold text-foreground uppercase tracking-wide mb-1">
        Leave Actions
      </h2>
      <RequestLeavePanel
        open={calendarDialogOpen}
        onOpenChange={handleLeaveDialogChange}
        defaultFromDate={calendarFrom}
        defaultToDate={calendarTo}
      >
        <Button className="w-full shadow-sm">
          Request Leave
        </Button>
      </RequestLeavePanel>
      <Button
        onClick={() => setShowAllLeaves(true)}
        variant="outline"
        className="w-full text-primary border-primary/20 hover:bg-primary/5 font-semibold flex items-center justify-center gap-2"
      >
        View All Leaves <ArrowRight size={15} />
      </Button>
    </div>
  );

  // Hidden entirely when there's nothing pending — the remaining widgets
  // (Leave Balance) expand to take the freed space.
  const pendingWidget =
    pendingLeaves.length === 0 ? null : (
      <div className="flex-1 min-h-0 bg-card border border-border shadow-sm rounded-xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between flex-shrink-0">
          <h2 className="text-xs font-bold text-foreground uppercase tracking-wide">
            Pending Requests
          </h2>
          <span className="bg-badge-pending-bg text-badge-pending-text text-[10px] font-bold px-2 py-0.5 rounded-full">
            {pendingLeaves.length}
          </span>
        </div>
        <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
          {pendingLeaves.map((leave) => {
            const startD = new Date(leave._raw.start_date);
            const endD = new Date(leave._raw.end_date);
            const dateRange =
              startD.toDateString() === endD.toDateString()
                ? `${months[startD.getMonth()]} ${startD.getDate()}`
                : `${months[startD.getMonth()]} ${startD.getDate()}–${endD.getDate()}`;
            return (
              <div
                key={leave.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 hover:bg-muted/50 transition-colors flex-shrink-0"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold text-foreground truncate">
                    {leave.type}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {dateRange} · {leave._raw.duration_days ?? 0}d
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    className="text-[10px] font-semibold text-primary hover:underline"
                    onClick={() => openLeaveDetail(leave)}
                  >
                    View
                  </button>
                  <button
                    onClick={() => handleWithdraw(leave.id)}
                    disabled={cancelLeaveRequestResult.isLoading}
                    className="w-5 h-5 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center hover:bg-destructive/20 disabled:opacity-50"
                  >
                    <X size={10} className="text-destructive" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );

  const balanceWidget = (
    <div className="flex-1 min-h-0 bg-card border border-border shadow-sm rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-shrink-0">
        <h2 className="text-xs font-bold text-foreground uppercase tracking-wide">
          Leave Balance
        </h2>
        {balanceCards.length > 0 && (
          <span className="text-[9px] text-muted-foreground uppercase tracking-wide">
            Available
          </span>
        )}
      </div>
      {isLoadingBalances ? (
        <div className="flex items-center justify-center gap-2 py-4">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Loading...</span>
        </div>
      ) : balanceCards.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          No balances found.
        </p>
      ) : (
        <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-1">
          {balanceCards.map((card) => (
            <div
              key={card._raw.leave_type_id}
              className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 flex-shrink-0"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[9px] font-extrabold text-primary bg-primary/10 rounded px-1 py-0.5 shrink-0">
                  {card.typeCode}
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium text-foreground truncate">
                    {card.typeName}
                  </span>
                  {card.onHold > 0 && (
                    <span className="text-[9px] font-medium text-warning">
                      {card.onHold} on hold
                    </span>
                  )}
                </div>
              </div>
              <span className="text-sm font-bold text-foreground tabular-nums shrink-0">
                {card.available}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col w-full h-[calc(100svh-7rem)] p-4 sm:p-6 overflow-hidden gap-4 font-sans">
      {planWarning && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 flex-shrink-0">
          <AlertCircle className="size-4 shrink-0 text-warning mt-0.5" />
          <p className="text-xs text-foreground">{planWarning}</p>
        </div>
      )}

      {/* KPI cards — click drills into the filtered all-leaves list */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 flex-shrink-0">
        {statCards.map((stat, idx) => {
          const Icon = stat.icon;
          return (
            <div
              key={idx}
              onClick={() => {
                setFilterStatus(stat.status);
                setShowAllLeaves(true);
              }}
              className="flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors bg-card hover:bg-muted/50"
            >
              <div>
                <p className="text-xs text-muted-foreground font-medium">
                  {stat.label}
                </p>
                <p className="text-2xl font-bold text-foreground tabular-nums">
                  {stat.value}
                </p>
              </div>
              <Icon className="size-8 shrink-0 text-muted-foreground" />
            </div>
          );
        })}
      </div>

      {/* 75 / 25 layout — fills remaining height */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-5 flex-1 min-h-0">
        {/* LEFT — Calendar (75%) — fills full height */}
        <Card className="shadow-sm border-border overflow-hidden flex flex-col py-0 gap-0">
          <CardContent className="flex flex-col flex-1 min-h-0 p-4 bg-card gap-3">
            {/* Calendar grid — expands to fill remaining card height */}
            <div className="flex flex-col flex-1 min-h-0 border border-border rounded-xl overflow-x-auto bg-card">
              {/* Calendar header */}
              <div className="flex justify-between items-center flex-shrink-0 px-4 py-3 border-b">
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() =>
                      setCurrentMonthDate(
                        (prev) =>
                          new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
                      )
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <h3 className="text-sm font-semibold text-foreground min-w-[130px] text-center">
                    {currentMonthDate.toLocaleString("default", {
                      month: "long",
                    })}{" "}
                    {currentMonthDate.getFullYear()}
                  </h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() =>
                      setCurrentMonthDate(
                        (prev) =>
                          new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
                      )
                    }
                  >
                    <ChevronRight />
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => setCurrentMonthDate(new Date())}
                  className="px-3 py-1 text-xs font-medium text-muted-foreground border border-border rounded-md hover:bg-muted h-auto"
                >
                  Today
                </Button>
              </div>

              <div className="grid grid-cols-7 border-b border-table-border bg-table-header flex-shrink-0">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                  (day) => (
                    <div
                      key={day}
                      className="border-r border-table-border px-3 py-2.5 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
                    >
                      {day}
                    </div>
                  ),
                )}
              </div>
              <TooltipProvider>
                <div
                  className="grid grid-cols-7 text-sm flex-1 min-h-0"
                  style={{ gridAutoRows: "1fr" }}
                >
                  {calendarGrid.map((cell, i) => {
                    const cellLeaves = getLeavesForDate(cell.dateStr);
                    const cellHolidays = holidaysByDate.get(cell.dateStr) ?? [];
                    const cellIsWeekoff =
                      cell.isCurrentMonth && isWeekoff(cell.dateStr);
                    const blockedReason = cell.isCurrentMonth
                      ? getBlockedReason(cell.dateStr)
                      : null;
                    const isRightEdge = (i + 1) % 7 === 0;
                    const cellContent = (
                      <div
                        className={`overflow-hidden border-b p-2 ${!isRightEdge ? "border-r" : ""} border-table-border ${isInCalDrag(cell.dateStr) ? "bg-primary/10" : cellIsWeekoff ? "bg-muted" : !cell.isCurrentMonth ? "bg-muted/20" : ""} ${blockedReason ? "cursor-not-allowed" : "cursor-pointer"} select-none`}
                        onMouseDown={onCalCellMouseDown(cell.dateStr)}
                        onMouseEnter={onCalCellMouseEnter(cell.dateStr)}
                        onMouseUp={onCalCellMouseUp(cell.dateStr)}
                      >
                        <div className="flex justify-end">
                          <span
                            className={`flex size-6 items-center justify-center rounded-full bg-table-header text-xs font-medium ${!cell.isCurrentMonth ? "text-muted-foreground/40" : "text-muted-foreground"}`}
                          >
                            {cell.day}
                          </span>
                        </div>
                        {cellIsWeekoff && (
                          <div className="text-[9px] font-semibold text-muted-foreground/50 uppercase leading-tight">
                            WO
                          </div>
                        )}
                        {cellHolidays.map((h, idx) => (
                          <div
                            key={`h-${idx}`}
                            className="mt-1 flex items-center gap-1"
                          >
                            <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                            <span className="truncate text-[11px] font-medium text-foreground leading-tight">
                              {h.name}
                            </span>
                          </div>
                        ))}
                        {cellLeaves.map((leave, idx) => {
                          const dotClass =
                            leave.status === "Approved"
                              ? "bg-success"
                              : leave.status === "Rejected"
                                ? "bg-destructive"
                                : leave.status === "Cancelled"
                                  ? "bg-muted-foreground/50"
                                  : "bg-info";
                          return (
                            <div
                              key={idx}
                              className="mt-1 flex items-center gap-1"
                            >
                              <span
                                className={`size-1.5 shrink-0 rounded-full ${dotClass}`}
                              />
                              <span className="truncate text-[11px] text-muted-foreground leading-tight">
                                {leave.type}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                    return blockedReason ? (
                      <Tooltip key={cell.dateStr}>
                        <TooltipTrigger asChild>{cellContent}</TooltipTrigger>
                        <TooltipContent side="top">
                          {blockedReason}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Fragment key={cell.dateStr}>{cellContent}</Fragment>
                    );
                  })}
                </div>
              </TooltipProvider>
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-4 flex-shrink-0 flex-wrap">
              {[
                ["bg-info", "Pending"],
                ["bg-success", "Approved"],
                ["bg-destructive", "Rejected"],
                ["bg-muted-foreground/50", "Cancelled"],
              ].map(([colorClass, label]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className={`size-2 rounded-full ${colorClass}`} />
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <div className="size-2 rounded-full bg-warning" />
                <span className="text-xs text-muted-foreground">Holiday</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="size-2 rounded bg-muted border border-border" />
                <span className="text-xs text-muted-foreground">Week Off</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* RIGHT — Widgets (25%) — full height */}
        <div className="flex flex-col gap-4 min-h-0 h-full">
          {actionsWidget}
          {pendingWidget}
          {balanceWidget}
        </div>
      </div>
    </div>
  );
};

export default EmployeeLeaveManagement;

const SESSION_LABELS: Record<string, string> = {
  FIRST_HALF: "First Half",
  SECOND_HALF: "Second Half",
};

/**
 * The Approvals block in RequestLeavePanel stays hidden until the manager API
 * is ready. Annotated `boolean` rather than left as a `false` literal so the
 * block reads as reachable to the type-checker: inside a statically-false
 * branch TS drops narrowing entirely and every optional access in there is
 * reported as possibly-null, even ones guarded a line earlier.
 */
const SHOW_APPROVAL_CHAIN: boolean = false;

const RequestLeavePanel = ({
  children,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  defaultFromDate,
  defaultToDate,
  editRequest,
}: {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  defaultFromDate?: Date;
  defaultToDate?: Date;
  editRequest?: LeaveRequestResponse | null;
}) => {
  const user = useAppSelector((s) => s.auth.user);
  const employeeId = user?.id ?? "";
  const orgId = user?.organisation_id ?? "";

  // Date state
  // Default to today at MIDNIGHT. `new Date()` carries the current time, which
  // makes today's calendar cell (midnight) compare as "before" fromDate in the
  // To-picker's `d < fromDate` check — greying today out of the To picker.
  const midnightToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const [fromDate, setFromDate] = useState<Date | undefined>(midnightToday);
  const [toDate, setToDate] = useState<Date | undefined>(midnightToday);
  const [isFromOpen, setIsFromOpen] = useState(false);
  const [isToOpen, setIsToOpen] = useState(false);

  // Duration mode state
  const [durationMode, setDurationMode] = useState<DurationMode>("FULL_DAYS");
  const [halfDayPeriod, setHalfDayPeriod] = useState<SessionHalf>("FIRST_HALF");

  // Custom session state
  const [fromDateCustom, setFromDateCustom] = useState<Date | undefined>(
    midnightToday,
  );
  const [toDateCustom, setToDateCustom] = useState<Date | undefined>(
    midnightToday,
  );
  const [isFromCustomOpen, setIsFromCustomOpen] = useState(false);
  const [isToCustomOpen, setIsToCustomOpen] = useState(false);
  const [startSession, setStartSession] = useState<SessionHalf>("FIRST_HALF");
  const [endSession, setEndSession] = useState<SessionHalf>("SECOND_HALF");
  const [isStartSessionOpen, setIsStartSessionOpen] = useState(false);
  const [isEndSessionOpen, setIsEndSessionOpen] = useState(false);

  // Leave type selection
  const [selectedLeaveTypeId, setSelectedLeaveTypeId] = useState("");
  const [isLeaveTypeOpen, setIsLeaveTypeOpen] = useState(false);
  const [leaveTypeSearch, setLeaveTypeSearch] = useState("");

  // Form fields
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedAssets, setUploadedAssets] = useState<
    { id: string; name: string }[]
  >([]);
  const [reason, setReason] = useState("");
  // Expiring / comp-off leave: the non-working days the employee worked that this
  // leave compensates (one per requested leave day).
  const [workedDates, setWorkedDates] = useState<Date[]>([]);
  const [isWorkedDatesOpen, setIsWorkedDatesOpen] = useState(false);
  const [lopAcknowledged, setLopAcknowledged] = useState(false);
  const [showChain, setShowChain] = useState(false);
  const [showBalanceProjection, setShowBalanceProjection] = useState(false);

  // Controlled/uncontrolled dialog open state
  const [internalOpen, setInternalOpen] = useState(false);
  const dialogOpen = externalOpen !== undefined ? externalOpen : internalOpen;
  const setDialogOpen = (val: boolean) => {
    if (externalOnOpenChange !== undefined) externalOnOpenChange(val);
    else setInternalOpen(val);
  };

  // Dirty when the user has typed a reason, picked a leave type, or attached files
  const isFormDirty =
    dialogOpen &&
    (reason.trim() !== "" ||
      selectedLeaveTypeId !== "" ||
      uploadedAssets.length > 0);
  useNavigationGuard(isFormDirty);
  const guardedSheetOpenChange = useUnsavedGuard(isFormDirty, setDialogOpen);

  // Sync from/to dates when dialog opens with external defaults
  const defaultFromRef = useRef(defaultFromDate);
  const defaultToRef = useRef(defaultToDate);
  defaultFromRef.current = defaultFromDate;
  defaultToRef.current = defaultToDate;
  const editRequestRef = useRef(editRequest);
  editRequestRef.current = editRequest;
  const prevOpenRef = useRef(false);

  /**
   * Put every field back to the value it had on first mount.
   *
   * The Sheet keeps this component mounted between opens, so without an explicit
   * reset the previous attempt survives: fill the form, cancel, reopen — and the
   * old leave type, reason and attachments are all still there. Worse, closing an
   * EDIT and then opening a NEW request used to inherit the edited request's
   * values, because the open-effect below only populates fields in the edit
   * branch and never clears them in the new-request branch.
   */
  const resetForm = useCallback(() => {
    setFromDate(midnightToday());
    setToDate(midnightToday());
    setFromDateCustom(midnightToday());
    setToDateCustom(midnightToday());
    setDurationMode("FULL_DAYS");
    setHalfDayPeriod("FIRST_HALF");
    setStartSession("FIRST_HALF");
    setEndSession("SECOND_HALF");
    setSelectedLeaveTypeId("");
    setLeaveTypeSearch("");
    setReason("");
    setUploadedAssets([]);
    setWorkedDates([]);
    setLopAcknowledged(false);
    setShowChain(false);
    setShowBalanceProjection(false);
    // Popovers too — a picker left open when the sheet was dismissed would
    // otherwise pop straight back open on the next launch.
    setIsFromOpen(false);
    setIsToOpen(false);
    setIsFromCustomOpen(false);
    setIsToCustomOpen(false);
    setIsStartSessionOpen(false);
    setIsEndSessionOpen(false);
    setIsLeaveTypeOpen(false);
    setIsWorkedDatesOpen(false);
    setIsDragOver(false);
  }, []);

  useEffect(() => {
    // Closing: wipe the form so the next open always starts clean, whichever
    // path (new or edit) opened it.
    if (!dialogOpen && prevOpenRef.current) {
      resetForm();
    }
    if (dialogOpen && !prevOpenRef.current) {
      const er = editRequestRef.current;
      // Opening a NEW request: clear anything a previous edit left behind before
      // the defaults are applied below.
      if (!er) resetForm();
      if (er) {
        const parseLocal = (s: string) => {
          const [y, m, d] = s.split("-").map(Number);
          return new Date(y, m - 1, d);
        };
        const mode = (er.duration_mode ?? "FULL_DAYS") as DurationMode;
        setDurationMode(mode);
        const start = parseLocal(er.start_date);
        const end = parseLocal(er.end_date);
        if (mode === "CUSTOM") {
          setFromDateCustom(start);
          setToDateCustom(end);
          setStartSession((er.start_session as SessionHalf) ?? "FIRST_HALF");
          setEndSession((er.end_session as SessionHalf) ?? "SECOND_HALF");
        } else {
          setFromDate(start);
          setToDate(end);
          if (mode === "HALF_DAY") {
            setHalfDayPeriod(
              (er.half_day_period as SessionHalf) ?? "FIRST_HALF",
            );
          }
        }
        setSelectedLeaveTypeId(er.leave_type_id);
        setReason(er.reason ?? "");
        setWorkedDates(
          (er.worked_dates ?? []).map((s) => {
            const [y, m, d] = s.split("-").map(Number);
            return new Date(y, m - 1, d);
          }),
        );
        setUploadedAssets(
          (er.assets ?? []).map((a) => ({
            id: a.id,
            name: a.original_filename,
          })),
        );
      } else {
        // resetForm() above already cleared everything; only the caller-supplied
        // defaults remain to be applied.
        if (defaultFromRef.current !== undefined)
          setFromDate(defaultFromRef.current);
        if (defaultToRef.current !== undefined) setToDate(defaultToRef.current);
      }
    }
    prevOpenRef.current = dialogOpen;
  }, [dialogOpen, resetForm]);

  // API hooks
  const [createLeaveRequest, createLeaveRequestResult] =
    useCreateLeaveRequestMutation();
  const [updateLeaveRequest, updateLeaveRequestResult] =
    useUpdateLeaveRequestMutation();
  const [uploadAsset, uploadAssetResult] = useUploadAssetMutation();
  const { data: leaveTypesData } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId,
  });
  // Selectable types are the ELIGIBLE ones — the backend drops what this
  // employee is restricted out of by gender / marital status, so Maternity
  // never appears for a man only to be rejected on submit. The full list above
  // is still fetched, for resolving types on existing requests (see
  // `selectedLeaveType`).
  const { data: eligibleLeaveTypesData } = useGetEligibleLeaveTypesQuery(orgId, {
    skip: !orgId,
  });
  const { data: planTypes } = useGetMyPlanLeaveTypeIdsQuery(
    { userId: employeeId, orgId },
    { skip: !employeeId || !orgId },
  );
  const planLeaveTypeIds = planTypes?.typeIds ?? null;
  const { data: myApprovalChain, isFetching: isFetchingChain } =
    useGetMyApprovalChainQuery();
  const { data: myManagers } = useGetMyManagersQuery(
    { userId: employeeId },
    { skip: !employeeId || !dialogOpen },
  );
  const leaveTypes = Array.isArray(leaveTypesData) ? leaveTypesData : [];
  const eligibleLeaveTypes = useMemo(
    () => (Array.isArray(eligibleLeaveTypesData) ? eligibleLeaveTypesData : []),
    [eligibleLeaveTypesData],
  );
  // Only the types mapped to the employee's assigned plan are selectable.
  // `null` (no plan resolved, or plan maps nothing) means show everything, so a
  // missing plan assignment never blocks the employee from requesting leave.
  // Filtering preserves the API's order, which is the backend-owned display
  // order — so no client-side sort is needed here.
  const planLeaveTypes = useMemo(() => {
    if (!planLeaveTypeIds) return eligibleLeaveTypes;
    const allowed = new Set(planLeaveTypeIds);
    return eligibleLeaveTypes.filter((lt) => allowed.has(lt._id));
  }, [eligibleLeaveTypes, planLeaveTypeIds]);

  const filteredLeaveTypes = planLeaveTypes.filter((lt) =>
    lt.name.toLowerCase().includes(leaveTypeSearch.toLowerCase()),
  );

  // Resolved against the FULL list — an edit of an older request may reference a
  // type since removed from the plan, and it still needs its flags (is_comp_off
  // etc) to render correctly.
  const selectedLeaveType = leaveTypes.find(
    (lt) => lt._id === selectedLeaveTypeId,
  );
  const effectiveLeaveTypeId = selectedLeaveTypeId;
  // Expiring / comp-off leave: no balance, full-days only, must point to worked days.
  const isCompOff = !!selectedLeaveType?.is_comp_off;

  // Comp-off is full-days only — force the mode and clear worked days when the
  // selected type is no longer comp-off.
  useEffect(() => {
    if (isCompOff) {
      setDurationMode("FULL_DAYS");
    } else if (workedDates.length) {
      setWorkedDates([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompOff]);

  // Balance estimate — single lazy query replaces both the old balance + estimate hooks
  const [triggerBalanceEstimate, balanceEstimate] =
    useLazyGetLeaveBalanceEstimateQuery();

  // Clearing the form fields is not enough: this lazy query's result lives in the
  // RTK Query store and outlives the sheet, so reopening showed the previous
  // attempt's duration, balance and error banner until a new estimate happened to
  // fire — and with no leave type selected yet, none does. Reset the query itself
  // whenever the sheet closes.
  const resetEstimate = balanceEstimate.reset;
  useEffect(() => {
    if (!dialogOpen) resetEstimate();
  }, [dialogOpen, resetEstimate]);

  const { data: resolvedEntitlement } = useGetResolvedPlanEntitlementQuery(
    { userId: employeeId, orgId },
    { skip: !employeeId || !orgId },
  );

  const { data: fieldConfig } = useGetLeaveRequestFieldConfigQuery(
    { userId: employeeId, orgId },
    { skip: !employeeId || !orgId },
  );

  // ─── Non-working days (weekends + holidays) for date-picker blocking ───
  // Weekend pattern comes from the employee's assigned WORK CALENDAR; public
  // holidays come from the unified calendar endpoint. Both are derived from the
  // backend — weekends are NOT hardcoded.
  const { data: panelWorkCalendar } = useGetEmployeeWorkCalendarQuery(
    employeeId,
    { skip: !employeeId || !dialogOpen },
  );
  const panelWeekendMatrix = panelWorkCalendar?.weekend_matrix ?? null;

  // Holiday window: from one month back to ~13 months ahead, so the picker can
  // block holidays without imposing a calendar-year cap.
  const holidayRange = useMemo(() => {
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear() + 1, now.getMonth() + 1, 0);
    return { from: fmt(start), to: fmt(end) };
  }, []);

  const { data: panelCalendarData } = useGetMyCalendarQuery(holidayRange, {
    skip: !dialogOpen,
  });

  const panelHolidaySet = useMemo(() => {
    const set = new Set<string>();
    for (const h of panelCalendarData?.holidays ?? []) {
      const dateStr = typeof h.date === "string" ? h.date : String(h.date);
      set.add(dateStr.split("T")[0]);
    }
    return set;
  }, [panelCalendarData?.holidays]);

  const dateToKey = useCallback((d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);

  const isPanelWeekoff = useCallback(
    (d: Date) => {
      if (!panelWeekendMatrix) return false;
      const jsDay = d.getDay();
      const matrixDayIndex = (jsDay + 6) % 7; // 0=Mon...6=Sun
      const weekOfMonth = String(Math.min(Math.ceil(d.getDate() / 7), 5));
      const weekPattern = panelWeekendMatrix[weekOfMonth];
      if (!weekPattern) return false;
      // Matrix convention: 1=working, 0=off
      return weekPattern[matrixDayIndex] === 0;
    },
    [panelWeekendMatrix],
  );

  const isPanelHoliday = useCallback(
    (d: Date) => panelHolidaySet.has(dateToKey(d)),
    [panelHolidaySet, dateToKey],
  );

  // True when the date is a non-working day (weekend or public holiday) and so
  // cannot be applied for as leave.
  const isNonWorkingDay = useCallback(
    (d: Date) => isPanelWeekoff(d) || isPanelHoliday(d),
    [isPanelWeekoff, isPanelHoliday],
  );

  // RTK Query keeps `data` at the last SUCCESSFUL result — it survives both an
  // argument change and a failing follow-up request. `currentData` is scoped to
  // the arguments in flight right now.
  //
  // Reading `data` first therefore pinned the display to the previous leave
  // type: picking Loss of Pay and then switching to Earned Leave left the LOP
  // banner, its duration and its balance on screen next to the new error, as if
  // both applied. Prefer the current result, fall back to the previous one only
  // to avoid a flicker mid-fetch, and show nothing at all once the current
  // request has failed.
  //
  // The leave-type check is the backstop: an estimate belongs to a specific
  // leave type, so with none selected there is nothing valid to show no matter
  // what the store still holds.
  const hasEstimateInput = Boolean(selectedLeaveTypeId);
  const est =
    balanceEstimate.isError || !hasEstimateInput
      ? undefined
      : (balanceEstimate.currentData ?? balanceEstimate.data);

  // Drop the Loss-of-Pay acknowledgement whenever the request is no longer LOP
  // (e.g. dates change), so it must be re-confirmed for each unpaid request.
  useEffect(() => {
    if (!est?.is_lop) setLopAcknowledged(false);
  }, [est?.is_lop]);

  // No calendar-year hard cap on the To-date — the backend enforces the leave
  // year rule (rejecting out-of-range requests). We only bound the picker far
  // enough out to keep navigation sane.
  const maxAllowedDate = useMemo(
    () => new Date(new Date().getFullYear() + 2, 11, 31),
    [],
  );

  const maxConsecutiveDays = fieldConfig?.max_consecutive_days ?? null;

  const maxToDate = useMemo(() => {
    if (!maxConsecutiveDays || !fromDate) return maxAllowedDate;
    const limit = new Date(fromDate);
    limit.setDate(limit.getDate() + maxConsecutiveDays - 1);
    return limit < maxAllowedDate ? limit : maxAllowedDate;
  }, [fromDate, maxConsecutiveDays, maxAllowedDate]);

  const maxToDateCustom = useMemo(() => {
    if (!maxConsecutiveDays || !fromDateCustom) return maxAllowedDate;
    const limit = new Date(fromDateCustom);
    limit.setDate(limit.getDate() + maxConsecutiveDays - 1);
    return limit < maxAllowedDate ? limit : maxAllowedDate;
  }, [fromDateCustom, maxConsecutiveDays, maxAllowedDate]);

  // Compute the earliest selectable date using the priority rule from the entitlement spec:
  //   1. backdated_leave.enabled + max_days set  → today − max_days
  //   2. allow_past_dates + max_backdated_days set → today − max_backdated_days
  //   3. allow_past_dates, no cap               → no limit (epoch)
  //   4. !allow_past_dates or no constraints    → today (block all past dates)
  const minAllowedDate = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const c = balanceEstimate.data?.entitlement_constraints;
    if (!c) return new Date(0); // constraints not yet loaded — allow all dates
    if (c.backdated_leave?.enabled && c.backdated_leave.max_days != null) {
      const min = new Date(today);
      min.setDate(min.getDate() - c.backdated_leave.max_days);
      return min;
    }
    if (c.allow_past_dates && c.max_backdated_days != null) {
      const min = new Date(today);
      min.setDate(min.getDate() - c.max_backdated_days);
      return min;
    }
    if (c.allow_past_dates) return new Date(0);
    return today;
  }, [balanceEstimate.data]);

  const toDateStr = (d: Date | undefined) => {
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  // Compare by calendar day only — a Date may carry a time component (e.g. a
  // defaultFromDate passed in), which would otherwise make the SAME day read as
  // "before" fromDate and wrongly grey today out of the To picker.
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const startDate = durationMode === "CUSTOM" ? fromDateCustom : fromDate;
  const endDate =
    durationMode === "CUSTOM"
      ? toDateCustom
      : durationMode === "HALF_DAY"
        ? fromDate
        : toDate;

  const startDateStr = toDateStr(startDate);
  const endDateStr = toDateStr(endDate);

  const durationDays = useMemo(() => {
    if (est) return est.estimated_days;
    if (durationMode === "HALF_DAY") return 0.5;
    if (startDate && endDate) {
      const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
      return diffDays;
    }
    return 1;
  }, [est, durationMode, startDate, endDate]);

  // Comp-off: one worked day per chargeable leave day (1:1).
  const todayMidnight = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const compOffRequiredCount = Math.max(1, Math.round(durationDays));
  const compOffCountMismatch =
    isCompOff && workedDates.length !== compOffRequiredCount;

  const isUploadMandatory = useMemo(() => {
    if (!fieldConfig?.document_mandatory) return false;
    const requiredAfter = fieldConfig.document_required_after_days;
    if (requiredAfter == null || requiredAfter === 0) return true;
    return durationDays >= requiredAfter;
  }, [fieldConfig, durationDays]);

  const isReasonMandatory = fieldConfig?.reason_mandatory === true;

  const estimateParamsReady = !!(
    effectiveLeaveTypeId &&
    startDateStr &&
    endDateStr
  );

  useEffect(() => {
    if (!estimateParamsReady) return;
    triggerBalanceEstimate({
      leave_type_id: effectiveLeaveTypeId,
      start_date: startDateStr,
      end_date: endDateStr,
      duration_mode: durationMode,
      ...(durationMode === "HALF_DAY"
        ? { half_day_period: halfDayPeriod }
        : {}),
      ...(durationMode === "CUSTOM"
        ? { start_session: startSession, end_session: endSession }
        : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effectiveLeaveTypeId,
    startDateStr,
    endDateStr,
    durationMode,
    halfDayPeriod,
    startSession,
    endSession,
  ]);

  const [isDragOver, setIsDragOver] = useState(false);

  const uploadFile = async (file: File) => {
    try {
      const result = await uploadAsset(file).unwrap();
      setUploadedAssets((prev) => [
        ...prev,
        { id: result._id, name: result.original_filename },
      ]);
    } catch (err) {
      toast.error(err, "Failed to upload attachment");
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    await Promise.all(files.map(uploadFile));
    e.target.value = "";
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    await Promise.all(files.map(uploadFile));
  };

  const removeAsset = (id: string) =>
    setUploadedAssets((prev) => prev.filter((a) => a.id !== id));

  const handleApply = () => {
    const isReasonValid = !isReasonMandatory || reason.trim() !== "";
    const isUploadValid = !isUploadMandatory || uploadedAssets.length > 0;
    if (!effectiveLeaveTypeId || !isReasonValid || !isUploadValid) return;
    // Comp-off: exactly one worked (compensated) day per requested leave day.
    if (isCompOff && workedDates.length !== compOffRequiredCount) {
      toast.error(
        `Select exactly ${compOffRequiredCount} worked day${compOffRequiredCount === 1 ? "" : "s"} — one for each leave day`,
      );
      return;
    }
    // Block submission while the balance estimate is errored or still resolving
    // — the backend would reject (e.g. insufficient balance) anyway.
    if (balanceEstimate.isError || balanceEstimate.isFetching) return;

    const body = {
      leave_type_id: effectiveLeaveTypeId,
      start_date: startDateStr,
      end_date: endDateStr,
      duration_mode: durationMode,
      half_day_period: durationMode === "HALF_DAY" ? halfDayPeriod : null,
      start_session: durationMode === "CUSTOM" ? startSession : null,
      end_session: durationMode === "CUSTOM" ? endSession : null,
      reason,
      asset_ids: uploadedAssets.map((a) => a.id),
      notify_cc: [],
      ...(isCompOff
        ? { worked_dates: workedDates.map((d) => toDateStr(d)) }
        : {}),
    };

    const action = editRequest
      ? updateLeaveRequest({ id: editRequest._id, body })
      : createLeaveRequest(body);

    action
      .unwrap()
      .then(() => {
        setReason("");
        setUploadedAssets([]);
        setDialogOpen(false);
        toast.success(
          editRequest
            ? "Leave request updated"
            : "Leave request submitted successfully",
        );
      })
      .catch((err) => {
        const code = err?.data?.code ?? err?.code;
        if (code === "BACKDATED_LEAVE_DEADLINE_EXCEEDED") {
          const max =
            balanceEstimate.data?.entitlement_constraints?.backdated_leave
              ?.max_days;
          toast.error(
            max != null
              ? `Backdated leave deadline exceeded — requests must be submitted within ${max} days of the absence date`
              : "Backdated leave deadline exceeded",
          );
        } else if (code === "LEAVE_YEAR_OUT_OF_RANGE") {
          toast.error(
            "Leave requests can only be submitted for the current year",
          );
        } else {
          toast.error(
            err,
            editRequest
              ? "Failed to update leave request"
              : "Failed to submit leave request",
          );
        }
      });
  };

  const modeButtonClass = (mode: DurationMode) =>
    durationMode === mode
      ? "px-5 py-2 text-sm font-semibold bg-[var(--btn-soft)] text-[var(--btn-soft-fg)] border-r border-[var(--btn-soft)] rounded-none h-auto hover:bg-[var(--btn-soft)] hover:text-[var(--btn-soft-fg)]"
      : "px-5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted border-r border-border rounded-none h-auto";

  const estimatedLabel = balanceEstimate.isFetching
    ? "Calculating..."
    : est
      ? `Estimated: ${est.estimated_days} day(s)`
      : "Estimated: —";

  function setSelectedFile(arg0: File) {
    throw new Error("Function not implemented.");
  }

  return (
    <Sheet open={dialogOpen} onOpenChange={guardedSheetOpenChange}>
      {children != null && <SheetTrigger asChild>{children}</SheetTrigger>}
      <SheetContent
        side="right"
        className="w-[680px] sm:max-w-[720px] p-0 flex flex-col gap-0"
        showCloseButton={false}
      >
        <div
          className="flex flex-col h-full relative"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node))
              setIsDragOver(false);
          }}
          onDrop={handleDrop}
        >
          {/* Full-drawer drag overlay */}
          {isDragOver && (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-primary/5 border-2 border-dashed border-primary rounded-none pointer-events-none">
              <UploadCloud className="size-10 text-primary" />
              <p className="text-sm font-semibold text-primary">
                Drop files to attach
              </p>
            </div>
          )}
          <SheetHeader className="flex-row items-center justify-between border-b px-6 py-4 gap-0 flex-shrink-0">
            <div>
              <SheetTitle className="text-base font-semibold leading-none">
                {editRequest ? "Edit Leave Request" : "New Leave Request"}
              </SheetTitle>
              <p className="text-[11px] text-muted-foreground mt-1">
                {editRequest
                  ? "Update the details of your pending leave request"
                  : "Fill in the details below to apply for leave"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => guardedSheetOpenChange(false)}
            >
              <X />
              <span className="sr-only">Close</span>
            </Button>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
            {/* From / To / Leave Type — single row */}
            {(() => {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              return (
                <div className="grid grid-cols-3 gap-3">
                  {/* From */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">
                      From <span className="text-destructive">*</span>
                    </label>
                    <Popover open={isFromOpen} onOpenChange={setIsFromOpen}>
                      <PopoverTrigger asChild>
                        <div className="flex items-center gap-2 border border-border px-3 rounded-md bg-card cursor-pointer h-9">
                          <Calendar
                            size={14}
                            className="text-muted-foreground shrink-0"
                          />
                          <span
                            className={`text-sm flex-1 ${fromDate ? "text-foreground font-medium" : "text-muted-foreground"}`}
                          >
                            {fromDate
                              ? fromDate
                                  .toLocaleDateString("en-GB", {
                                    day: "2-digit",
                                    month: "short",
                                    year: "numeric",
                                  })
                                  .replace(/ /g, "-")
                              : "Pick date"}
                          </span>
                        </div>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <CalendarPicker
                          mode="single"
                          selected={fromDate}
                          onSelect={(d) => {
                            setFromDate(d);
                            if (toDate && d) {
                              if (toDate < d) setToDate(undefined);
                              else if (maxConsecutiveDays) {
                                const limit = new Date(d);
                                limit.setDate(
                                  limit.getDate() + maxConsecutiveDays - 1,
                                );
                                if (toDate > limit) setToDate(undefined);
                              }
                            }
                            setIsFromOpen(false);
                          }}
                          disabled={(d) =>
                            d < minAllowedDate ||
                            d > maxAllowedDate ||
                            isNonWorkingDay(d)
                          }
                          fromDate={minAllowedDate}
                          toDate={maxAllowedDate}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>

                  {/* To */}
                  {durationMode !== "HALF_DAY" ? (
                    <div className="flex flex-col gap-1.5">
                      <label
                        className={`text-xs font-semibold ${fromDate ? "text-muted-foreground" : "text-muted-foreground/40"}`}
                      >
                        To <span className="text-destructive">*</span>
                      </label>
                      <Popover
                        open={isToOpen}
                        onOpenChange={(o) => {
                          if (!fromDate) return;
                          setIsToOpen(o);
                        }}
                      >
                        <PopoverTrigger asChild>
                          <div
                            className={`flex items-center gap-2 border border-border px-3 rounded-md h-9 ${fromDate ? "bg-card cursor-pointer" : "bg-muted cursor-not-allowed opacity-50"}`}
                          >
                            <Calendar
                              size={14}
                              className="text-muted-foreground shrink-0"
                            />
                            <span
                              className={`text-sm flex-1 ${toDate ? "text-foreground font-medium" : "text-muted-foreground"}`}
                            >
                              {toDate
                                ? toDate
                                    .toLocaleDateString("en-GB", {
                                      day: "2-digit",
                                      month: "short",
                                      year: "numeric",
                                    })
                                    .replace(/ /g, "-")
                                : "Pick date"}
                            </span>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarPicker
                            mode="single"
                            selected={toDate}
                            onSelect={(d) => {
                              setToDate(d);
                              setIsToOpen(false);
                            }}
                            disabled={(d) =>
                              d < minAllowedDate ||
                              d > maxToDate ||
                              (fromDate
                                ? startOfDay(d) < startOfDay(fromDate)
                                : false) ||
                              isNonWorkingDay(d)
                            }
                            fromDate={minAllowedDate}
                            toDate={maxToDate}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  ) : (
                    <div />
                  )}

                  {/* Leave Type */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">
                      Type of leave <span className="text-destructive">*</span>
                    </label>
                    {/* `modal` so the list can be wheel-scrolled inside the
                        Sheet: the parent's scroll-lock otherwise swallows wheel
                        events on the popover, which is portaled outside it.
                        Same fix the shared <SearchableSelect> uses. */}
                    <Popover
                      modal
                      open={isLeaveTypeOpen}
                      onOpenChange={(o) => {
                        setIsLeaveTypeOpen(o);
                        if (!o) setLeaveTypeSearch("");
                      }}
                    >
                      <PopoverTrigger asChild>
                        <div className="flex items-center justify-between border border-border px-3 rounded-md bg-card cursor-pointer h-9 gap-2">
                          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                            {/* The leave type's own code — the previous badge
                                showed a Paid/Sick/Unpaid tag derived from
                                is_sick_leave, which the form persists as
                                !is_paid, so every unpaid type read "Sick". */}
                            {selectedLeaveType?.code && (
                              <span className="bg-primary/10 text-primary text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0">
                                {selectedLeaveType.code}
                              </span>
                            )}
                            <span
                              className={`text-sm truncate ${selectedLeaveType ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                            >
                              {selectedLeaveType?.name ?? "Select type"}
                            </span>
                          </div>
                          <ChevronDown
                            size={14}
                            className="text-muted-foreground shrink-0"
                          />
                        </div>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-(--radix-popover-trigger-width) p-0"
                        align="start"
                      >
                        <div className="p-2 border-b border-border">
                          <Input
                            placeholder="Search leave type..."
                            value={leaveTypeSearch}
                            onChange={(e) => setLeaveTypeSearch(e.target.value)}
                            className="h-7 text-xs"
                            autoFocus
                          />
                        </div>
                        <div className="max-h-72 overflow-y-auto overscroll-contain">
                          {filteredLeaveTypes.length === 0 ? (
                            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                              No types found
                            </div>
                          ) : (
                            filteredLeaveTypes.map((lt) => (
                              <div
                                key={lt._id}
                                className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted text-sm ${effectiveLeaveTypeId === lt._id ? "bg-primary/5 font-semibold" : ""}`}
                                onClick={() => {
                                  setSelectedLeaveTypeId(lt._id);
                                  setIsLeaveTypeOpen(false);
                                  setLeaveTypeSearch("");
                                }}
                              >
                                <span className="font-medium">{lt.name}</span>
                              </div>
                            ))
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              );
            })()}

            {/* Unrestricted leave has no balance to weigh a request against —
                this is what the employee gets instead. Renders nothing unless
                the type is configured for it. */}
            <LeaveUsageWarning
              leaveType={selectedLeaveType}
              leaveTypeId={effectiveLeaveTypeId}
            />

            {/* Estimate + Available balance row */}
            <div className="flex justify-center gap-6 px-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground font-medium">
                  Leave Duration :
                </span>
                {balanceEstimate.isFetching ? (
                  <Loader2
                    size={11}
                    className="animate-spin text-muted-foreground"
                  />
                ) : (
                  <span className="font-bold text-foreground">
                    {est
                      ? `${est.estimated_days}d / ${est.estimated_hours}h`
                      : "—"}
                  </span>
                )}
              </div>
              <div className="w-px h-4 bg-border" />
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground font-medium">
                  Available balance:
                </span>
                {balanceEstimate.isFetching ? (
                  <Loader2
                    size={11}
                    className="animate-spin text-muted-foreground"
                  />
                ) : (
                  <span
                    className={`font-bold ${est && est.after_approval_days < 0 ? "text-destructive" : "text-success"}`}
                  >
                    {est
                      ? `${est.available_today_days}d / ${est.available_today_hours}h`
                      : "—"}
                  </span>
                )}
              </div>
            </div>

            {/* Per-leave-type requirements — surface mandatory reason / document
                so the user isn't surprised by a server rejection */}
            {effectiveLeaveTypeId &&
              (isReasonMandatory || isUploadMandatory) && (
                <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/5 px-3 py-2.5 text-xs text-info">
                  <Info className="size-3.5 shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold">
                      This leave type requires:
                    </span>
                    <ul className="list-disc pl-4">
                      {isReasonMandatory && <li>A reason / comment</li>}
                      {isUploadMandatory && (
                        <li>
                          A supporting document
                          {fieldConfig?.document_required_after_days
                            ? ` (for leave of ${fieldConfig.document_required_after_days} day(s) or more)`
                            : ""}
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              )}

            {/* Loss of Pay notice — weekends are charged when balance is exhausted */}
            {est?.is_lop && !balanceEstimate.isFetching && (
              <div className="flex flex-col gap-2.5 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs text-warning">
                <div className="flex items-start gap-2">
                  <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
                  <span>
                    No leave balance available — this request is treated as Loss
                    of Pay, so weekends are included in the duration. Public
                    holidays are excluded.
                  </span>
                </div>
                <label className="flex items-start gap-2 cursor-pointer pl-5">
                  <Checkbox
                    checked={lopAcknowledged}
                    onCheckedChange={(v) => setLopAcknowledged(v === true)}
                    className="mt-0.5"
                  />
                  <span className="font-medium">
                    I understand this leave will be unpaid (Loss of Pay).
                  </span>
                </label>
              </div>
            )}

            {/* Balance estimate error */}
            {balanceEstimate.isError &&
              !balanceEstimate.isFetching &&
              hasEstimateInput &&
              (() => {
                const err = balanceEstimate.error as
                  | {
                      data?: { detail?: string; message?: string };
                      message?: string;
                    }
                  | undefined;
                const msg =
                  err?.data?.detail ??
                  err?.data?.message ??
                  err?.message ??
                  "Could not calculate leave balance estimate.";
                return (
                  <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                    <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
                    <span>{msg}</span>
                  </div>
                );
              })()}

            {/* Balance & Projection */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowBalanceProjection((v) => !v)}
                className="self-center text-xs font-medium text-primary hover:underline flex items-center gap-1"
              >
                {showBalanceProjection
                  ? "Hide balance & projection"
                  : "Show balance & projection"}
                {balanceEstimate.isFetching && (
                  <Loader2
                    size={10}
                    className="animate-spin text-muted-foreground"
                  />
                )}
              </button>
              {showBalanceProjection && (
                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs border border-border rounded-xl p-4">
                  {(
                    [
                      {
                        label: "Available today",
                        days: est?.available_today_days,
                        hrs: est?.available_today_hours,
                      },
                      {
                        label: "Projected by leave date",
                        days: est?.projected_by_leave_date_days,
                        hrs: est?.projected_by_leave_date_hours,
                      },
                      {
                        label: "This leave",
                        days: est?.estimated_days,
                        hrs: est?.estimated_hours,
                      },
                      {
                        label: "After approval",
                        days: est?.after_approval_days,
                        hrs: est?.after_approval_hours,
                      },
                    ] as { label: string; days?: number; hrs?: number }[]
                  ).map((row) => (
                    <div
                      key={row.label}
                      className="flex justify-between items-center text-muted-foreground"
                    >
                      <span>{row.label}</span>
                      <span className="font-bold text-foreground">
                        {row.days !== undefined
                          ? `${row.days}d / ${row.hrs}h`
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Duration Mode */}
            <div className="flex flex-col gap-3 border-t border-border pt-6">
              <label className="text-xs font-semibold text-foreground">
                Duration Mode <span className="text-destructive">*</span>
              </label>
              <div className="flex w-max border border-border rounded-md overflow-x-auto bg-card">
                <Button
                  variant="ghost"
                  className={modeButtonClass("FULL_DAYS")}
                  onClick={() => setDurationMode("FULL_DAYS")}
                >
                  Full days
                </Button>
                {/* Comp-off is full-days only — no half-day option. */}
                {!isCompOff && (
                  <Button
                    variant="ghost"
                    className={modeButtonClass("HALF_DAY")}
                    onClick={() => setDurationMode("HALF_DAY")}
                  >
                    Half day
                  </Button>
                )}
                {/* <Button variant="ghost" className={`${modeButtonClass('CUSTOM')} border-r-0`} onClick={() => setDurationMode('CUSTOM')}>Custom</Button> */}
              </div>

              {durationMode === "HALF_DAY" && (
                <div className="flex items-center gap-6 mt-3 ml-2">
                  {(["FIRST_HALF", "SECOND_HALF"] as SessionHalf[]).map(
                    (half) => (
                      <div
                        key={half}
                        className="flex items-center gap-2 text-sm text-foreground font-medium cursor-pointer"
                        onClick={() => setHalfDayPeriod(half)}
                      >
                        <div
                          className={`w-4 h-4 rounded-full flex items-center justify-center ${halfDayPeriod === half ? "bg-teal-600" : "border-2 border-teal-600"}`}
                        ></div>
                        {SESSION_LABELS[half]}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>

            {/* Worked days — comp-off / expiring leave only */}
            {isCompOff && (
              <div className="flex flex-col gap-3 border-t border-border pt-6">
                <label className="text-xs font-semibold text-foreground">
                  Worked days being compensated{" "}
                  <span className="text-destructive">*</span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Pick the {compOffRequiredCount} non-working day
                  {compOffRequiredCount === 1 ? "" : "s"} you worked — one for each
                  leave day.
                  {selectedLeaveType?.expiry_days != null && (
                    <>
                      {" "}
                      Each comp-off must be taken within{" "}
                      {selectedLeaveType.expiry_days} day
                      {selectedLeaveType.expiry_days === 1 ? "" : "s"} of the day
                      you worked.
                    </>
                  )}
                </p>
                <Popover
                  open={isWorkedDatesOpen}
                  onOpenChange={setIsWorkedDatesOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-max justify-start text-left font-normal border-border text-sm h-9 px-3 gap-2"
                    >
                      <Calendar size={14} className="text-muted-foreground" />
                      {workedDates.length
                        ? `${workedDates.length} of ${compOffRequiredCount} day${compOffRequiredCount === 1 ? "" : "s"} selected`
                        : "Select worked days"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarPicker
                      mode="multiple"
                      selected={workedDates}
                      onSelect={(dates) => setWorkedDates(dates ?? [])}
                      disabled={(d) => d > todayMidnight}
                      toDate={todayMidnight}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                {workedDates.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {[...workedDates]
                      .sort((a, b) => a.getTime() - b.getTime())
                      .map((d) => (
                        <span
                          key={d.toISOString()}
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground"
                        >
                          {d
                            .toLocaleDateString("en-GB", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })
                            .replace(/ /g, "-")}
                          <button
                            type="button"
                            onClick={() =>
                              setWorkedDates((prev) =>
                                prev.filter((x) => x.getTime() !== d.getTime()),
                              )
                            }
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                  </div>
                )}
                {compOffCountMismatch && (
                  <p className="text-xs text-destructive">
                    Select exactly {compOffRequiredCount} worked day
                    {compOffRequiredCount === 1 ? "" : "s"} — one for each leave day
                    ({workedDates.length} selected).
                  </p>
                )}
              </div>
            )}

            {/* Custom Mode Block
            {durationMode === 'CUSTOM' && (
              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-foreground">Custom</label>
                <div className="flex gap-8 p-5 bg-muted rounded-xl w-max">
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-medium text-muted-foreground">From <span className="text-destructive">*</span></span>
                    <Popover open={isFromCustomOpen} onOpenChange={setIsFromCustomOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-36 justify-start text-left font-normal border-border text-sm h-8 px-2">
                          <Calendar size={14} className="text-muted-foreground" />
                          {fromDateCustom ? fromDateCustom.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).replace(/ /g, '-') : 'Pick date'}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <CalendarPicker mode="single" selected={fromDateCustom} onSelect={(d) => { setFromDateCustom(d); setIsFromCustomOpen(false); }} disabled={(d) => d < minAllowedDate || d > maxAllowedDate} fromDate={minAllowedDate} toDate={maxAllowedDate} initialFocus />
                      </PopoverContent>
                    </Popover>
                    <div className="border border-border bg-card rounded px-2 py-1 text-sm text-muted-foreground flex items-center justify-between w-36">
                      First Half <ChevronDown size={14} className="text-muted-foreground"/>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-medium text-muted-foreground">To <span className="text-destructive">*</span></span>
                    <Popover open={isToCustomOpen} onOpenChange={setIsToCustomOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-36 justify-start text-left font-normal border-border text-sm h-8 px-2">
                          <Calendar size={14} className="text-muted-foreground" />
                          {toDateCustom ? toDateCustom.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).replace(/ /g, '-') : 'Pick date'}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <CalendarPicker mode="single" selected={toDateCustom} onSelect={(d) => { setToDateCustom(d); setIsToCustomOpen(false); }} disabled={(d) => d < minAllowedDate || d > maxToDateCustom || (fromDateCustom ? startOfDay(d) < startOfDay(fromDateCustom) : false)} fromDate={minAllowedDate} toDate={maxToDateCustom} initialFocus />
                      </PopoverContent>
                    </Popover>
                    <Popover open={isEndSessionOpen} onOpenChange={setIsEndSessionOpen}>
                      <PopoverTrigger asChild>
                        <div className="border border-border bg-card rounded px-2 py-1 text-sm text-muted-foreground flex items-center justify-between w-36 cursor-pointer">
                          {SESSION_LABELS[endSession]} <ChevronDown size={14} className="text-muted-foreground" />
                        </div>
                      </PopoverTrigger>
                      <PopoverContent className="w-36 p-1" align="start">
                        {(['FIRST_HALF', 'SECOND_HALF'] as SessionHalf[]).map(s => (
                          <div key={s} className="px-2 py-1.5 rounded cursor-pointer hover:bg-muted text-sm" onClick={() => { setEndSession(s); setIsEndSessionOpen(false); }}>
                            {SESSION_LABELS[s]}
                          </div>
                        ))}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </div>
            )} */}

            {/* Reason */}
            <div className="flex flex-col gap-1.5 relative">
              <label className="text-xs font-semibold text-foreground">
                Reason{" "}
                {isReasonMandatory && (
                  <span className="text-destructive">*</span>
                )}
              </label>
              <Textarea
                className="w-full border-border rounded-md p-3 text-sm text-foreground resize-none h-24 focus-visible:border-primary"
                placeholder="Enter your reason for leave..."
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, 300))}
                maxLength={300}
              />
              <span className="absolute bottom-2 right-2 text-[10px] text-muted-foreground">
                {reason.length}/300
              </span>
            </div>

            {/* Attachments */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-foreground">
                Attachments{" "}
                {isUploadMandatory && (
                  <span className="text-destructive">*</span>
                )}
              </label>
              <input
                type="file"
                className="hidden"
                ref={fileInputRef}
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp"
                multiple
                onChange={handleFileChange}
              />

              {uploadedAssets.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {/* Uploaded files list */}
                  <div className="max-h-36 overflow-y-auto flex flex-col gap-1 rounded-xl border border-border bg-muted px-3 py-2">
                    {uploadedAssets.map((asset) => (
                      <div
                        key={asset.id}
                        className="flex items-center gap-2 text-xs text-foreground py-0.5"
                      >
                        <Paperclip
                          size={12}
                          className="text-primary shrink-0"
                        />
                        <span className="flex-1 truncate">{asset.name}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive shrink-0 text-base leading-none"
                          onClick={() => removeAsset(asset.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  {/* Add More button */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadAssetResult.isLoading}
                    className="self-start flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    {uploadAssetResult.isLoading ? (
                      <>
                        <Loader2 size={11} className="animate-spin" />{" "}
                        Uploading...
                      </>
                    ) : (
                      <>
                        <span className="text-base leading-none">+</span> Add
                        more
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div
                  className="border-2 border-dashed border-border rounded-xl h-24 flex flex-col items-center justify-center bg-muted text-muted-foreground hover:bg-muted/80 transition cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadAssetResult.isLoading ? (
                    <>
                      <Loader2
                        size={20}
                        className="text-muted-foreground mb-1.5 animate-spin"
                      />
                      <span className="text-xs font-medium">Uploading...</span>
                    </>
                  ) : (
                    <>
                      <UploadCloud
                        size={20}
                        className="text-muted-foreground mb-1.5"
                      />
                      <span className="text-xs font-medium">
                        Drop files here or click to browse
                      </span>
                      <span className="text-[10px] text-muted-foreground mt-0.5">
                        PDF, DOC, JPEG, PNG — max 10MB
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Approvals — hidden until manager API is ready */}
            {SHOW_APPROVAL_CHAIN && (
              <div className="flex flex-col gap-2 pb-6 border-b border-border">
                <label className="text-sm font-bold text-foreground">
                  Approvals
                </label>
                {(() => {
                  const chain =
                    myApprovalChain?.approval_required &&
                    myApprovalChain.approval_levels?.length
                      ? myApprovalChain
                      : fieldConfig?.approval_required &&
                          fieldConfig.approval_levels?.length
                        ? {
                            approval_required: true,
                            approval_levels: fieldConfig.approval_levels,
                          }
                        : null;

                  if (isFetchingChain) {
                    return (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 size={11} className="animate-spin" /> Loading
                        approval chain...
                      </div>
                    );
                  }
                  if (!chain) {
                    return (
                      <p className="text-xs text-muted-foreground">
                        No approval required for your leave plan.
                      </p>
                    );
                  }
                  return (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-1.5 text-xs text-foreground">
                        <span>
                          {chain.approval_levels.length}-level approval
                          required.
                        </span>
                        <button
                          type="button"
                          className="text-primary hover:underline font-semibold"
                          onClick={() => setShowChain((v) => !v)}
                        >
                          {showChain ? "Hide chain" : "View chain"}
                        </button>
                      </div>
                      {showChain && (
                        <div className="flex items-center gap-2 pl-1 flex-wrap">
                          {chain.approval_levels
                            .slice()
                            .sort((a, b) => a.level - b.level)
                            .map((lvl, idx) => {
                              const managerName =
                                lvl.level === 1
                                  ? myManagers?.l1?.name
                                  : lvl.level === 2
                                    ? myManagers?.l2?.name
                                    : undefined;
                              return (
                                <Fragment key={lvl.level}>
                                  {idx > 0 && (
                                    <ArrowRight
                                      size={12}
                                      className="text-muted-foreground shrink-0"
                                    />
                                  )}
                                  <div className="flex flex-col items-center gap-1">
                                    <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                                      <span className="text-[10px] font-bold text-primary">
                                        L{lvl.level}
                                      </span>
                                    </div>
                                    <span
                                      className="text-[10px] text-muted-foreground text-center max-w-[80px] truncate"
                                      title={managerName}
                                    >
                                      {managerName ??
                                        (lvl.selection_type === "role"
                                          ? "Role approver"
                                          : "Specific approver")}
                                    </span>
                                  </div>
                                </Fragment>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 border-t border-border px-6 py-4 flex justify-end gap-3 bg-muted">
            <Button
              variant="outline"
              onClick={() => guardedSheetOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={handleApply}
              disabled={
                createLeaveRequestResult.isLoading ||
                updateLeaveRequestResult.isLoading ||
                !effectiveLeaveTypeId ||
                (isReasonMandatory && !reason.trim()) ||
                (isUploadMandatory && uploadedAssets.length === 0) ||
                (est?.is_lop === true && !lopAcknowledged) ||
                balanceEstimate.isError ||
                balanceEstimate.isFetching
              }
            >
              {createLeaveRequestResult.isLoading ||
              updateLeaveRequestResult.isLoading ? (
                <>
                  <Loader2 className="animate-spin" />{" "}
                  {editRequest ? "Saving..." : "Applying..."}
                </>
              ) : editRequest ? (
                "Save Changes"
              ) : (
                "Apply"
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LeaveDetailsView = ({
  leave,
  onBack,
}: {
  leave: any;
  onBack: () => void;
}) => {
  const raw = leave._raw as LeaveRequestResponse | undefined;
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id ?? "");
  const confirm = useConfirm();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const authUser = useAppSelector((s) => s.auth.user);
  const userInitials = authUser
    ? getInitials(`${authUser.first_name} ${authUser.last_name}`)
    : "Me";
  const { data: leaveTypesData } = useGetLeaveTypesQuery(orgId, {
    skip: !orgId,
  });
  const leaveTypesRef = Array.isArray(leaveTypesData) ? leaveTypesData : [];
  const [cancelLeaveRequest, cancelMutationResult] =
    useCancelLeaveRequestMutation();

  const { data: detailData } = useGetLeaveRequestQuery(raw?._id ?? "", {
    skip: !raw?._id,
  });
  const assets = detailData?.assets ?? [];
  const editRequest = detailData ?? raw ?? null;
  const canEdit = raw?.status === "PENDING";

  // Derive display values from real data or fall back to leave row data
  const leaveTypeName = raw
    ? getLeaveTypeName(raw.leave_type_id, leaveTypesRef)
    : (leave.type ?? "Leave");
  const startDateStr = raw ? raw.start_date : "";
  const endDateStr = raw ? raw.end_date : "";
  const days = raw ? (raw.duration_days ?? 0) : 0;
  const reasonText = raw ? raw.reason : (leave.reason ?? "");
  const createdOn = raw ? raw.created_on : "";
  const durationMode = raw?.duration_mode ?? "FULL_DAYS";
  const durationTypeLabel = (() => {
    if (durationMode === "FULL_DAYS") return "Full Day";
    if (durationMode === "HALF_DAY")
      return raw?.half_day_period === "FIRST_HALF"
        ? "First Half"
        : "Second Half";
    return "Custom";
  })();

  const formatFullDate = (iso: string) => {
    if (!iso) return "-";
    const d = new Date(iso);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
    return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };

  const headerTitle = (() => {
    if (!raw) return `${leave.from ?? ""} - ${leave.type ?? "Leave"}`;
    const s = new Date(startDateStr);
    const e = new Date(endDateStr);
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
    const dateRange =
      s.toDateString() === e.toDateString()
        ? `${months[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()}`
        : `${months[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
    const dayLabel = days === 1 ? "1 day" : `${days} days`;
    return `${dateRange} (${dayLabel}) - ${leaveTypeName}`;
  })();

  return (
    <div className="flex flex-col w-full h-full p-8 bg-card overflow-auto relative">
      {/* Top Header */}
      <div className="flex justify-between items-start mb-8">
        <h1 className="text-xl font-semibold text-foreground">{headerTitle}</h1>
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="border-border shadow-sm"
            disabled={!canEdit}
            onClick={() => setIsEditOpen(true)}
          >
            Edit
          </Button>
          <RequestLeavePanel
            open={isEditOpen}
            onOpenChange={setIsEditOpen}
            editRequest={editRequest}
          />
          <Button
            variant="outline"
            className="border-destructive/30 text-destructive hover:bg-destructive/10 shadow-sm"
            disabled={
              cancelMutationResult.isLoading || raw?.status !== "PENDING"
            }
            onClick={() => {
              if (!raw) return;
              confirm({
                title: "Withdraw this leave request?",
                description:
                  "This will cancel the pending leave request. This action cannot be undone.",
                confirmText: "Withdraw",
                cancelText: "Keep request",
                variant: "destructive",
                onConfirm: async () => {
                  try {
                    await cancelLeaveRequest(raw._id).unwrap();
                    toast.success("Leave request withdrawn");
                    onBack();
                  } catch (err) {
                    toast.error(err, "Failed to withdraw leave request");
                  }
                },
              });
            }}
          >
            Withdraw
          </Button>
        </div>
      </div>

      <div className="flex gap-12 w-full max-w-6xl">
        {/* Left Column */}
        <div className="flex-[2] flex flex-col gap-10">
          {/* Main Info */}
          <div className="flex flex-col gap-8 w-full">
            <div className="flex gap-6 items-center">
              <div className="flex items-center">
                <div className="border border-border rounded-xl p-3 bg-card flex flex-col justify-center items-center h-[72px] min-w-[140px] shadow-sm">
                  <span className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-1">
                    Date
                  </span>
                  <span className="text-sm font-bold text-foreground">
                    {formatFullDate(startDateStr)}
                  </span>
                </div>
                <ArrowRight className="mx-4 text-muted-foreground/40 w-4 h-4" />
                <div className="border border-border rounded-xl p-3 bg-card flex flex-col justify-center items-center h-[72px] min-w-[140px] shadow-sm">
                  <span className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-1">
                    To
                  </span>
                  <span className="text-sm font-bold text-foreground">
                    {formatFullDate(endDateStr)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-2.5">
                <span className="bg-primary/10 text-primary text-xs font-bold px-3 py-1.5 rounded-full w-max flex items-center gap-1.5">
                  <Calendar size={12} /> {days} working day
                  {days !== 1 ? "s" : ""}
                </span>
                <div className="flex gap-2">
                  <span className="bg-success/10 text-success text-[11px] font-bold px-3 py-1 rounded-full flex items-center gap-1.5">
                    <Zap size={10} /> {leaveTypeName}
                  </span>
                  <span className="bg-badge-info-bg text-badge-info-text text-[11px] font-bold px-3 py-1 rounded-full">
                    {durationMode === "FULL_DAYS" ? "Full Day" : "Half Day"}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                Reason
              </span>
              <p className="text-sm text-foreground leading-relaxed font-medium">
                {reasonText}
              </p>
            </div>

            {(raw?.worked_dates?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Compensated worked days
                </span>
                <div className="flex flex-wrap gap-2">
                  {raw!.worked_dates!.map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 text-warning text-[11px] font-bold px-3 py-1"
                    >
                      <Calendar size={10} /> {formatFullDate(d)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between items-end border-b border-border pb-8">
              <div className="flex gap-16">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">
                    Requested On
                  </span>
                  <span className="text-sm font-bold text-foreground">
                    {createdOn ? formatDateSummary(createdOn) : "-"}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">
                    Reporting Manager
                  </span>
                  <div className="flex items-center gap-2">
                    {detailData?.l1_manager ? (
                      <>
                        <Avatar className="w-6 h-6">
                          <AvatarFallback className="text-[9px]">
                            {getInitials(detailData.l1_manager.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-bold text-foreground">
                          {detailData.l1_manager.name}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                </div>
              </div>
              {/* <span className="text-[11px] font-bold text-primary cursor-pointer hover:underline uppercase tracking-wide">How are counted days</span> */}
            </div>
          </div>

          {/* Attachments */}
          <Card className="shadow-sm border-border bg-card">
            <CardHeader className="px-6 py-4 border-b border-border bg-card rounded-t-xl">
              <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
                Attachments{" "}
                <span className="bg-muted text-muted-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {assets.length}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 flex flex-col gap-3 bg-card rounded-b-xl">
              {assets.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No attachments.
                </p>
              )}
              {assets.map((asset) => {
                const ext =
                  asset.original_filename.split(".").pop()?.toUpperCase() ?? "";
                const isPdf = asset.content_type === "application/pdf";
                const sizeKb = Math.round(asset.size / 1024);
                return (
                  <div
                    key={asset.id}
                    className="flex items-center justify-between border border-border rounded-xl p-3 hover:bg-muted transition"
                  >
                    <div className="flex gap-4 items-center">
                      {isPdf ? (
                        <FileText className="w-7 h-7 text-destructive" />
                      ) : (
                        <div className="w-7 h-7 rounded bg-primary/10 text-primary flex items-center justify-center font-bold text-[10px]">
                          {ext}
                        </div>
                      )}
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-bold text-foreground">
                          {asset.original_filename}
                        </span>
                        <span className="text-xs text-muted-foreground font-medium">
                          {sizeKb} KB
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs font-semibold text-muted-foreground"
                        asChild
                      >
                        <a href={asset.url} target="_blank" rel="noreferrer">
                          Preview
                        </a>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs font-semibold text-muted-foreground"
                        asChild
                      >
                        <a href={asset.url} download={asset.original_filename}>
                          Download
                        </a>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Approval Timeline — hidden until manager API is ready */}
          {/* @ts-ignore — Approval Timeline hidden until manager API is ready */}
          {false &&
            (() => {
              const allEntries = (detailData?.approval_timeline ??
                []) as ApprovalTimelineEntry[];
              const submittedEntry = allEntries.find(
                (e) => e.action === "SUBMITTED",
              );
              const approvalEntries = allEntries.filter(
                (e) => e.action !== "SUBMITTED",
              );
              const submittedAt =
                submittedEntry?.timestamp ?? raw?.created_on ?? null;
              const submitterName = submittedEntry?.actor_name;
              return (
                <div className="flex flex-col gap-6 mt-4">
                  <h3 className="text-sm font-bold text-foreground">
                    Approval Timeline
                  </h3>
                  <div className="flex items-center w-[80%] pl-2">
                    {/* Employee — always first */}
                    <div className="flex flex-col items-center gap-1.5 w-24 relative">
                      <Avatar className="w-11 h-11 border-[3px] border-success shadow-sm">
                        <AvatarFallback className="text-xs">
                          {submitterName
                            ? getInitials(submitterName)
                            : userInitials}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-foreground truncate max-w-[88px] text-center">
                          {submitterName ?? "Employee"}
                        </span>
                        <span className="text-[10px] font-bold text-success">
                          Submitted
                        </span>
                        <span className="text-[9px] text-muted-foreground mt-0.5 whitespace-nowrap">
                          {formatTimelineDate(submittedAt)}
                        </span>
                      </div>
                    </div>

                    {approvalEntries.length > 0 ? (
                      approvalEntries.map((entry, idx) => {
                        const isApproved = entry.action === "APPROVED";
                        const isRejected = entry.action === "REJECTED";
                        const borderColor = isApproved
                          ? "border-success"
                          : isRejected
                            ? "border-destructive"
                            : "border-warning";
                        const statusColor = isApproved
                          ? "text-success"
                          : isRejected
                            ? "text-destructive"
                            : "text-badge-pending-text";
                        const statusLabel = isApproved
                          ? "Approved"
                          : isRejected
                            ? "Rejected"
                            : entry.action;
                        const lineColor = isApproved
                          ? "bg-success/70"
                          : "bg-muted";
                        return (
                          <Fragment key={idx}>
                            <div
                              className={`flex-1 h-1 ${lineColor} mb-10 mx-2`}
                            />
                            <div className="flex flex-col items-center gap-1.5 w-24 relative">
                              <Avatar
                                className={`w-11 h-11 border-[3px] ${borderColor} shadow-sm`}
                              >
                                <AvatarFallback className="text-xs">
                                  {getInitials(entry.actor_name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex flex-col items-center">
                                <span className="text-xs font-bold text-foreground truncate max-w-[88px] text-center">
                                  {entry.actor_name}
                                </span>
                                <span
                                  className={`text-[10px] font-bold ${statusColor}`}
                                >
                                  {statusLabel}
                                </span>
                                <span className="text-[9px] text-muted-foreground mt-0.5 whitespace-nowrap">
                                  {formatTimelineDate(entry.timestamp)}
                                </span>
                              </div>
                            </div>
                          </Fragment>
                        );
                      })
                    ) : (
                      <>
                        <div className="flex-1 h-1 bg-muted mb-10 mx-2" />
                        <div className="flex flex-col items-center gap-1.5 w-24 relative">
                          <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center border-2 border-border shadow-sm">
                            <CheckCircle2 className="w-5 h-5 text-muted-foreground/40" />
                          </div>
                          <div className="flex flex-col items-center">
                            <span className="text-xs font-bold text-foreground">
                              Approval
                            </span>
                            <span className="text-[10px] font-bold text-muted-foreground">
                              Waiting
                            </span>
                            <span className="text-[9px] text-muted-foreground mt-0.5">
                              -
                            </span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Leave Request History */}
          <Card className="shadow-sm border-border mt-6 mb-20 bg-card">
            <CardHeader className="px-6 pt-5 pb-3">
              <CardTitle className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                Leave Request History
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(detailData?.approval_timeline ?? []).length === 0 ? (
                <div className="px-6 py-8 text-center text-sm text-muted-foreground">
                  No history available.
                </div>
              ) : (
                (detailData!.approval_timeline as ApprovalTimelineEntry[]).map(
                  (entry, idx, arr) => {
                    const isSubmitted = entry.action === "SUBMITTED";
                    const isApproved = entry.action === "APPROVED";
                    const isLast = idx === arr.length - 1;
                    return (
                      <div
                        key={idx}
                        className={`flex gap-4 px-6 py-5 items-start hover:bg-muted transition ${!isLast ? "border-b border-border" : "rounded-b-xl"}`}
                      >
                        <Avatar className="w-10 h-10 shadow-sm">
                          <AvatarFallback className="text-xs">
                            {getInitials(entry.actor_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col pt-0.5">
                          {isSubmitted ? (
                            <span className="text-sm text-muted-foreground">
                              Leave Request{" "}
                              <span className="font-bold text-foreground">
                                submitted
                              </span>
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              Leave Request{" "}
                              <span
                                className={`font-bold ${isApproved ? "text-success" : "text-destructive"}`}
                              >
                                {isApproved ? "Approved" : "Rejected"}
                              </span>{" "}
                              by{" "}
                              <span className="font-bold text-foreground">
                                {entry.actor_name}
                              </span>
                              {entry.comment && (
                                <span className="italic">
                                  {" "}
                                  — "{entry.comment}"
                                </span>
                              )}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground font-medium mt-1 tracking-tight">
                            {formatTimelineDate(entry.timestamp)}
                          </span>
                        </div>
                      </div>
                    );
                  },
                )
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="flex-[1]">
          <div className="flex flex-col gap-6 sticky top-0">
            <h3 className="text-base font-bold text-foreground mt-[72px]">
              Balance & Impact
            </h3>
            {detailData?.balance_projection ? (
              <div className="flex flex-col gap-1 text-sm w-full">
                {detailData.balance_projection.leave_type_name && (
                  <p className="text-xs font-semibold text-muted-foreground mb-2">
                    {detailData.balance_projection.leave_type_name}
                  </p>
                )}
                <div className="flex justify-between items-center py-2.5 text-muted-foreground font-medium">
                  <span>Available today</span>
                  <div className="text-right">
                    <span className="font-bold text-foreground">
                      {detailData.balance_projection.available_today_days} days
                    </span>
                    <span className="text-xs text-muted-foreground ml-1">
                      / {detailData.balance_projection.available_today_hours}{" "}
                      hrs
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center py-2.5 text-muted-foreground font-medium">
                  <span>Projected by leave date</span>
                  <div className="text-right">
                    <span className="font-bold text-foreground">
                      {
                        detailData.balance_projection
                          .projected_by_leave_date_days
                      }{" "}
                      days
                    </span>
                    <span className="text-xs text-muted-foreground ml-1">
                      /{" "}
                      {
                        detailData.balance_projection
                          .projected_by_leave_date_hours
                      }{" "}
                      hrs
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center py-3 mt-1 border-t border-border">
                  <span className="text-muted-foreground font-semibold">
                    After approval
                  </span>
                  <div className="text-right">
                    <span className="font-bold text-foreground">
                      {detailData.balance_projection.after_approval_days} days
                    </span>
                    <span className="text-xs text-muted-foreground ml-1">
                      / {detailData.balance_projection.after_approval_hours} hrs
                    </span>
                  </div>
                </div>
                <div className="flex items-start gap-2 text-[11px] text-muted-foreground font-medium mt-1">
                  <div className="bg-muted rounded-full p-0.5 shrink-0 mt-0.5">
                    <Info className="w-3 h-3 text-muted-foreground" />
                  </div>
                  <p>
                    {detailData.loss_of_pay
                      ? "Loss of Pay — weekends are included; public holidays are excluded."
                      : "Projections exclude weekends and holiday data."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4 text-sm w-full text-muted-foreground">
                <p className="text-xs">Balance projection not available.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-[260px] right-0 p-5 bg-card border-t border-border/60 flex justify-end z-10">
        <Button
          onClick={onBack}
          variant="outline"
          className="bg-card border-border text-primary px-8 font-semibold w-24"
        >
          Back
        </Button>
      </div>
    </div>
  );
};
