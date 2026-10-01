import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/PageHeader";
import { TablePagination } from "@/components/shared/TablePagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppSelector } from "@/store";
import { useLeavePlans } from "@/hooks/use-leave-plans";
import {
  fetchYearEndReport,
  fetchYearEndYears,
  exportYearEndReport,
  fetchCurrentBalanceReport,
  exportCurrentBalanceReport,
} from "@/api/reports";
import type { YearEndEmployee, BalanceEmployee } from "@/api/reports";

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function StatusCell({ status }: { status: string }) {
  const isSuccess = status === "SUCCESS";
  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded ${isSuccess
        ? "bg-success/10 text-success"
        : "bg-destructive/10 text-destructive"
        }`}
    >
      {status}
    </span>
  );
}

function YearEndTab() {
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id ?? "");
  const { data: plans = [] } = useLeavePlans(orgId);

  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (plans.length > 0 && !selectedPlanId) {
      setSelectedPlanId(plans[0]._id);
    }
  }, [plans, selectedPlanId]);

  const { data: years = [] } = useQuery({
    queryKey: ["year-end-years", selectedPlanId],
    queryFn: () => fetchYearEndYears(selectedPlanId),
    enabled: !!selectedPlanId,
  });

  useEffect(() => {
    if (years.length > 0 && selectedYear === null) {
      setSelectedYear(years[0]);
    }
  }, [years, selectedYear]);

  const { data: report, isLoading } = useQuery({
    queryKey: [
      "year-end-report",
      selectedPlanId,
      selectedYear,
      debouncedSearch,
      page,
      pageSize,
    ],
    queryFn: () =>
      fetchYearEndReport({
        leave_plan_id: selectedPlanId,
        year: selectedYear!,
        search: debouncedSearch || undefined,
        page,
        page_size: pageSize,
      }),
    enabled: !!selectedPlanId && selectedYear !== null,
  });

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, selectedPlanId, selectedYear]);

  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExport = async () => {
    if (!selectedPlanId || selectedYear === null) return;
    try {
      const blob = await exportYearEndReport({
        leave_plan_id: selectedPlanId,
        year: selectedYear,
        search: debouncedSearch || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Year_End_Report_${selectedYear}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report exported successfully");
    } catch {
      toast.error("Failed to export report");
    }
  };

  const employees = report?.employees ?? [];
  const totalCount = report?.total_count ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);
  const startIndex = (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalCount);

  return (
    <div className="rounded-xl border overflow-x-auto bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, code, department..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
          <SelectTrigger className="w-[200px] h-9">
            <SelectValue placeholder="Select leave plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((p) => (
              <SelectItem key={p._id} value={p._id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedYear !== null && (
          <Select
            value={String(selectedYear)}
            onValueChange={(v) => setSelectedYear(Number(v))}
          >
            <SelectTrigger className="w-[120px] h-9">
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto">
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExport}
            disabled={!selectedPlanId || selectedYear === null}
          >
            <Download className="size-4" /> Export
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-8" />
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              #
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Emp Code
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Employee Name
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Department
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Business Unit
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Year
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Opening
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Payout
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Encash
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Carry Fwd
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Expired
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Closing
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Status
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={14} className="text-center py-12 text-sm text-muted-foreground">
                Loading...
              </TableCell>
            </TableRow>
          )}
          {!isLoading && employees.length === 0 && (
            <TableRow>
              <TableCell colSpan={14} className="text-center py-12 text-sm text-muted-foreground">
                No records found
              </TableCell>
            </TableRow>
          )}
          {employees.map((emp: YearEndEmployee, idx: number) => {
            const isExpanded = expandedRows.has(emp.employee_id);
            const hasDetails = emp.leave_type_details && emp.leave_type_details.length > 0;
            return (
              <>
                <TableRow
                  key={emp.employee_id}
                  className={hasDetails ? "cursor-pointer" : ""}
                  onClick={() => hasDetails && toggleRow(emp.employee_id)}
                >
                  <TableCell className="w-8 px-2">
                    {hasDetails && (
                      isExpanded
                        ? <ChevronDown className="size-4 text-muted-foreground" />
                        : <ChevronRight className="size-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {startIndex + idx}
                  </TableCell>
                  <TableCell className="text-sm text-foreground font-medium">
                    {emp.emp_code}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {emp.name}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {emp.department}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {emp.business_unit}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {emp.year}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.opening_balance}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.payout_amount}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.encashed_amount}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.carry_forward_amount}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.expired_amount}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.closing_balance}
                  </TableCell>
                  <TableCell>
                    <StatusCell status={emp.status} />
                  </TableCell>
                </TableRow>
                {isExpanded && hasDetails && (
                  <TableRow key={`${emp.employee_id}-details`}>
                    <TableCell colSpan={14} className="bg-muted/20 px-8 py-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        Leave Type Breakdown
                      </p>
                      <div className="rounded-xl border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-table-header hover:bg-table-header">
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8">
                                Leave Type
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Opening
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Payout
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Encash
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Carry Forward
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Expired
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Closing
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {emp.leave_type_details.map((d) => (
                              <TableRow key={d.leave_type_id}>
                                <TableCell className="text-sm text-foreground">
                                  {d.leave_type_name}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.opening_balance}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.payout_amount}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.encashed_amount}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.carry_forward_amount}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.expired_amount}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.closing_balance}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            );
          })}
        </TableBody>
      </Table>

      {totalCount > 0 && (
        <div className="border-t">
          <TablePagination
            currentPage={page}
            totalPages={totalPages}
            startIndex={startIndex}
            endIndex={endIndex}
            total={totalCount}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}
    </div>
  );
}

function CurrentBalanceTab() {
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id ?? "");
  const { data: plans = [] } = useLeavePlans(orgId);

  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (plans.length > 0 && !selectedPlanId) {
      setSelectedPlanId(plans[0]._id);
    }
  }, [plans, selectedPlanId]);

  const { data: report, isLoading } = useQuery({
    queryKey: [
      "current-balance-report",
      selectedPlanId,
      debouncedSearch,
      page,
      pageSize,
    ],
    queryFn: () =>
      fetchCurrentBalanceReport({
        leave_plan_id: selectedPlanId,
        search: debouncedSearch || undefined,
        page,
        page_size: pageSize,
      }),
    enabled: !!selectedPlanId,
  });

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, selectedPlanId]);

  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExport = async () => {
    if (!selectedPlanId) return;
    try {
      const blob = await exportCurrentBalanceReport({
        leave_plan_id: selectedPlanId,
        search: debouncedSearch || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Current_Leave_Balance.xlsx";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report exported successfully");
    } catch {
      toast.error("Failed to export report");
    }
  };

  const employees = report?.employees ?? [];
  const totalCount = report?.total_count ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);
  const startIndex = (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalCount);
  const colSpan = 9;

  return (
    <div className="rounded-xl border overflow-x-auto bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, code, department..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
          <SelectTrigger className="w-[200px] h-9">
            <SelectValue placeholder="Select leave plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((p) => (
              <SelectItem key={p._id} value={p._id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExport}
            disabled={!selectedPlanId}
          >
            <Download className="size-4" /> Export
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-8" />
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              #
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Emp Code
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Employee Name
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Department
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
              Business Unit
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Opening
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Used YTD
            </TableHead>
            <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
              Total Balance
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell
                colSpan={colSpan}
                className="text-center py-12 text-sm text-muted-foreground"
              >
                Loading...
              </TableCell>
            </TableRow>
          )}
          {!isLoading && employees.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={colSpan}
                className="text-center py-12 text-sm text-muted-foreground"
              >
                No records found
              </TableCell>
            </TableRow>
          )}
          {employees.map((emp: BalanceEmployee, idx: number) => {
            const hasDetails = emp.leave_type_details && emp.leave_type_details.length > 0;
            const isExpanded = expandedRows.has(emp.employee_id);
            return (
              <>
                <TableRow
                  key={emp.employee_id}
                  className={hasDetails ? "cursor-pointer" : ""}
                  onClick={() => hasDetails && toggleRow(emp.employee_id)}
                >
                  <TableCell className="w-8 px-2">
                    {hasDetails && (
                      isExpanded
                        ? <ChevronDown className="size-4 text-muted-foreground" />
                        : <ChevronRight className="size-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {startIndex + idx}
                  </TableCell>
                  <TableCell className="text-sm text-foreground font-medium">
                    {emp.emp_code}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {emp.name}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {emp.department}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {emp.business_unit}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.opening}
                  </TableCell>
                  <TableCell className="text-sm text-foreground text-right">
                    {emp.used_ytd}
                  </TableCell>
                  <TableCell className="text-sm font-medium text-foreground text-right">
                    {emp.total_balance}
                  </TableCell>
                </TableRow>
                {isExpanded && hasDetails && (
                  <TableRow key={`${emp.employee_id}-details`}>
                    <TableCell colSpan={colSpan} className="bg-muted/20 px-8 py-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        Leave Type Breakdown
                      </p>
                      <div className="rounded-xl border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-table-header hover:bg-table-header">
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8">
                                Leave Type
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Opening
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Used YTD
                              </TableHead>
                              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-8 text-right">
                                Balance
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {emp.leave_type_details.map((d) => (
                              <TableRow key={d.leave_type_id}>
                                <TableCell className="text-sm text-foreground">
                                  {d.leave_type_name}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.opening}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.used_ytd}
                                </TableCell>
                                <TableCell className="text-sm text-foreground text-right">
                                  {d.balance}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            );
          })}
        </TableBody>
      </Table>

      {totalCount > 0 && (
        <div className="border-t">
          <TablePagination
            currentPage={page}
            totalPages={totalPages}
            startIndex={startIndex}
            endIndex={endIndex}
            total={totalCount}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function LeaveReport() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Leave Reports"
        subtitle="Reports applicable for all the Employees."
      />
      <Tabs defaultValue="year-end" className="space-y-4">
        <TabsList>
          <TabsTrigger value="year-end">Year-End Processing Reports</TabsTrigger>
          <TabsTrigger value="balance">Current Leave Balance Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="year-end">
          <YearEndTab />
        </TabsContent>
        <TabsContent value="balance">
          <CurrentBalanceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
