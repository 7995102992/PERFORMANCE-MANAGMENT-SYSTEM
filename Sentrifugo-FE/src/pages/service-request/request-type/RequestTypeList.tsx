import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  Trash2,
  Loader2,
  FileSpreadsheet,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { PriorityCell } from "@/pages/service-request/MyRequestList";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TablePagination } from "@/components/shared/TablePagination";
import {
  useGetRequestTypesQuery,
  useDeleteRequestTypeMutation,
  useGetCategoriesQuery,
} from "@/store/api/srmApi";
import { RequestTypeForm } from "./RequestTypeForm";
import { toast } from "@/lib/toast";
import { store } from "@/store";

const formatMinutes = (mins: number) => {
  if (mins >= 1440) return `${mins / 1440} day(s)`;
  if (mins >= 60) return `${mins / 60} hour(s)`;
  return `${mins} min`;
};

export const RequestTypeList = () => {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "active",
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [isExporting, setIsExporting] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce the free-text filter so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const handleExport = async () => {
    // Guard on the filtered total, not the current page.
    if ((data?.total ?? 0) === 0) {
      toast.info("Nothing to export");
      return;
    }
    setIsExporting(true);
    try {
      const token = store.getState().auth.accessToken;
      // Export covers every matching row — applied filters, no page/page_size.
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (categoryFilter && categoryFilter !== "all")
        params.set("category_id", categoryFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const url = `${import.meta.env.VITE_SRM_API_BASE_URL}/request-types/export${
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
      a.download = `service-ticket-types_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err, "Failed to export ticket types");
    } finally {
      setIsExporting(false);
    }
  };

  // Paging is entirely server-side: `page`/`page_size` MUST be sent or the API
  // falls back to its own defaults (page 1, 25 rows) and everything past row 25
  // is unreachable. `status` is filtered server-side too — the list defaults to
  // `active`, and only "All Status" omits it to return both, ordered
  // active-first then newest-first.
  const { data, isLoading, isError } = useGetRequestTypesQuery({
    q: debouncedSearch || undefined,
    category_id: categoryFilter === "all" ? undefined : categoryFilter,
    status: statusFilter === "all" ? undefined : statusFilter,
    page: currentPage,
    page_size: pageSize,
  });

  const { data: categoriesData } = useGetCategoriesQuery({ status: "active", page_size: 200 });

  const requestTypes = data?.items ?? [];
  const categories = categoriesData?.items ?? [];

  const [deleteRequestType, { isLoading: isDeleting }] =
    useDeleteRequestTypeMutation();

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteRequestType(deleteId).unwrap();
      toast.success("Ticket type deleted");
      setDeleteId(null);
    } catch (err) {
      toast.error(err, "Failed to delete ticket type");
    }
  };

  // `total` counts every row matching the filters, not the rows on this page —
  // the only correct basis for the page count. The API returns neither
  // total_pages nor has_next.
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // A page past the end returns [] with the real total, so clamp back into
  // range rather than treating it as "no results".
  const safePage = Math.min(currentPage, totalPages);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);
  // `items` is already the requested slice, ordered active-first then
  // newest-first by the server. Never re-slice or re-sort it here.
  const startIndex = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, total);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ticket Types & SLA"
        subtitle="Manage ticket types and their SLA configurations"
        action={
          <Button
            onClick={() => {
              setEditId(null);
              setSheetOpen(true);
            }}
          >
            <Plus />
            Create Ticket Type
          </Button>
        }
      />

      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar — single row */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by ticket type name..."
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
                className="gap-2 text-muted-foreground font-normal h-9"
              >
                <span className="truncate">
                  {statusFilter === "all"
                    ? "All Status"
                    : statusFilter === "active"
                      ? "Active"
                      : "Inactive"}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {(["active", "inactive", "all"] as const).map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => {
                    setStatusFilter(s);
                    setCurrentPage(1);
                  }}
                >
                  {s === "all"
                    ? "All Status"
                    : s === "active"
                      ? "Active"
                      : "Inactive"}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[220px]"
              >
                <span className="truncate">
                  {categoryFilter === "all"
                    ? "All Categories"
                    : (categories.find((c) => c.id === categoryFilter)?.name ??
                      "Category")}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                onClick={() => {
                  setCategoryFilter("all");
                  setCurrentPage(1);
                }}
              >
                All Categories
              </DropdownMenuItem>
              {categories.map((cat) => (
                <DropdownMenuItem
                  key={cat.id}
                  onClick={() => {
                    setCategoryFilter(cat.id);
                    setCurrentPage(1);
                  }}
                >
                  {cat.name}
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
            title="Failed to load ticket types"
            description="Please try again."
          />
        )}

        {!isLoading && !isError && (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Category
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Ticket Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                  <TableHead className="text-right text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requestTypes.map((rt) => (
                  <TableRow
                    key={rt.request_type_id}
                    className="cursor-pointer"
                    onClick={() => {
                      setEditId(rt.request_type_id);
                      setSheetOpen(true);
                    }}
                  >
                    <TableCell className="text-muted-foreground">
                      {rt.category_name ?? rt.category_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-medium">
                      {rt.request_type_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <StatusBadge
                        status={rt.status === "active" ? "active" : "inactive"}
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => setDeleteId(rt.request_type_id)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {total === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-0">
                      <EmptyState
                        title="No ticket types found"
                        description="No ticket types match your current filters."
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

      <RequestTypeForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editId={editId}
      />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Ticket Type"
        description="Are you sure you want to delete this ticket type and its SLA configuration?"
        confirmLabel={isDeleting ? "Deleting..." : "Delete"}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
};
