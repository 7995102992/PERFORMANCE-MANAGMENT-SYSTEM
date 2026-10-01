import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Megaphone,
  Paperclip,
  Search,
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
import { TablePagination } from "@/components/shared/TablePagination";
import {
  useGetMyAnnouncementsPageQuery,
  type AnnouncementScope,
} from "@/store/api/announcementsApi";

// Mirrors the BE's scope filter: `org_wide` is an announcement with NEITHER a
// business unit nor a department set, `targeted` is one with either. So the
// second option is not "my department" specifically — a business-unit-wide
// notice is targeted too.
const SCOPE_OPTIONS = [
  { label: "All Announcements", value: "all" },
  { label: "Organisation-wide", value: "org_wide" },
  { label: "Targeted to me", value: "targeted" },
] as const;

type ScopeFilter = (typeof SCOPE_OPTIONS)[number]["value"];

const formatDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

/**
 * The employee-facing announcement list — everything the dashboard card shows
 * only the top 5 of.
 *
 * Read-only by construction: no create, no row actions, no status column (the
 * feed is published-only). Targeting is resolved server-side from the caller's
 * own department, so there is deliberately no department picker here — the only
 * audience question an employee can ask is "everyone, or my department?".
 */
const MyAnnouncements = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const { data, isLoading, isError } = useGetMyAnnouncementsPageQuery({
    skip: (currentPage - 1) * pageSize,
    limit: pageSize,
    search: search || undefined,
    scope: scopeFilter === "all" ? undefined : (scopeFilter as AnnouncementScope),
  });

  const announcements = data?.items ?? [];
  const total = data?.total ?? 0;

  const selectedScopeLabel =
    SCOPE_OPTIONS.find((s) => s.value === scopeFilter)?.label ??
    "All Announcements";

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, total);

  const openDetail = (id: string) =>
    navigate({ to: "/my-announcements/$announcementId", params: { announcementId: id } });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Announcements"
        subtitle="Company announcements shared with you"
      />

      <div className="rounded-xl border overflow-hidden bg-card">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search announcements..."
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
                {selectedScopeLabel}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {SCOPE_OPTIONS.map((s) => (
                <DropdownMenuItem
                  key={s.value}
                  onClick={() => {
                    setScopeFilter(s.value);
                    setCurrentPage(1);
                  }}
                >
                  {s.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {isError && (
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load announcements"
            description="Please try again."
          />
        )}

        {!isLoading && !isError && (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Title
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Audience
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Attachments
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Posted Date
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.map((announcement) => {
                  const departmentNames = announcement.department_names ?? [];
                  const businessUnitNames =
                    announcement.business_unit_names ?? [];
                  // Organisation-wide only when BOTH lists are empty — matching
                  // the BE. A notice aimed at a business unit with no
                  // department set still reaches part of the org, so labelling
                  // it "Organisation-wide" would overstate its audience.
                  const audience =
                    departmentNames.length === 0 &&
                    businessUnitNames.length === 0
                      ? "Organisation-wide"
                      : [...businessUnitNames, ...departmentNames].join(", ");
                  const attachmentCount = announcement.attachments?.length ?? 0;
                  return (
                    <TableRow
                      key={announcement.id}
                      className="cursor-pointer"
                      onClick={() => openDetail(announcement.id)}
                    >
                      <TableCell className="text-sm text-foreground font-medium max-w-[320px] truncate">
                        {announcement.title}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[240px]">
                        <span className="block truncate">{audience}</span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {attachmentCount === 0 ? (
                          "—"
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <Paperclip className="size-3.5 shrink-0" />
                            <span className="tabular-nums">
                              {attachmentCount}
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(announcement.posted_date)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {announcements.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-0">
                      <EmptyState
                        icon={Megaphone}
                        title="No announcements found"
                        description="Announcements shared with you will show up here."
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
              onPageSizeChange={(size) => {
                setPageSize(size);
                setCurrentPage(1);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default MyAnnouncements;
