import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/shared/PageLoader";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSuperAdminOrgs } from "@/hooks/queries/use-super-admin-orgs";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { TablePagination } from "@/components/shared/TablePagination";

const STATUS_OPTIONS = [
  { label: "All Statuses", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

export function OrgsListPage() {
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.length >= 2 ? search : "");
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const isActiveFilter =
    statusFilter === "all" ? undefined : statusFilter === "active";
  const { data: orgs = [], isLoading } = useSuperAdminOrgs({
    search: debouncedSearch || undefined,
    limit: 100,
    is_active: isActiveFilter,
  });

  const totalPages = Math.max(1, Math.ceil(orgs.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = orgs.slice((safePage - 1) * pageSize, safePage * pageSize);
  const startIndex = orgs.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, orgs.length);
  const hasFilters = search.length > 0 || statusFilter !== "all";

  function handlePageSize(val: string) {
    setPageSize(Number(val));
    setCurrentPage(1);
  }

  if (isLoading) return <PageLoader message="Loading organisations..." />;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Organisations</h1>
          <p className="text-sm text-muted-foreground">
            {orgs.length} organisation{orgs.length !== 1 ? "s" : ""} total
          </p>
        </div>
        <Button
          variant="success"
          onClick={() => navigate({ to: "/super-admin/organisations/new" })}
        >
          <Plus className="size-4" />
          Add Organisation
        </Button>
      </div>

      {/* Card: filters + table + pagination */}
      <Card className="gap-0 py-0">
        {/* Filters row */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
            <Input
              placeholder="Search organisations..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9 text-sm"
            />
          </div>
          <div className="w-40">
            <SearchableSelect
              options={STATUS_OPTIONS}
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v);
                setCurrentPage(1);
              }}
              placeholder="Status"
              searchable={false}
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
                setCurrentPage(1);
              }}
            >
              <X />
              Clear
            </Button>
          )}
        </div>

        {/* Table */}
        <CardContent className="p-4">
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30%]">Organisation</TableHead>
                  <TableHead>Modules</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Setup</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-32 text-center text-muted-foreground"
                    >
                      {hasFilters
                        ? "No organisations match your filters."
                        : "No organisations yet. Create your first one."}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((org) => (
                    <TableRow
                      key={org.id}
                      className="cursor-pointer"
                      onClick={() =>
                        navigate({
                          to: "/super-admin/organisations/edit",
                          search: { id: org.id },
                        })
                      }
                    >
                      <TableCell>
                        <span className="font-medium">{org.legal_name}</span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className="tabular-nums text-xs"
                        >
                          {org.active_modules_count}/{org.enabled_modules_count}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={org.is_active ? "active" : "inactive"}
                        />
                      </TableCell>
                      <TableCell>
                        {org.setup_status === "active" ? (
                          <StatusBadge status="active" activeLabel="Complete" />
                        ) : org.setup_status === "pending" ? (
                          <StatusBadge status="pending" />
                        ) : (
                          <StatusBadge
                            status="inactive"
                            inactiveLabel="Draft"
                          />
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {org.created_on
                          ? new Date(org.created_on).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div
                          className="flex items-center justify-end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() =>
                                  navigate({
                                    to: "/super-admin/organisations/edit",
                                    search: { id: org.id },
                                  })
                                }
                              >
                                <Pencil className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>

        <TablePagination
          currentPage={safePage}
          totalPages={totalPages}
          startIndex={startIndex}
          endIndex={endIndex}
          total={orgs.length}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setCurrentPage(1);
          }}
        />
      </Card>
    </div>
  );
}
