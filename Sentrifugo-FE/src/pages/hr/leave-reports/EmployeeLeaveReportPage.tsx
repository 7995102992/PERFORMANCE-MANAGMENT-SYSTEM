import { useMemo, useState, useCallback } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { DateRange } from "react-day-picker";
import {
  CalendarDays,
  Check,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Download,
  FileSpreadsheet,
  Inbox,
  RotateCcw,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/PageHeader";
import { TablePagination } from "@/components/shared/TablePagination";
import { EmptyState } from "@/components/shared/EmptyState";
import { SearchableSelect, type Option } from "@/components/shared/SearchableSelect";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebounce } from "@/hooks/use-debounce";
import { useInfiniteEmployees } from "@/hooks/use-infinite-employees";
import { cn } from "@/lib/utils";
import {
  fetchEmployeeLeaveReport,
  fetchEmployeeLeaveStatistics,
  fetchLeaveReportFilters,
  exportEmployeeLeaveReport,
} from "@/api/reports";
import type {
  EmployeeLeaveReportParams,
  LeaveBreakdownEntry,
} from "@/api/reports";

const STATUS_OPTIONS = [
  { label: "Approved", value: "APPROVED" },
  { label: "Pending", value: "PENDING" },
  { label: "Rejected", value: "REJECTED" },
  { label: "Cancelled", value: "CANCELLED" },
];

const TH =
  "text-xs font-medium text-muted-foreground uppercase tracking-wide h-10";

/** Inline status, matching the request-status convention (icon + text, no pill). */
function LeaveStatusCell({ status }: { status: string }) {
  const config: Record<
    string,
    { icon: typeof CircleCheck; className: string; label: string }
  > = {
    APPROVED: { icon: CircleCheck, className: "text-success", label: "Approved" },
    PENDING: { icon: Clock, className: "text-badge-pending-text", label: "Pending" },
    REJECTED: { icon: CircleX, className: "text-destructive", label: "Rejected" },
    CANCELLED: {
      icon: CircleSlash,
      className: "text-muted-foreground",
      label: "Cancelled",
    },
  };
  const entry = config[status] ?? {
    icon: Check,
    className: "text-muted-foreground",
    label: status || "—",
  };
  const Icon = entry.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <Icon className={cn("size-3.5 shrink-0", entry.className)} />
      {entry.label}
    </span>
  );
}

/**
 * Type-to-search, pick-many employee filter, backed by the leave service's own
 * employee pool — so the ids it yields join directly against the report's data.
 *
 * Results are paged server-side, which means a previously chosen employee can
 * fall outside the page currently loaded. `SearchableSelect` renders a chip's
 * raw value when it can't find the option, so every label ever seen is retained
 * and re-pinned; otherwise picking two people and typing a third name turns the
 * first two chips into ObjectIds.
 */
