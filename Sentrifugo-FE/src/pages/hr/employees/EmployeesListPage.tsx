import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/StatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/shared/TablePagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, Pencil, Plus, Search, X, Filter, RefreshCw } from "lucide-react";
import { PageLoader } from "@/components/shared/PageLoader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import { useAppSelector } from "@/store";
import {
  useGetEmployeesQuery,
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useGetDesignationsQuery,
  useGetRolesQuery,
  useResendUserActivationMutation,
} from "@/store/api/iamApi";
import { useMasterOptions } from "@/hooks/use-master-options";
import { useEmployeeAccess } from "@/hooks/use-employee-access";

export function EmployeesListPage() {
  const navigate = useNavigate();
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id) ?? undefined;
  const confirm = useConfirm();
  const [resendActivation, resendState] = useResendUserActivationMutation();

  // core_hr:resource_management is levelled — viewer opens this list read-only,
  // editor unlocks the write actions. `GET /employees/resources` answers this
  // off the same session grid the routes deny off, so a hidden control is one
  // that would genuinely 403.
  const { canEdit } = useEmployeeAccess();

  function handleResend(userId: string, name: string) {
    confirm({
      title: "Resend activation email",
      description: `Resend the activation link to ${name}? The previous link stays valid until it expires.`,
      confirmText: "Resend",
      onConfirm: async () => {
        try {
          await resendActivation(userId).unwrap();
          toast.success("Activation email resent.");
        } catch (err) {
          toast.error(err);
        }
      },
    });
  }

  // Search
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Filters
  const [buFilter, setBuFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [desgFilter, setDesgFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [projectStatusFilter, setProjectStatusFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showFilters, setShowFilters] = useState(false);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.length >= 2 ? search : "");
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  // Dropdown data
  const { data: buOptions = [] } = useGetBusinessUnitsQuery({ is_active: true });
  const { data: deptOptions = [] } = useGetDepartmentsQuery(
    buFilter ? { business_unit_ids: [buFilter] } : {},
  );
  // Designations are org-level now — not scoped to the selected department.
  const { data: desgOptions = [] } = useGetDesignationsQuery({
    limit: 1000,
    is_active: true,
  });
  const { data: roleOptions = [] } = useGetRolesQuery();
  const empStatusOptions = useMasterOptions("EMPLOYMENT_STATUSES", orgId, true);
  const projectStatusOptions = useMasterOptions("PROJECT_STATUSES", orgId);

  // Employees query with all filters
  const apiParams = useMemo(
    () => ({
      skip: (currentPage - 1) * pageSize,
      limit: pageSize,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(buFilter ? { business_unit_ids: [buFilter] } : {}),
      ...(deptFilter ? { department_ids: [deptFilter] } : {}),
      ...(desgFilter ? { designation_ids: [desgFilter] } : {}),
      ...(roleFilter ? { role_ids: [roleFilter] } : {}),
      ...(statusFilter ? { employment_status: statusFilter } : {}),
      ...(projectStatusFilter ? { project_status: projectStatusFilter } : {}),
    }),
    [
      currentPage,
      pageSize,
      debouncedSearch,
      buFilter,
      deptFilter,
      desgFilter,
      roleFilter,
      statusFilter,
      projectStatusFilter,
    ],
  );

  const { data: employees = [], isFetching } = useGetEmployeesQuery(apiParams);

  // GET /employees/ returns a bare array with no `total`, so paging is inferred:
  // a full page means there is probably another one.
  const hasNextPage = employees.length === pageSize;
  const estimatedTotal = hasNextPage
    ? currentPage * pageSize + 1
    : (currentPage - 1) * pageSize + employees.length;
  const startIndex =
    employees.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endIndex = (currentPage - 1) * pageSize + employees.length;
  const totalPages = hasNextPage ? currentPage + 1 : currentPage;

  const hasActiveFilters =
    buFilter ||
    deptFilter ||
    desgFilter ||
    roleFilter ||
    statusFilter ||
    projectStatusFilter;

  function clearFilters() {
    setBuFilter("");
    setDeptFilter("");
    setDesgFilter("");
    setRoleFilter("");
    setProjectStatusFilter("");
    setStatusFilter("");
    setCurrentPage(1);
  }

  if (isFetching && currentPage === 1 && !debouncedSearch && !hasActiveFilters) {
    return <PageLoader message="Loading employees..." />;
  }

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl">Employees</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your organisation's employees
          </p>
        </div>
        {canEdit && (
          <Button
            variant="success"
            onClick={() =>
              navigate({
                to: "/hr/employees/create",
                search: { id: undefined, view: undefined },
              })
            }
          >
            <Plus className="size-4" />
            Add Employee
          </Button>
        )}
      </div>

      {/* Search + Filter toggle */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
          <Input
            placeholder="Search by name, email, emp code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          variant={showFilters ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter />
          Filters
          {hasActiveFilters && (
            <Badge
              variant="secondary"
              className="ml-1.5 size-5 p-0 justify-center text-[10px]"
            >
              {
                [
                  buFilter,
                  deptFilter,
                  desgFilter,
                  roleFilter,
                  statusFilter,
                  projectStatusFilter,
                ].filter(Boolean).length
              }
            </Badge>
          )}
        </Button>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X />
            Clear
          </Button>
        )}
      </div>

      {/* Filter row */}
      {showFilters && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Business Unit */}
          <Select
            value={buFilter || "all"}
            onValueChange={(v) => {
              setBuFilter(v === "all" ? "" : v);
              setDeptFilter("");
              setDesgFilter("");
              setCurrentPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="All Business Units" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Business Units</SelectItem>
              {buOptions.map((bu) => (
                <SelectItem key={bu.id} value={bu.id}>
                  {bu.business_unit_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Department */}
          <Select
            value={deptFilter || "all"}
            onValueChange={(v) => {
              setDeptFilter(v === "all" ? "" : v);
              setDesgFilter("");
              setCurrentPage(1);
            }}
            disabled={!buFilter}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={buFilter ? "All Departments" : "Select BU first"}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Departments</SelectItem>
              {deptOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.departmentName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Designation */}
          <Select
            value={desgFilter || "all"}
            onValueChange={(v) => {
              setDesgFilter(v === "all" ? "" : v);
              setCurrentPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="All Designations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Designations</SelectItem>
              {desgOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.designationName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Role */}
          <Select
            value={roleFilter || "all"}
            onValueChange={(v) => {
              setRoleFilter(v === "all" ? "" : v);
              setCurrentPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="All Roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Roles</SelectItem>
              {roleOptions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Employment Status */}
          <Select
            value={statusFilter || "all"}
            onValueChange={(v) => {
              setStatusFilter(v === "all" ? "" : v);
              setCurrentPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              {empStatusOptions.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Project Status */}
          <Select
            value={projectStatusFilter || "all"}
            onValueChange={(v) => {
              setProjectStatusFilter(v === "all" ? "" : v);
              setCurrentPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="All Project Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Project Statuses</SelectItem>
              {projectStatusOptions.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border overflow-hidden max-w-[79vw]">
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Emp Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Work Email</TableHead>
              <TableHead>Business Unit</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Project Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isFetching ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="h-24 text-center text-muted-foreground"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : employees.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="h-24 text-center text-muted-foreground"
                >
                  {debouncedSearch || hasActiveFilters
                    ? "No employees match your filters."
                    : "No employees found."}
                </TableCell>
              </TableRow>
            ) : (
              employees.map((emp) => (
                <TableRow
                  key={emp.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/hr/employees/create",
                      search: { id: emp.userId ?? undefined, view: true },
                    })
                  }
                >
                  <TableCell className="font-mono text-xs">
                    {emp.empCode || "—"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {emp.firstName} {emp.middleName ?? ""} {emp.lastName}
                  </TableCell>
                  <TableCell>{emp.workEmail}</TableCell>
                  <TableCell>{emp.businessUnitName ?? "—"}</TableCell>
                  <TableCell>{emp.departmentName ?? "—"}</TableCell>
                  <TableCell>{emp.designationName ?? "—"}</TableCell>
                  <TableCell>
                    <EmploymentStatusBadge status={emp.employmentStatus} />
                  </TableCell>
                  <TableCell>
                    {emp.projectStatus?.value ? (
                      <Badge variant="outline">{emp.projectStatus.value}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canEdit && emp.activationPending && emp.userId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-primary hover:text-primary"
                          title="Resend activation email"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleResend(
                              emp.userId!,
                              `${emp.firstName} ${emp.lastName}`,
                            );
                          }}
                          disabled={resendState.isLoading}
                        >
                          <RefreshCw />
                          Resend
                        </Button>
                      )}
                      {/* Viewers get the same affordance pointing at the
                          read-only form, so the Actions column never renders
                          empty and the row's intent stays discoverable. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        title={canEdit ? "Edit employee" : "View employee"}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate({
                            to: "/hr/employees/create",
                            search: {
                              id: emp.userId ?? undefined,
                              view: canEdit ? undefined : true,
                            },
                          });
                        }}
                      >
                        {canEdit ? (
                          <Pencil className="size-4" />
                        ) : (
                          <Eye className="size-4" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        </div>
      </div>

      <TablePagination
        currentPage={currentPage}
        totalPages={totalPages}
        startIndex={startIndex}
        endIndex={endIndex}
        total={estimatedTotal}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setCurrentPage(1);
        }}
      />
    </div>
  );
}

function EmploymentStatusBadge({ status }: { status: unknown }) {
  if (!status || typeof status !== "object")
    return <span className="text-xs text-muted-foreground">—</span>;
  const statusObj = status as {
    key?: string;
    value?: string;
    isActive?: boolean;
  };
  const label = statusObj.value || statusObj.key || "—";
  const isActive = statusObj.isActive ?? true;
  return (
    <StatusBadge
      status={isActive ? "active" : "inactive"}
      activeLabel={label}
      inactiveLabel={label}
    />
  );
}
