import { useMemo, useState, useEffect } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  getFilteredRowModel,
} from "@tanstack/react-table";
import { Search, Plus, Tag } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useGetLeaveTypesQuery } from "@/store/api/lmsApi";
import type { LeaveTypeResponse } from "@/types/leave";
import { LeaveTypeForm } from "./LeaveTypeForm";
import { PageLoader } from "@/components/shared/PageLoader";
import { useAppSelector, useAppDispatch } from "@/store";
import { setBreadcrumbDetail } from "@/store/slices/uiSlice";

const columnHelper = createColumnHelper<LeaveTypeResponse>();

type View = "list" | "create" | "edit" | "view";

export default function LeaveType() {
  const orgId = useAppSelector((s) => s.auth.user?.organisation_id ?? "");
  const dispatch = useAppDispatch();
  const { data: leaveTypes, isLoading } = useGetLeaveTypesQuery(orgId, { skip: !orgId });
  const [view, setView] = useState<View>("list");
  const [selectedItem, setSelectedItem] = useState<LeaveTypeResponse | null>(null);
  const breadcrumbDetail = useAppSelector((s) => s.ui.breadcrumbDetail);

  // Rendered in the order the API returns it — display order is owned by the
  // backend (leave type `rank`), so the client never re-sorts.
  const data = useMemo(() => (Array.isArray(leaveTypes) ? leaveTypes : []), [leaveTypes]);

  // The Topbar breadcrumb link clears the detail without a route change — return to list
  useEffect(() => {
    if (breadcrumbDetail === null && view !== "list") {
      setSelectedItem(null);
      setView("list");
    }
  }, [breadcrumbDetail, view]);

  useEffect(() => {
    if (window.location.search.includes("action=add")) {
      dispatch(setBreadcrumbDetail("New Leave Type")); setView("create");
      window.history.replaceState({}, "", "/leave-configuration/leave-type");
    }
  }, []);

  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "system" | "custom">("all");

  const filteredData = useMemo(() => {
    if (typeFilter === "system") return data.filter(t => !t.is_custom);
    if (typeFilter === "custom") return data.filter(t => t.is_custom);
    return data;
  }, [data, typeFilter]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: "Leave Type",
        cell: (info) => <span className="font-medium text-muted-foreground">{info.getValue()}</span>,
      }),
      columnHelper.accessor("code", {
        header: "Code",
        cell: (info) => (
          <Badge className="bg-muted text-muted-foreground font-mono text-xs">
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor("is_custom", {
        header: "Type",
        cell: (info) => {
          return (
          !info.getValue()
            ? <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-semibold border border-primary/20">System</span>
            : <span className="px-2 py-0.5 rounded-full bg-success/15 text-success text-xs font-semibold border border-success/30">Custom</span>
        )},
      }),
      columnHelper.accessor("color", {
        header: "Color",
        cell: (info) => (
          <div
            className="size-5 rounded"
            style={{ backgroundColor: info.getValue() ?? "#ccc" }}
          />
        ),
      }),
      columnHelper.accessor("unit", {
        header: "Unit",
        cell: (info) => (
          <span className="text-muted-foreground text-sm">
            {info.getValue() === "DAYS" ? "Days" : info.getValue() === "HOURS" ? "Hours" : info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor("description", {
        header: "Description",
        cell: (info) => {
          const val = info.getValue();
          return (
            <span className="text-sm text-muted-foreground">
              {val ? (val.length > 40 ? val.slice(0, 40) + "…" : val) : "—"}
            </span>
          );
        },
      }),
    ],
    []
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const backToList = () => { dispatch(setBreadcrumbDetail(null)); setSelectedItem(null); setView("list"); };

  if (view === "create") {
    return <LeaveTypeForm onCancel={backToList} onSuccess={backToList} />;
  }

  if (view === "edit") {
    return (
      <LeaveTypeForm
        initialData={selectedItem}
        detailsReadOnly={selectedItem ? !selectedItem.is_custom : false}
        onCancel={backToList}
        onSuccess={backToList}
      />
    );
  }

  if (view === "view") {
    return (
      <LeaveTypeForm
        initialData={selectedItem}
        readOnly
        onCancel={backToList}
        onSuccess={backToList}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave Types"
        subtitle="Manage and organize your company's leave categories, codes, and unit configurations."
        action={<Button variant="default" onClick={() => { setSelectedItem(null); dispatch(setBreadcrumbDetail("New Leave Type")); setView("create"); }}><Plus className="size-4 mr-1.5" /> Add Leave Type</Button>}
      />

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-0 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search leave types..."
            className="pl-9"
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
          />
        </div>
        <div className="flex items-center rounded-lg border border-border p-0.5 gap-0.5">
          {(["all", "system", "custom"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                typeFilter === f
                  ? "bg-[var(--btn-soft)] text-[var(--btn-soft-fg)] shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {f === "all" ? `All (${data.length})` : f === "system" ? `System (${data.filter(t => !t.is_custom).length})` : `Custom (${data.filter(t => t.is_custom).length})`}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <PageLoader message="Loading leave types…" />
      ) : data.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No leave types configured"
          description="Add a leave type to get started."
          action={<Button variant="default" size="sm" onClick={() => { dispatch(setBreadcrumbDetail("New Leave Type")); setView("create"); }}><Plus className="size-4 mr-1.5" /> Add Leave Type</Button>}
        />
      ) : (
        <div className="rounded-xl border overflow-hidden bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} className="bg-table-header hover:bg-table-header border-b border-table-border">
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} className="text-foreground h-10">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => {
                      setSelectedItem(row.original);
                      dispatch(setBreadcrumbDetail(row.original.name));
                      setView("edit");
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="text-muted-foreground">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

    </div>
  );
}
