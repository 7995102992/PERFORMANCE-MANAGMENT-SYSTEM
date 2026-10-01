import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/shared/PageLoader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/shared/TablePagination";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { Pencil, Plus, Search, X } from "lucide-react";
import { DepartmentModel } from "./Model";
import type { DepartmentModelForm } from "@/modules/org-setup/types/departmentModel";
import {
  useDepartments,
  useCreateDepartment,
  useUpdateDepartment,
} from "@/hooks/queries/use-departments";
import { useBusinessUnits } from "@/hooks/queries/use-business-unit";
import { useAppSelector } from "@/store";
import type { DepartmentResponseDTO } from "@/api/org-setup/types";
import { StatusBadge } from "@/components/shared/StatusBadge";

const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

export function Departments() {
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [buFilter, setBuFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [addOpen, setAddOpen] = useState(false);
  const [editData, setEditData] = useState<{
    open: boolean;
    id: string;
    data: DepartmentModelForm;
  } | null>(null);
  const [viewData, setViewData] = useState<{
    open: boolean;
    id: string;
    data: DepartmentModelForm;
  } | null>(null);

  // Debounce search — 400ms delay, min 2 chars
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.length >= 2 ? search : "");
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setCurrentPage(1);
  }, [buFilter]);

  // API data — search + status + BU filter all server-side
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const isActiveFilter =
    statusFilter === "all" ? undefined : statusFilter === "active";
  const { data: departments = [], isLoading } = useDepartments(savedOrg?.id, {
    search: debouncedSearch,
    limit: 100,
    is_active: isActiveFilter,
    ...(buFilter ? { businessUnitIds: [buFilter] } : {}),
  });
  const { data: remoteBUs = [] } = useBusinessUnits(savedOrg?.id);
  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();

  // BU id → name lookup
  const buNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const bu of remoteBUs) map[bu.id] = bu.business_unit_name;
    return map;
  }, [remoteBUs]);

  // Handlers
  const handleSave = async (data: DepartmentModelForm) => {
    confirm({
      title: "Create Department?",
      description: "Are you sure you want to create this department?",
      confirmText: "Save",
      onConfirm: async () => {
        await createDept.mutateAsync({
          businessUnits: data.businessUnits,
          primaryBusinessUnit: data.primaryBusinessUnit || null,
          departmentName: data.departmentName,
          departmentCode: data.departmentCode || null,
          description: data.description || null,
          is_active: data.status,
        });
        setAddOpen(false);
      },
    });
  };

  const handleView = (dept: DepartmentResponseDTO) => {
    setViewData({
      open: true,
      id: dept.id,
      data: {
        businessUnits: dept.businessUnits ?? [],
        primaryBusinessUnit: dept.primaryBusinessUnit ?? "",
        departmentName: dept.departmentName,
        departmentCode: dept.departmentCode ?? "",
        description: dept.description ?? "",
        departmentHead: dept.departmentHead ?? "",
        departmentHeadName: dept.departmentHeadName ?? "",
        status: dept.is_active,
      },
    });
  };

  const handleEdit = (dept: DepartmentResponseDTO) => {
    setEditData({
      open: true,
      id: dept.id,
      data: {
        businessUnits: dept.businessUnits ?? [],
        primaryBusinessUnit: dept.primaryBusinessUnit ?? "",
        departmentName: dept.departmentName,
        departmentCode: dept.departmentCode ?? "",
        description: dept.description ?? "",
        departmentHead: dept.departmentHead ?? "",
        departmentHeadName: dept.departmentHeadName ?? "",
        status: dept.is_active,
      },
    });
  };

  const handleEditSave = async (data: DepartmentModelForm) => {
    if (!editData) return;
    confirm({
      title: "Update Department?",
      description: "Are you sure you want to update this department?",
      confirmText: "Update",
      onConfirm: async () => {
        await updateDept.mutateAsync({
          id: editData.id,
          payload: {
            businessUnits: data.businessUnits,
            primaryBusinessUnit: data.primaryBusinessUnit || null,
            departmentName: data.departmentName,
            departmentCode: data.departmentCode || null,
            description: data.description || null,
            is_active: data.status,
          },
        });
        setEditData(null);
      },
    });
  };

  const totalPages = Math.max(1, Math.ceil(departments.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = departments.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex =
    departments.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, departments.length);

  if (isLoading) return <PageLoader message="Loading departments..." />;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl">Departments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create departments and assign them to business units.
          </p>
        </div>
        <Button variant="success" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          Add Department
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
          <Input
            placeholder="Search departments..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
            }}
            className="pl-9"
          />
        </div>
        <div className="w-52">
          <SearchableSelect
            options={[
              { label: "All Business Units", value: "all" },
              ...remoteBUs.map((bu) => ({
                label: bu.business_unit_name,
                value: bu.id,
              })),
            ]}
            value={buFilter || "all"}
            onChange={(v) => {
              const s = v as string;
              setBuFilter(s === "all" ? "" : s);
              setCurrentPage(1);
            }}
            placeholder="Business Unit"
          />
        </div>
        <div className="w-40">
          <SearchableSelect
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v as string);
              setCurrentPage(1);
            }}
            placeholder="Status"
            searchable={false}
          />
        </div>
        {(search || statusFilter !== "all" || buFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
              setBuFilter("");
              setCurrentPage(1);
            }}
          >
            <X />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-[200px]">Department Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Business Units</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  Loading departments...
                </TableCell>
              </TableRow>
            ) : paginated.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  No departments found.
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((dept) => (
                <TableRow
                  key={dept.id}
                  className="cursor-pointer"
                  onClick={() => handleView(dept)}
                >
                  <TableCell className="font-medium">
                    {dept.departmentName}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {dept.departmentCode || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(dept.businessUnits ?? []).map((buId) => (
                        <Badge
                          key={buId}
                          variant="secondary"
                          className="text-xs"
                        >
                          {buNameMap[buId] ?? buId}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {dept.is_active ? (
                      <StatusBadge status="active" />
                    ) : (
                      <StatusBadge status="inactive" />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(dept);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {/* <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" onClick={() => handleDelete(dept)}>
                                                <Trash2 className="size-4" />
                                            </Button> */}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <TablePagination
        currentPage={safePage}
        totalPages={totalPages}
        startIndex={startIndex}
        endIndex={endIndex}
        total={departments.length}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setCurrentPage(1);
        }}
      />

      {/* Add Dialog */}
      <DepartmentModel
        mode="add"
        open={addOpen}
        onOpenChange={setAddOpen}
        onSave={handleSave}
      />

      {/* Edit Dialog */}
      {editData && (
        <DepartmentModel
          mode="edit"
          open={editData.open}
          onOpenChange={(open) => {
            if (!open) setEditData(null);
          }}
          onSave={handleEditSave}
          data={editData.data}
        />
      )}

      {/* View Dialog */}
      {viewData && (
        <DepartmentModel
          mode="view"
          open={viewData.open}
          onOpenChange={(open) => {
            if (!open) setViewData(null);
          }}
          data={viewData.data}
          onEdit={() => {
            const dept = departments.find((d) => d.id === viewData.id);
            setViewData(null);
            if (dept) handleEdit(dept);
          }}
        />
      )}
    </div>
  );
}