function EmployeeMultiSelect({
  value,
  onChange,
  businessUnitIds,
  departmentIds,
  className,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  businessUnitIds: string[];
  departmentIds: string[];
  className?: string;
}) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 300);
  // Labels of the currently-selected people, captured at the moment they are
  // picked — the one point where the label is guaranteed to be on hand. Entries
  // for deselected people fall away on the next change.
  const [pinnedLabels, setPinnedLabels] = useState<Record<string, string>>({});

  // The picker inherits the BU / department filters, so it only ever offers
  // people who could actually appear in the report below it.
  const { employees, isFetching, hasMore, loadMore } = useInfiniteEmployees({
    search: debouncedSearch || undefined,
    business_unit_ids: businessUnitIds.length ? businessUnitIds : undefined,
    department_ids: departmentIds.length ? departmentIds : undefined,
  });

  const fetched = useMemo<Option[]>(
    () =>
      employees
        .map((e) => {
          const id = e.user_id ?? e.id ?? "";
          const name = `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim() || "—";
          return { value: id, label: e.empCode ? `${name} (${e.empCode})` : name };
        })
        .filter((o) => o.value),
    [employees],
  );

  const options = useMemo<Option[]>(() => {
    const onPage = new Set(fetched.map((o) => o.value));
    const pinned = value
      .filter((id) => !onPage.has(id))
      .map((id) => ({ value: id, label: pinnedLabels[id] ?? id }));
    return [...pinned, ...fetched];
  }, [fetched, value, pinnedLabels]);

  const handleChange = (next: string | string[]) => {
    const ids = Array.isArray(next) ? next : [next];
    setPinnedLabels((prev) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          fetched.find((o) => o.value === id)?.label ?? prev[id] ?? id,
        ]),
      ),
    );
    onChange(ids);
  };

  return (
    <SearchableSelect
      multi
      options={options}
      value={value}
      onChange={handleChange}
      onSearchChange={setSearch}
      onLoadMore={loadMore}
      hasMore={hasMore}
      loading={isFetching && employees.length === 0}
      loadingMore={isFetching && employees.length > 0}
      placeholder="All Employees"
      emptyMessage="No matching employees"
      className={className}
    />
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: typeof Users;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
        <p className="text-2xl font-bold text-foreground">{value}</p>
      </div>
      <Icon className="size-8 shrink-0 text-muted-foreground" />
    </div>
  );
}

/** One breakdown block — the same Name / Requests / Days shape for every dimension. */
function BreakdownCard({
  title,
  entries,
  isLoading,
}: {
  title: string;
  entries: LeaveBreakdownEntry[];
  isLoading: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No leave recorded in this period.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-table-header border-b border-table-border">
                <th className={cn(TH, "text-left px-5")}>Name</th>
                <th className={cn(TH, "text-right px-3")}>Requests</th>
                <th className={cn(TH, "text-right px-5")}>Days</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.name} className="border-b last:border-0">
                  <td className="px-5 py-2.5 text-sm text-foreground">
                    {entry.name}
                  </td>
                  <td className="px-3 py-2.5 text-sm text-muted-foreground text-right">
                    {entry.requests}
                  </td>
                  <td className="px-5 py-2.5 text-sm text-foreground text-right">
                    {entry.days}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function EmployeeLeaveReportPage() {
  const [range, setRange] = useState<DateRange | undefined>(() => {
    const today = new Date();
    return { from: startOfMonth(today), to: endOfMonth(today) };
  });
  const [businessUnitIds, setBusinessUnitIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [leaveTypeIds, setLeaveTypeIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [isExporting, setIsExporting] = useState(false);

  const { data: options } = useQuery({
    queryKey: ["leave-report-filters"],
    queryFn: fetchLeaveReportFilters,
    staleTime: 5 * 60 * 1000,
  });

  // Both ends are required before anything can be fetched — a half-picked range
  // is not a period, so the queries stay disabled until the picker settles.
  const params: EmployeeLeaveReportParams | null = useMemo(() => {
    if (!range?.from || !range?.to) return null;
    return {
      from_date: format(range.from, "yyyy-MM-dd"),
      to_date: format(range.to, "yyyy-MM-dd"),
      business_unit_id: businessUnitIds,
      department_id: departmentIds,
      leave_type_id: leaveTypeIds,
      status: statuses,
      employee_id: employeeIds,
    };
  }, [range, businessUnitIds, departmentIds, leaveTypeIds, statuses, employeeIds]);

  const { data: report, isFetching: loadingRows } = useQuery({
    queryKey: ["employee-leave-report", params, page, pageSize],
    queryFn: () => fetchEmployeeLeaveReport({ ...params!, page, page_size: pageSize }),
    enabled: !!params,
    placeholderData: keepPreviousData,
  });

  const { data: stats, isFetching: loadingStats } = useQuery({
    queryKey: ["employee-leave-statistics", params],
    queryFn: () => fetchEmployeeLeaveStatistics(params!),
    enabled: !!params,
    placeholderData: keepPreviousData,
  });

  // A department belongs to one or more BUs; once BUs are picked, offering
  // departments outside them would only produce empty results.
  const departmentOptions = useMemo(() => {
    const all = options?.departments ?? [];
    const scoped = businessUnitIds.length
      ? all.filter((d) =>
          d.business_unit_ids.some((id) => businessUnitIds.includes(id)),
        )
      : all;
    return scoped.map((d) => ({ label: d.name, value: d.id }));
  }, [options, businessUnitIds]);

  const businessUnitOptions = useMemo(
    () => (options?.business_units ?? []).map((b) => ({ label: b.name, value: b.id })),
    [options],
  );
  const leaveTypeOptions = useMemo(
    () => (options?.leave_types ?? []).map((t) => ({ label: t.name, value: t.id })),
    [options],
  );

  const resetToFirstPage = useCallback(() => setPage(1), []);

  const handleBusinessUnitChange = (value: string | string[]) => {
    const next = Array.isArray(value) ? value : [value];
    setBusinessUnitIds(next);
    // Drop any department that the narrowed BU set no longer covers, so the
    // filter never silently excludes everything.
    setDepartmentIds((prev) =>
      next.length === 0
        ? prev
        : prev.filter((id) =>
            (options?.departments ?? [])
              .find((d) => d.id === id)
              ?.business_unit_ids.some((bu) => next.includes(bu)),
          ),
    );
    resetToFirstPage();
  };

  const handleReset = () => {
    const today = new Date();
    setRange({ from: startOfMonth(today), to: endOfMonth(today) });
    setBusinessUnitIds([]);
    setDepartmentIds([]);
    setLeaveTypeIds([]);
    setStatuses([]);
    setEmployeeIds([]);
    setPage(1);
  };

  const handleExport = async () => {
    if (!params) return;
    setIsExporting(true);
    try {
      const blob = await exportEmployeeLeaveReport(params);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Employee_Leave_Report_${params.from_date}_to_${params.to_date}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Leave report downloaded");
    } catch {
      toast.error("Failed to download the leave report");
    } finally {
      setIsExporting(false);
    }
  };

  const rows = report?.items ?? [];
  const totalCount = report?.total_count ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const startIndex = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalCount);
  const COLUMN_COUNT = 9;

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Employee Leave Reports"
        subtitle="Leave taken and approval details across the organisation, for any date range."
        action={
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExport}
            disabled={!params || isExporting}
          >
            <Download className="size-4" />
            {isExporting ? "Preparing…" : "Download Excel"}
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Requests"
          value={stats?.total_requests ?? 0}
          icon={FileSpreadsheet}
        />
        <StatCard
          label="Total Leave Days"
          value={stats?.total_days ?? 0}
          icon={CalendarDays}
        />
        <StatCard
          label="Employees on Leave"
          value={stats?.employees_on_leave ?? 0}
          icon={Users}
        />
        <StatCard
          label="Loss of Pay Days"
          value={stats?.loss_of_pay_days ?? 0}
          icon={CircleSlash}
        />
      </div>

      <div className="rounded-xl border overflow-hidden bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <EmployeeMultiSelect
            value={employeeIds}
            onChange={(ids) => {
              setEmployeeIds(ids);
              resetToFirstPage();
            }}
            businessUnitIds={businessUnitIds}
            departmentIds={departmentIds}
            className="flex-1 max-w-sm"
          />
          <DateRangePicker
            value={range}
            onChange={(next) => {
              setRange(next);
              resetToFirstPage();
            }}
            captionLayout="dropdown"
            placeholder="Select date range"
            className="h-9 w-[280px]"
          />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={handleReset}>
              <RotateCcw className="size-4" /> Reset
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3 border-b px-4 py-2">
          <SearchableSelect
            multi
            options={businessUnitOptions}
            value={businessUnitIds}
            onChange={handleBusinessUnitChange}
            placeholder="All Business Units"
            className="w-[220px]"
          />
          <SearchableSelect
            multi
            options={departmentOptions}
            value={departmentIds}
            onChange={(v) => {
              setDepartmentIds(Array.isArray(v) ? v : [v]);
              resetToFirstPage();
            }}
            placeholder="All Departments"
            className="w-[220px]"
          />
          <SearchableSelect
            multi
            options={leaveTypeOptions}
            value={leaveTypeIds}
            onChange={(v) => {
              setLeaveTypeIds(Array.isArray(v) ? v : [v]);
              resetToFirstPage();
            }}
            placeholder="All Leave Types"
            className="w-[200px]"
          />
          <SearchableSelect
            multi
            searchable={false}
            options={STATUS_OPTIONS}
            value={statuses}
            onChange={(v) => {
              setStatuses(Array.isArray(v) ? v : [v]);
              resetToFirstPage();
            }}
            placeholder="All Statuses"
            className="w-[180px]"
          />
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className={TH}>Employee</TableHead>
                <TableHead className={TH}>Business Unit</TableHead>
                <TableHead className={TH}>Department</TableHead>
                <TableHead className={TH}>Leave Type</TableHead>
                <TableHead className={TH}>From</TableHead>
                <TableHead className={TH}>To</TableHead>
                <TableHead className={cn(TH, "text-right")}>Days</TableHead>
                <TableHead className={TH}>Status</TableHead>
                <TableHead className={TH}>Approver</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingRows && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={COLUMN_COUNT}
                    className="text-center py-12 text-sm text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loadingRows && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="p-0">
                    <EmptyState
                      icon={Inbox}
                      title="No leave records found"
                      description={
                        params
                          ? "No leave requests match this period and filter combination."
                          : "Pick a date range to run the report."
                      }
                    />
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => (
                <TableRow key={row.request_id}>
                  <TableCell className="text-sm text-foreground">
                    <span className="font-medium">{row.employee_name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.emp_code || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.business_unit}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.department}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {row.leave_type}
                    {row.loss_of_pay && (
                      <span className="block text-xs text-destructive">
                        Loss of Pay
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {row.from_date ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {row.to_date ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {row.days}
                  </TableCell>
                  <TableCell>
                    <LeaveStatusCell status={row.status} />
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {row.action_by ?? row.current_approver ?? "—"}
                    <span className="block text-xs text-muted-foreground">
                      {row.action_on
                        ? format(new Date(row.action_on), "dd MMM yyyy")
                        : row.status === "PENDING"
                          ? "Awaiting action"
                          : "—"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <TablePagination
          currentPage={page}
          totalPages={totalPages}
          startIndex={startIndex}
          endIndex={endIndex}
          total={totalCount}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <BreakdownCard
          title="By Leave Type"
          entries={stats?.by_leave_type ?? []}
          isLoading={loadingStats}
        />
        <BreakdownCard
          title="By Business Unit"
          entries={stats?.by_business_unit ?? []}
          isLoading={loadingStats}
        />
        <BreakdownCard
          title="By Department"
          entries={stats?.by_department ?? []}
          isLoading={loadingStats}
        />
      </div>
    </div>
  );
}
