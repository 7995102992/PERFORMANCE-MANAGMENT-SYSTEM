import { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Loader2,
  FileSpreadsheet,
  ChevronDown,
  AlertCircle,
  Search,
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
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TablePagination } from "@/components/shared/TablePagination";
import {
  useGetWorkflowsQuery,
  useDeleteWorkflowMutation,
  useGetCategoriesQuery,
  useGetRequestTypesQuery,
} from "@/store/api/srmApi";
import { WorkflowForm } from "./WorkflowForm";
import { toast } from "@/lib/toast";
import { store } from "@/store";

const STATUSES = ["Active", "Inactive", "All Status"];

export const WorkflowList = () => {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [requestTypeFilter, setRequestTypeFilter] = useState<string>("all");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Debounce the free-text filter so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Paging is entirely server-side: `page`/`page_size` MUST be sent or the API
  // falls back to its own defaults (page 1, 25 rows) and everything past row 25
  // is unreachable. `q` matches on category and ticket-type name — the two name
  // columns in this table; a workflow has no name of its own.
  const { data, isLoading, isError } = useGetWorkflowsQuery({
    q: debouncedSearch || undefined,
    status:
      statusFilter === "All Status" ? undefined : statusFilter.toLowerCase(),
    category_id: categoryFilter === "all" ? undefined : categoryFilter,
    request_type_id:
      requestTypeFilter === "all" ? undefined : requestTypeFilter,
    page: currentPage,
    page_size: pageSize,
  });

  const { data: categoriesData } = useGetCategoriesQuery({ status: "active", page_size: 200 });
  const categories = categoriesData?.items ?? [];
  const { data: requestTypesData } = useGetRequestTypesQuery(
    categoryFilter === "all"
      ? { page_size: 200 }
      : { category_id: categoryFilter, page_size: 200 },
  );
  const requestTypeRows = requestTypesData?.items ?? [];
  // Backend returns one row per (request_type, sla_rule); collapse to unique RTs.
  const requestTypes = Array.from(
    new Map(
      requestTypeRows.map((r) => [
        r.request_type_id,
        { id: r.request_type_id, name: r.request_type_name },
      ]),
    ).values(),
  );

  const workflows = data?.items ?? [];

  const [isExporting, setIsExporting] = useState(false);
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
      if (statusFilter && statusFilter !== "All Status")
        params.set("status", statusFilter.toLowerCase());
      if (categoryFilter && categoryFilter !== "all")
        params.set("category_id", categoryFilter);
      if (requestTypeFilter && requestTypeFilter !== "all")
        params.set("request_type_id", requestTypeFilter);
      // approval_level filter is client-side only — backend doesn't accept it,
      // so the xlsx will contain all rows matching the server-side filters.
      const url = `${import.meta.env.VITE_SRM_API_BASE_URL}/workflows/export${
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
      a.download = `service-ticket-workflows_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err, "Failed to export workflows");
    } finally {
      setIsExporting(false);
    }
  };

  const [deleteWorkflow, { isLoading: isDeleting }] =
    useDeleteWorkflowMutation();

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteWorkflow(deleteId).unwrap();
      toast.success("Workflow deleted");
      setDeleteId(null);
    } catch (err) {
      toast.error(err, "Failed to delete workflow");
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
        title="Assignment & Approval Workflows"
        subtitle="Manage assignment rules, approval hierarchies, and escalation configurations"
        action={
          <Button
            onClick={() => {
              setEditId(null);
              setSheetOpen(true);
            }}
          >
            <Plus />
            Create Workflow
          </Button>
        }
      />

      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar — single row */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by category or ticket type..."
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
                {statusFilter}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {STATUSES.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => {
                    setStatusFilter(s);
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
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[200px]"
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
                  setRequestTypeFilter("all");
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
                    setRequestTypeFilter("all");
                    setCurrentPage(1);
                  }}
                >
                  {cat.name}
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
                  {requestTypeFilter === "all"
                    ? "All Ticket Types"
                    : (requestTypes.find((r) => r.id === requestTypeFilter)
                        ?.name ?? "Ticket Type")}
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
                  setRequestTypeFilter("all");
                  setCurrentPage(1);
                }}
              >
                All Ticket Types
              </DropdownMenuItem>
              {requestTypes.map((rt) => (
                <DropdownMenuItem
                  key={rt.id}
                  onClick={() => {
                    setRequestTypeFilter(rt.id);
                    setCurrentPage(1);
                  }}
                >
                  {rt.name}
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
            title="Failed to load workflows"
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
                  {/* Was "Primary Assignee", rendering the workflow's frozen
                      single-user snapshot — so a category with two primaries
                      showed one name here and both on the category screen. */}
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Primaries
                  </TableHead>
                  {/* The "Approvers" column was here. It rendered
                      `approvers_summary` / `approvers_count`, both derived from
                      stored `approvers` rows — and no workflow has any now that
                      approval routes per ticket from the requester's own L1/L2
                      in IAM. It was structurally guaranteed to read "—" on every
                      row. Approval routing is explained on the workflow form
                      instead, where it can say whose hierarchy is used. */}
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Escalation
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
                {workflows.map((wf) => (
                  <TableRow
                    key={wf.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setEditId(wf.id);
                      setSheetOpen(true);
                    }}
                  >
                    {/* Any of these names can be null when the referenced record
                        was removed or the IAM lookup failed — show a dash rather
                        than leaking a raw ObjectId. */}
                    <TableCell className="text-muted-foreground">
                      {wf.category_name || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-medium">
                      {wf.request_type_name || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {wf.primary_executor_names?.length
                        ? wf.primary_executor_names.join(", ")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {/* Pre-formatted by the BE ("After N min to <name>" /
                          "Manual only") — render as-is, never parse it. */}
                      {wf.escalation_summary || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <StatusBadge
                        status={wf.status}
                        activeLabel="Active"
                        inactiveLabel="Inactive"
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => setDeleteId(wf.id)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {total === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState
                        title="No workflows found"
                        description="No workflows match your current filters."
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

      <WorkflowForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editId={editId}
      />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Workflow"
        description="Are you sure you want to delete this workflow? Active workflows linked to open tickets cannot be deleted."
        confirmLabel={isDeleting ? "Deleting..." : "Delete"}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
};
