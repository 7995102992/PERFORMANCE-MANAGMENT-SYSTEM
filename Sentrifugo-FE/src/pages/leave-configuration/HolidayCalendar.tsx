import { useEffect, useMemo, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  getFilteredRowModel,
  getPaginationRowModel,
} from "@tanstack/react-table";
import {
  Search,
  Edit2,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  UserPlus,
  Copy,
  Settings,
  Calendar as CalendarIcon,
  X,
  AlertTriangle,
  Upload,
  Plus,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  useGetHolidayPlansQuery,
  useGetHolidayPlanQuery,
  useGetHolidaysQuery,
  useGetHolidaysCalendarQuery,
  useGetClassificationsQuery,
  useCreateClassificationMutation,
  useUpdateClassificationMutation,
  useLazyDownloadHolidayBulkTemplateQuery,
  useValidateHolidayBulkUploadMutation,
  useBulkImportHolidaysFromFileMutation,
} from "@/store/api/lmsApi";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import type {
  HolidayPlanListItem,
  ClassificationResponse,
} from "@/types/leave";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
} from "@/store/api/iamApi";
import { PageLoader } from "@/components/shared/PageLoader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { ColorPicker } from "@/components/shared/ColorPicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import { toast } from "@/lib/toast";
import { deptLabel } from "@/lib/utils";
import { AddEmployeesToPlan } from "./AddEmployeesToPlan";
import { ImportHolidaysFromPlan } from "./ImportHolidaysFromPlan";
import HolidayForm from "./HolidayForm";
import { BulkUploadHolidaysDialog } from "@/components/shared/BulkUploadHolidaysDialog";
import { EmptyState } from "@/components/shared/EmptyState";

type Holiday = {
  id: string;
  name: string;
  date: string;
  classificationId: string;
  classificationName: string;
  classificationColor: string;
  description: string;
};

const DEFAULT_COLOR = "#9A9EAC";

const columnHelper = createColumnHelper<Holiday>();

function buildPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");
  for (
    let i = Math.max(2, current - 1);
    i <= Math.min(total - 1, current + 1);
    i++
  )
    pages.push(i);
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

