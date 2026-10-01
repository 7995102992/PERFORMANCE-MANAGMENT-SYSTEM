import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  Trash2,
  FolderOpen,
  Loader2,
  FileSpreadsheet,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TablePagination } from "@/components/shared/TablePagination";
import {
  useGetCategoriesQuery,
  useDeleteCategoryMutation,
  useGetDepartmentsQuery,
} from "@/store/api/srmApi";
import type { Department } from "@/types/service-request";
import { CategoryForm } from "./CategoryForm";
import { toast } from "@/lib/toast";
import { store } from "@/store";

const STATUSES = ["Active", "Inactive", "All Status"];

// Departments a category is staffed by, tolerating a document written before
// the list existed — the API still emits the deprecated scalar for those.
const categoryDepartments = (c: {
  department_names?: string[] | null;
  department_name?: string | null;
}): string[] =>
  c.department_names?.length
    ? c.department_names
    : c.department_name
      ? [c.department_name]
      : [];

export const CategoryList = () => {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce the free-text filter so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Paging is entirely server-side: the response carries only the rows for the
  // requested page, so `page`/`page_size` MUST be sent or the API falls back to
  // its own defaults (page 1, 25 rows) and everything past row 25 is unreachable.
  const { data, isLoading, isError } = useGetCategoriesQuery({
    q: debouncedSearch || undefined,
    // Defaults to `active` so the manage screen opens on the live categories;
    // pick "All Status" to bring the deactivated ones back into view.
    status: statusFilter,
    department_id: departmentFilter === "all" ? undefined : departmentFilter,
    page: currentPage,
    page_size: pageSize,
  });

  const { data: departments } = useGetDepartmentsQuery({});
  const departmentList: Department[] = Array.isArray(departments)
    ? (departments as Department[])
    : [];
  const departmentLabel = (d: Department) =>
    (d as { departmentName?: string; name?: string }).departmentName ??
    (d as { name?: string }).name ??
    "—";
  const selectedDepartmentLabel =
    departmentFilter === "all"
      ? "All Departments"
      : departmentLabel(
          departmentList.find((d) => d.id === departmentFilter) ??
            ({} as Department),
        );

  const categories = data?.items ?? [];
  const [deleteCategory, { isLoading: isDeleting }] =
    useDeleteCategoryMutation();

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteCategory(deleteId).unwrap();
      toast.success("Category deleted");
      setDeleteId(null);
    } catch (err) {
      toast.error(err, "Failed to delete category");
    }
  };

  const openCreate = () => {
    setEditId(null);
    setSheetOpen(true);
  };

  const openEdit = (id: string) => {
    setEditId(id);
    setSheetOpen(true);
  };

  const [isExporting, setIsExporting] = useState(false);
  const handleExport = async () => {
    // Guard on the filtered total, not the current page — page 2 of 2 could be
    // empty mid-clamp while there are still rows to export.
    if ((data?.total ?? 0) === 0) {
      toast.info("Nothing to export");
      return;
    }
    setIsExporting(true);
    try {
      const token = store.getState().auth.accessToken;
      // Export covers every matching row, so it takes the applied filters and
      // deliberately no page/page_size.
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (statusFilter && statusFilter !== "all")
        params.set("status", statusFilter);
      if (departmentFilter && departmentFilter !== "all")
        params.set("department_id", departmentFilter);
      const url = `${import.meta.env.VITE_SRM_API_BASE_URL}/categories/export${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = `service-ticket-categories_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err, "Failed to export categories");
    } finally {
      setIsExporting(false);
    }
  };

  // `total` counts every row matching the filters, not the rows on this page —
  // it's the only correct basis for the page count. The API returns neither
  // total_pages nor has_next.
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // A page past the end is not an error: it comes back empty with the real
  // total, so clamp back into range instead of showing "no results".
  const safePage = Math.min(currentPage, totalPages);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);
  // `items` is already the requested slice, ordered active-first then newest-first
  // by the server. Never re-slice or re-sort it here — that would only reorder
  // the current page and break the global ordering.
  const startIndex = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, total);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service Ticket Categories"
        subtitle="Manage service ticket categories and their department assignments"
        action={
          <Button onClick={openCreate}>
            <Plus />
            Create Category
          </Button>
        }
      />

      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by name or description..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 capitalize"
              >
                {statusFilter === "all" ? "All Status" : statusFilter}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {STATUSES.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => {
                    setStatusFilter(
                      s === "All Status" ? "all" : s.toLowerCase(),
                    );
                    setCurrentPage(1);
                  }}
                >
                  {s}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[220px] truncate"
              >
                <span className="truncate">{selectedDepartmentLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                onClick={() => {
                  setDepartmentFilter("all");
                  setCurrentPage(1);
                }}
              >
                All Departments
              </DropdownMenuItem>
              {departmentList.map((d) => (
                <DropdownMenuItem
                  key={d.id}
                  onClick={() => {
                    setDepartmentFilter(d.id);
                    setCurrentPage(1);
                  }}
                >
                  {departmentLabel(d)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="ml-auto">
            <Button
              variant="outline"
              className="gap-2"
              onClick={handleExport}
              disabled={isLoading || isExporting}
            >
              {isExporting ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <FileSpreadsheet className="size-4 text-muted-foreground" />
              )}
              Export Data
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {isError && (
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load categories"
            description="Please try again."
          />
        )}

        {!isLoading && !isError && (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Name
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Description
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Departments
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Executors
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Created
                  </TableHead>
                  <TableHead className="text-right text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <TableRow
                    key={category.id}
                    className="cursor-pointer"
                    onClick={() => openEdit(category.id)}
                  >
                    <TableCell className="text-muted-foreground font-medium">
                      <div className="flex items-center gap-2">
                        <span>{category.name}</span>
                        {category.restricted_visibility && (
                          <span className="rounded-pill bg-warning/10 text-warning px-2 py-0.5 text-[10px] font-medium">
                            Restricted
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[200px] truncate">
                      {category.description}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {/* A category can span departments, so only the first is
                          spelled out — joining them all grows this cell without
                          bound and pushes the whole table into horizontal
                          scroll. The rest are a count; every name is on the
                          title attribute for hover. */}
                      <div className="flex max-w-[200px] flex-col">
                        <span
                          className="truncate"
                          title={categoryDepartments(category).join(", ")}
                        >
                          {categoryDepartments(category)[0] ?? "—"}
                          {categoryDepartments(category).length > 1 && (
                            <span className="ml-1 text-xs text-muted-foreground/70">
                              +{categoryDepartments(category).length - 1}
                            </span>
                          )}
                        </span>
                        {category.business_unit_name && (
                          <span className="truncate text-xs text-muted-foreground/70">
                            {category.business_unit_name}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {category.executors?.length ? (
                        <span className="text-xs tabular-nums">
                          {
                            category.executors.filter(
                              (e) => e.role === "primary",
                            ).length
                          }{" "}
                          primary ·{" "}
                          {
                            category.executors.filter(
                              (e) => e.role === "secondary",
                            ).length
                          }{" "}
                          secondary
                        </span>
                      ) : (
                        // No roster — the department head and the whole
                        // department still handle this category.
                        <span className="text-xs text-muted-foreground/70">
                          Department default
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <StatusBadge
                        status={
                          category.status === "active" ? "active" : "inactive"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(category.created_on)
                        .toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          timeZone: "Asia/Kolkata",
                        })
                        .replace(/ /g, "-")}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => setDeleteId(category.id)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {categories.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="p-0">
                      <EmptyState
                        icon={FolderOpen}
                        title="No categories found"
                        description="Get started by creating your first service ticket category."
                        action={
                          <Button onClick={openCreate}>
                            <Plus />
                            Create Category
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <TablePagination
              currentPage={safePage}
              totalPages={totalPages}
              startIndex={startIndex}
              endIndex={endIndex}
              total={total}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={(s) => {
                setPageSize(s);
                setCurrentPage(1);
              }}
            />
          </>
        )}
      </div>

      <CategoryForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editId={editId}
      />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Category"
        description="Are you sure you want to delete this category? This action cannot be undone. Categories with associated ticket types cannot be deleted."
        confirmLabel={isDeleting ? "Deleting..." : "Delete"}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
};