const HolidayCalendar = () => {
  const navigate = useNavigate();

  const [isAddingEmployees, setIsAddingEmployees] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showImportFromPlan, setShowImportFromPlan] = useState(false);
  const [holidayFormOpen, setHolidayFormOpen] = useState(false);
  const [holidayFormMode, setHolidayFormMode] = useState<"create" | "edit">(
    "create",
  );
  const [editingHolidayId, setEditingHolidayId] = useState<string | undefined>(
    undefined,
  );
  const [bulkOpen, setBulkOpen] = useState(false);
  const [planSearch, setPlanSearch] = useState("");

  const [globalFilter, setGlobalFilter] = useState("");
  const [classificationFilter, setClassificationFilter] = useState("");
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>();
  const [appliedRange, setAppliedRange] = useState<DateRange | undefined>();
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [activePlan, setActivePlan] = useState<string>("");
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [currentMonthDate, setCurrentMonthDate] = useState(() => new Date());

  const { data: plansData, isLoading: isLoadingPlans } =
    useGetHolidayPlansQuery();
  const { data: activePlanData, isFetching: isFetchingPlanDetail } =
    useGetHolidayPlanQuery(activePlan, { skip: !activePlan });

  const { data: holidaysData, isFetching: isFetchingHolidays } =
    useGetHolidaysQuery({ planId: activePlan }, { skip: !activePlan });
  const { data: busData = [] } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptsData = [] } = useGetDepartmentsQuery({ is_active: true });
  const { data: classifications = [] } = useGetClassificationsQuery();

  const [triggerDownloadTemplate] = useLazyDownloadHolidayBulkTemplateQuery();
  const [validateBulkUpload] = useValidateHolidayBulkUploadMutation();
  const [bulkImportHolidays] = useBulkImportHolidaysFromFileMutation();
  // Active plans first, inactive below (stable within each group).
  const plans = useMemo(() => {
    const list = Array.isArray(plansData) ? plansData : [];
    return [...list].sort((a, b) => Number(b.is_active) - Number(a.is_active));
  }, [plansData]);
  const holidays = holidaysData?.items ?? [];

  const planYear = activePlanData?.year;
  const isPlanInactive =
    activePlanData != null && activePlanData.is_active === false;

  const activeBuNames = (activePlanData?.business_units ?? [])
    .map((bu: any) => busData.find((b) => b.id === bu.id)?.business_unit_name)
    .filter(Boolean) as string[];

  const activeDeptNames = (activePlanData?.departments ?? [])
    .map((d: any) => {
      const dept = deptsData.find((dept) => dept.id === d.id);
      return dept ? deptLabel(dept) : undefined;
    })
    .filter(Boolean) as string[];

  useEffect(() => {
    if (plans.length > 0 && !activePlan) {
      setActivePlan(plans[0]._id);
    }
  }, [plans, activePlan]);

  // Reset calendar and filters when plan changes
  useEffect(() => {
    if (planYear) setCurrentMonthDate(new Date(planYear, 0, 1));
    setClassificationFilter("");
    setPendingRange(undefined);
    setAppliedRange(undefined);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [activePlan, planYear]);

  // Reset to first page whenever any filter changes
  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [globalFilter, classificationFilter, appliedRange]);

  const toDateStr = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const toHoliday = (h: any): Holiday => ({
    id: h._id,
    name: h.name,
    date: h.date,
    classificationId: h.classification?.id ?? "",
    classificationName: h.classification?.name ?? "Uncategorized",
    classificationColor: h.classification?.color ?? DEFAULT_COLOR,
    description: "",
  });

  const data = useMemo<Holiday[]>(() => holidays.map(toHoliday), [holidays]);

  const filteredData = useMemo(() => {
    let result = data;
    if (classificationFilter) {
      result = result.filter(
        (h) => h.classificationId === classificationFilter,
      );
    }
    if (appliedRange?.from) {
      const fromStr = toDateStr(appliedRange.from);
      const toStr = toDateStr(appliedRange.to ?? appliedRange.from);
      result = result.filter((h) => h.date >= fromStr && h.date <= toStr);
    }
    return result;
  }, [data, classificationFilter, appliedRange]);

  const fmt = (d: Date) =>
    d
      .toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      .replace(/ /g, "-");
  const dateRangeLabel = appliedRange?.from
    ? appliedRange.to &&
      appliedRange.to.getTime() !== appliedRange.from.getTime()
      ? `${fmt(appliedRange.from)} – ${fmt(appliedRange.to)}`
      : fmt(appliedRange.from)
    : null;

  const { fromDate, toDate } = useMemo(() => {
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth();
    const mm = String(month + 1).padStart(2, "0");
    const lastDay = new Date(year, month + 1, 0).getDate();
    return {
      fromDate: `${year}-${mm}-01`,
      toDate: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
    };
  }, [currentMonthDate]);

  const { data: calendarApiData, isLoading: isLoadingCalendar } =
    useGetHolidaysCalendarQuery(
      { planId: activePlan, fromDate, toDate },
      { skip: viewMode !== "calendar" || !activePlan },
    );

  const calendarData = useMemo<Holiday[]>(
    () => (calendarApiData ?? []).map(toHoliday),
    [calendarApiData],
  );

  const getHolidaysForDate = (dateStr: string) =>
    (viewMode === "calendar" ? calendarData : data).filter(
      (h) => h.date === dateStr,
    );

  // Calendar navigation — restrict to plan year
  const canGoPrevMonth = planYear
    ? currentMonthDate.getFullYear() > planYear ||
      (currentMonthDate.getFullYear() === planYear &&
        currentMonthDate.getMonth() > 0)
    : true;
  const canGoNextMonth = planYear
    ? currentMonthDate.getFullYear() < planYear ||
      (currentMonthDate.getFullYear() === planYear &&
        currentMonthDate.getMonth() < 11)
    : true;

  const goToPrevMonth = () => {
    if (canGoPrevMonth)
      setCurrentMonthDate(
        (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
      );
  };
  const goToNextMonth = () => {
    if (canGoNextMonth)
      setCurrentMonthDate(
        (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
      );
  };

  const calendarGrid = useMemo<
    { day: number; isCurrentMonth: boolean; dateStr: string }[]
  >(() => {
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const days: { day: number; isCurrentMonth: boolean; dateStr: string }[] =
      [];
    for (let i = firstDay - 1; i >= 0; i--) {
      const prevYear = month === 0 ? year - 1 : year;
      const dStr = `${prevYear}-${String(month === 0 ? 12 : month).padStart(2, "0")}-${String(prevMonthDays - i).padStart(2, "0")}`;
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

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: "Holiday Name",
        cell: (info) => (
          <span className="font-medium text-muted-foreground">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor("date", {
        header: "Date",
        cell: (info) => {
          const [y, m, d] = info.getValue().split("-").map(Number);
          const dateObj = new Date(y, m - 1, d);
          const weekday = dateObj.toLocaleDateString("en-GB", {
            weekday: "short",
          });
          const datePart = dateObj
            .toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
            .replace(/ /g, "-");
          return (
            <span className="text-muted-foreground">
              {`${weekday}, ${datePart}`}
            </span>
          );
        },
      }),
      columnHelper.accessor("classificationName", {
        header: "Classification",
        cell: ({ row }) => {
          const color = row.original.classificationColor;
          return (
            <Badge
              className="border-0"
              style={{ backgroundColor: `${color}18`, color }}
            >
              {row.original.classificationName}
            </Badge>
          );
        },
      }),
      columnHelper.accessor("description", {
        header: "Description",
        cell: (info) => (
          <span className="text-sm text-muted-foreground">
            {info.getValue() || "—"}
          </span>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { globalFilter, pagination },
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  // Initial load — block the whole page until plans arrive so the user
  // doesn't see the Add CTA pop in before the data.
  if (isLoadingPlans) {
    return <PageLoader message="Loading holiday plans…" />;
  }

  // --- VIEW: MAIN DASHBOARD ---
  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Sidebar with plans */}
      <aside className="w-full md:w-72 border-b md:border-b-0 md:border-r border-border p-3 md:p-4 flex flex-col gap-4">
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={14}
          />
          <Input
            type="text"
            placeholder="Search Holiday Plan"
            className="w-full pl-9 bg-muted/40 border-transparent"
            value={planSearch}
            onChange={(e) => setPlanSearch(e.target.value)}
          />
        </div>
        <Button
          onClick={() =>
            navigate({ to: "/leave-management/holiday-calendar/add-plan" })
          }
          className="w-full"
        >
          Add New Plan
        </Button>
        <div className="space-y-1 flex-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
            Holiday Plans
          </p>
          {isLoadingPlans ? (
            <PageLoader message="Loading plans…" />
          ) : (
            plans
              .filter(
                (p) =>
                  !planSearch.trim() ||
                  p.name.toLowerCase().includes(planSearch.toLowerCase()),
              )
              .map((plan: HolidayPlanListItem) => (
                <div
                  key={plan._id}
                  onClick={() => setActivePlan(plan._id)}
                  className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-colors ${activePlan === plan._id ? "bg-primary/10 text-primary font-semibold border border-primary/20" : "text-foreground hover:bg-muted border border-transparent"}`}
                >
                  <span
                    className={`text-sm truncate ${!plan.is_active ? "text-muted-foreground line-through" : ""}`}
                  >
                    {plan.name}
                  </span>
                  <button
                    className="p-0.5 rounded hover:bg-muted-foreground/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate({
                        to: `/leave-management/holiday-calendar/${plan._id}/edit-plan`,
                      });
                    }}
                  >
                    <Edit2 size={14} className="text-muted-foreground" />
                  </button>
                </div>
              ))
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 px-4 sm:px-6 pt-3 pb-6 overflow-y-auto">
        {!isLoadingPlans && plans.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No holiday plans created"
            description="Create one to get started"
            action={
              <Button
                onClick={() =>
                  navigate({
                    to: "/leave-management/holiday-calendar/add-plan",
                  })
                }
              >
                <Plus /> Create Holiday Plan
              </Button>
            }
          />
        ) : !activePlan || isFetchingPlanDetail || isFetchingHolidays ? (
          <PageLoader message="Loading holidays…" />
        ) : (
          <>
            {/* Plan detail header */}
            <div className="flex items-start justify-between gap-4 mb-8">
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <h1 className="text-2xl font-bold">
                    {activePlanData?.name ?? "—"}
                  </h1>
                  {planYear && <Badge variant="outline">{planYear}</Badge>}
                  {isPlanInactive && (
                    <Badge variant="secondary">Inactive</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-6 md:gap-10">
                  {activeBuNames.length > 0 && (
                    <CollapsibleTags
                      label="Business Units"
                      items={activeBuNames}
                      limit={2}
                    />
                  )}
                  {activeDeptNames.length > 0 && (
                    <CollapsibleTags
                      label="Departments"
                      items={activeDeptNames}
                      limit={2}
                    />
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => setIsAddingEmployees(true)}
                disabled={isPlanInactive}
                title={
                  isPlanInactive
                    ? "Activate this plan to manage employees"
                    : undefined
                }
              >
                <UserPlus /> Manage Employees
              </Button>
            </div>

            {isPlanInactive && (
              <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-badge-pending-bg px-4 py-3 mb-6">
                <AlertTriangle className="size-4 shrink-0 text-warning" />
                <p className="text-sm text-foreground">
                  This holiday plan is inactive. Activate it via{" "}
                  <strong>Edit</strong> to manage holidays and employees.
                </p>
              </div>
            )}

            {/* Toolbar */}
            <div className="space-y-3 mb-6">
              {/* Row 1: view toggle + holiday actions */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex bg-muted p-1 rounded-xl text-xs font-medium shrink-0">
                  <button
                    onClick={() => setViewMode("list")}
                    className={`px-3 py-1.5 rounded-md transition-colors ${viewMode === "list" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
                  >
                    List
                  </button>
                  <button
                    onClick={() => setViewMode("calendar")}
                    className={`px-3 py-1.5 rounded-md transition-colors ${viewMode === "calendar" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
                  >
                    Calendar
                  </button>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {classifications.length > 0 ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowImportFromPlan(true)}
                        disabled={isPlanInactive}
                      >
                        <Copy /> Import from Plan
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setBulkOpen(true)}
                        disabled={isPlanInactive}
                      >
                        <Upload /> Bulk Import
                      </Button>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => setShowSettings(true)}
                        title="Settings"
                      >
                        <Settings className="size-4" />
                      </Button>
                      <div className="w-px h-6 bg-border" />
                      <Button
                        size="sm"
                        onClick={() => {
                          setEditingHolidayId(undefined);
                          setHolidayFormMode("create");
                          setHolidayFormOpen(true);
                        }}
                        disabled={isPlanInactive}
                      >
                        <Plus /> Add Holiday
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Add classifications in Settings before adding holidays
                      </span>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => setShowSettings(true)}
                        title="Settings"
                      >
                        <Settings className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {/* Row 2: search + filters */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="relative w-56">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    size={16}
                  />
                  <Input
                    type="text"
                    placeholder="Search holidays..."
                    value={globalFilter}
                    onChange={(e) => setGlobalFilter(e.target.value)}
                    className="w-full pl-10"
                  />
                </div>
                {classifications.length > 0 && (
                  <Select
                    value={classificationFilter || "all"}
                    onValueChange={(v) =>
                      setClassificationFilter(v === "all" ? "" : v)
                    }
                  >
                    <SelectTrigger className="w-44 h-9 text-sm">
                      <SelectValue placeholder="All classifications" />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="start"
                      className="w-44"
                    >
                      <SelectItem value="all">All classifications</SelectItem>
                      {classifications.map((c) => (
                        <SelectItem key={c.id ?? c._id} value={c.id ?? c._id}>
                          <span className="flex items-center gap-2">
                            <span
                              className="size-2 rounded-full shrink-0 inline-block"
                              style={{ backgroundColor: c.color }}
                            />
                            {c.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Popover
                  open={datePickerOpen}
                  onOpenChange={(open) => {
                    if (!open) setPendingRange(appliedRange);
                    setDatePickerOpen(open);
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-sm transition-colors
                                            ${
                                              dateRangeLabel
                                                ? "border-primary/40 bg-primary/5 text-primary font-medium"
                                                : "border-input bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                            }`}
                    >
                      <CalendarIcon className="size-4 shrink-0" />
                      <span>{dateRangeLabel ?? "Filter by date"}</span>
                      {dateRangeLabel && (
                        <span
                          role="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingRange(undefined);
                            setAppliedRange(undefined);
                          }}
                          className="ml-0.5 rounded-sm p-0.5 hover:bg-primary/20"
                        >
                          <X />
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <div className="border-b border-border px-3 py-2.5">
                      <p className="text-xs font-semibold text-foreground">
                        Filter by date range
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {pendingRange?.from && pendingRange?.to
                          ? `${fmt(pendingRange.from)} – ${fmt(pendingRange.to)}`
                          : pendingRange?.from
                            ? `From ${fmt(pendingRange.from)} — pick an end date, or apply for a single day`
                            : "Click a start date, then an end date"}
                      </p>
                    </div>
                    <Calendar
                      mode="range"
                      selected={pendingRange}
                      onSelect={setPendingRange}
                      numberOfMonths={2}
                      {...(planYear
                        ? {
                            fromMonth: new Date(planYear, 0, 1),
                            toMonth: new Date(planYear, 11, 31),
                            defaultMonth: new Date(planYear, 0, 1),
                          }
                        : {})}
                    />
                    <div className="border-t border-border px-3 py-2 flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {pendingRange?.from && pendingRange?.to
                          ? `${Math.round((pendingRange.to.getTime() - pendingRange.from.getTime()) / 86400000) + 1} days`
                          : pendingRange?.from
                            ? "1 day"
                            : "No range selected"}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingRange(undefined)}
                          disabled={!pendingRange?.from}
                        >
                          Clear
                        </Button>
                        <Button
                          size="sm"
                          disabled={!pendingRange?.from}
                          onClick={() => {
                            setAppliedRange(pendingRange);
                            setDatePickerOpen(false);
                          }}
                        >
                          Apply
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {/* Content: list or calendar */}
            {viewMode === "list" ? (
              <div className="rounded-xl border overflow-x-auto bg-card">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                      {table.getHeaderGroups().map((headerGroup) =>
                        headerGroup.headers.map((header) => (
                          <TableHead
                            key={header.id}
                            className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10"
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                          </TableHead>
                        )),
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={columns.length} className="p-0">
                          <EmptyState
                            icon={CalendarDays}
                            title="No holidays found"
                            description="Add holidays to this plan to get started."
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      table.getRowModel().rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => {
                            setEditingHolidayId(row.original.id);
                            setHolidayFormMode("edit");
                            setHolidayFormOpen(true);
                          }}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              className="text-muted-foreground"
                            >
                              {flexRender(
                                cell.column.columnDef.cell,
                                cell.getContext(),
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                {table.getPageCount() > 1 && (
                  <div className="px-4 sm:px-6 py-4 flex items-center justify-between border-t border-border">
                    <p className="text-sm text-muted-foreground">
                      Showing {pagination.pageIndex * pagination.pageSize + 1}–
                      {Math.min(
                        (pagination.pageIndex + 1) * pagination.pageSize,
                        table.getFilteredRowModel().rows.length,
                      )}{" "}
                      of {table.getFilteredRowModel().rows.length}
                    </p>
                    <div className="flex gap-1 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!table.getCanPreviousPage()}
                        onClick={() => table.previousPage()}
                      >
                        Previous
                      </Button>
                      {buildPageNumbers(
                        pagination.pageIndex + 1,
                        table.getPageCount(),
                      ).map((p, i) =>
                        p === "..." ? (
                          <span
                            key={`ellipsis-${i}`}
                            className="px-2 py-1 text-sm text-muted-foreground self-center"
                          >
                            …
                          </span>
                        ) : (
                          <Button
                            key={p}
                            variant={
                              p === pagination.pageIndex + 1
                                ? "default"
                                : "outline"
                            }
                            size="sm"
                            onClick={() =>
                              table.setPageIndex((p as number) - 1)
                            }
                          >
                            {p}
                          </Button>
                        ),
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!table.getCanNextPage()}
                        onClick={() => table.nextPage()}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                {isLoadingCalendar && (
                  <PageLoader message="Loading calendar…" />
                )}
                <div
                  className={`flex items-center justify-between gap-4 mb-6 ${isLoadingCalendar ? "opacity-50 pointer-events-none" : ""}`}
                >
                  <div className="flex items-center gap-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={!canGoPrevMonth}
                      onClick={goToPrevMonth}
                    >
                      <ChevronLeft />
                    </Button>
                    <h2 className="text-sm font-semibold text-foreground min-w-[140px] text-center">
                      {currentMonthDate.toLocaleString("default", {
                        month: "long",
                      })}{" "}
                      {currentMonthDate.getFullYear()}
                    </h2>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={!canGoNextMonth}
                      onClick={goToNextMonth}
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
                <div className="mb-6 overflow-hidden overflow-x-auto rounded-xl border">
                  <div className="grid grid-cols-7 min-w-[560px]">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                      (day) => (
                        <div
                          key={day}
                          className="border-b border-r border-table-border bg-table-header px-3 py-2.5 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
                        >
                          {day}
                        </div>
                      ),
                    )}
                    {calendarGrid.map((cell, i) => {
                      const cellHolidays = getHolidaysForDate(cell.dateStr);
                      const isRightEdge = (i + 1) % 7 === 0;
                      const borderClasses = `border-b ${!isRightEdge ? "border-r" : ""} border-table-border`;
                      return (
                        <div
                          key={cell.dateStr}
                          className={`min-h-[110px] p-2 ${borderClasses} ${!cell.isCurrentMonth ? "bg-muted/20" : ""}`}
                        >
                          <div className="flex justify-end">
                            <span className="flex size-6 items-center justify-center rounded-full bg-table-header text-xs font-medium text-muted-foreground">
                              {cell.day}
                            </span>
                          </div>
                          {cellHolidays.map((hol) => (
                            <div
                              key={hol.id}
                              className={`mt-1 flex items-center gap-1 ${isPlanInactive ? "" : "cursor-pointer hover:opacity-75"}`}
                              onClick={
                                isPlanInactive
                                  ? undefined
                                  : () => {
                                      setEditingHolidayId(hol.id);
                                      setHolidayFormMode("edit");
                                      setHolidayFormOpen(true);
                                    }
                              }
                            >
                              <span
                                className="size-1.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: hol.classificationColor,
                                }}
                              />
                              <span className="truncate text-[11px] font-medium text-foreground leading-tight">
                                {hol.name}
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
                {classifications.length > 0 && (
                  <div className="flex items-center justify-center gap-6">
                    {classifications.map((c) => (
                      <div
                        key={c.id ?? c._id}
                        className="flex items-center gap-2"
                      >
                        <div
                          className="size-2 rounded-full"
                          style={{ backgroundColor: c.color }}
                        />
                        <span className="text-xs text-muted-foreground">
                          {c.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {showSettings && (
        <ClassificationSettings
          classifications={classifications}
          onClose={() => setShowSettings(false)}
        />
      )}

      <BulkUploadHolidaysDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        planYear={planYear}
        onDownloadTemplate={async () => {
          try {
            const { data: blob } = await triggerDownloadTemplate(activePlan);
            if (blob) {
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "holiday-bulk-template.xlsx";
              a.click();
              URL.revokeObjectURL(url);
            }
          } catch (err) {
            toast.error(err, "Failed to download template");
          }
        }}
        onValidate={async (file) => {
          const res = await validateBulkUpload({
            planId: activePlan,
            file,
          }).unwrap();
          return res;
        }}
        onImport={async (holidays) => {
          const res = await bulkImportHolidays({
            planId: activePlan,
            holidays,
          }).unwrap();
          return { imported: res.imported, skipped: res.skipped };
        }}
        entityName="holiday plan"
      />

      <Sheet
        open={holidayFormOpen}
        onOpenChange={(v) => {
          if (!v) setHolidayFormOpen(false);
        }}
      >
        <SheetContent className="w-[80vw] max-w-[80vw] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>
              {holidayFormMode === "create" ? "Add Holiday" : "Edit Holiday"}
            </SheetTitle>
            <SheetDescription>
              {holidayFormMode === "create"
                ? "Add a new holiday to the plan."
                : "Update holiday details."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {holidayFormOpen && activePlan && (
              <HolidayForm
                mode={holidayFormMode}
                embeddedPlanId={activePlan}
                embeddedHolidayId={editingHolidayId}
                onClose={() => setHolidayFormOpen(false)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={isAddingEmployees && !!activePlanData}
        onOpenChange={(v) => {
          if (!v) setIsAddingEmployees(false);
        }}
      >
        <SheetContent className="w-[80vw] max-w-[80vw] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Manage Employees</SheetTitle>
            <SheetDescription>
              Add or remove employees from the holiday plan.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {isAddingEmployees && activePlanData && (
              <AddEmployeesToPlan
                planData={activePlanData}
                onClose={() => setIsAddingEmployees(false)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={showImportFromPlan && !!activePlan}
        onOpenChange={(v) => {
          if (!v) setShowImportFromPlan(false);
        }}
      >
        <SheetContent className="w-[80vw] max-w-[80vw] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>Import Holidays from Plan</SheetTitle>
            <SheetDescription>
              Select holidays from another plan to import.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {showImportFromPlan && activePlan && (
              <ImportHolidaysFromPlan
                targetPlanId={activePlan}
                targetPlanYear={planYear}
                onClose={() => setShowImportFromPlan(false)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};

// ─── Classification Settings Dialog ──────────────────────────────────────────

function ClassificationSettings({
  classifications,
  onClose,
}: {
  classifications: ClassificationResponse[];
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6F5CFF");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");

  const [createClassification, { isLoading: isCreating }] =
    useCreateClassificationMutation();
  const [updateClassification] = useUpdateClassificationMutation();
  const confirm = useConfirm();

  const handleClose = () => {
    if (editId || newName.trim()) {
      confirm({
        title: "Discard changes?",
        description:
          "You have unsaved changes. Are you sure you want to close?",
        variant: "destructive",
        confirmText: "Discard",
        onConfirm: onClose,
      });
    } else {
      onClose();
    }
  };

  const norm = (c: string) => c.trim().toLowerCase();

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      toast.error("Classification name is required");
      return;
    }
    if (classifications.some((c) => norm(c.color) === norm(newColor))) {
      toast.error(
        "A classification with this color already exists. Pick a different color.",
      );
      return;
    }
    try {
      await createClassification({ name: trimmed, color: newColor }).unwrap();
      setNewName("");
      setNewColor("#6F5CFF");
      toast.success("Classification added");
    } catch (err) {
      toast.error(err, "Failed to add classification");
    }
  };

  const startEdit = (c: ClassificationResponse) => {
    setEditId(c.id ?? c._id);
    setEditName(c.name);
    setEditColor(c.color);
  };

  const handleSave = async () => {
    if (!editId) return;
    if (!editName.trim()) {
      toast.error("Classification name is required");
      return;
    }
    if (
      classifications.some(
        (c) => (c.id ?? c._id) !== editId && norm(c.color) === norm(editColor),
      )
    ) {
      toast.error(
        "Another classification already uses this color. Pick a different color.",
      );
      return;
    }
    try {
      await updateClassification({
        id: editId,
        body: { name: editName.trim(), color: editColor },
      }).unwrap();
      setEditId(null);
      toast.success("Classification updated");
    } catch (err) {
      toast.error(err, "Failed to update classification");
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[520px] flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 py-5 border-b">
          <SheetTitle>Holiday Settings</SheetTitle>
          <SheetDescription>
            Manage holiday classifications and their colors.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Add Classification */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              Add Classification
            </h3>
            <div className="flex items-center gap-2">
              <ColorPicker value={newColor} onChange={setNewColor} />
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., National, Regional, Optional"
                className="h-9 text-sm flex-1"
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
              <Button
                size="sm"
                onClick={handleAdd}
                disabled={!newName.trim() || isCreating}
              >
                Add
              </Button>
            </div>
          </div>

          {/* Existing classifications */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              Existing Classifications
            </h3>
            <div className="space-y-3">
              {classifications.map((c) => (
                <div key={c.id ?? c._id} className="flex items-center gap-3">
                  {editId === (c.id ?? c._id) ? (
                    <>
                      <ColorPicker value={editColor} onChange={setEditColor} />
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-9 text-sm flex-1"
                        onKeyDown={(e) => e.key === "Enter" && handleSave()}
                      />
                      <Button size="sm" onClick={handleSave}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditId(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <div
                        className="size-5 rounded-sm border border-border/50 shrink-0"
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="text-sm font-medium flex-1">
                        {c.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => startEdit(c)}
                      >
                        <Edit2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              ))}
              {classifications.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No classifications yet. Add one above.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="border-t px-6 py-4 flex items-center justify-end">
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CollapsibleTags({
  label,
  items,
  limit = 3,
}: {
  label: string;
  items: string[];
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, limit);
  const overflow = items.length - limit;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5 max-w-md">
        {visible.map((name) => (
          <Badge key={name} variant="secondary" className="text-xs">
            {name}
          </Badge>
        ))}
        {!expanded && overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
          >
            +{overflow} more
          </button>
        )}
        {expanded && items.length > limit && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
          >
            show less
          </button>
        )}
      </div>
    </div>
  );
}

export default HolidayCalendar;
