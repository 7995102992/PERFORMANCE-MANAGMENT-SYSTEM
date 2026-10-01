import { useState, useMemo, useEffect } from "react";
import {
  Search,
  Inbox,
  Loader2,
  ClipboardCheck,
  FileText,
  Clock,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  FileSpreadsheet,
  ChevronDown,
  CalendarDays,
  RotateCcw,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { store } from "@/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { StatusCell, PriorityCell } from "../MyRequestList";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { RequestDetail } from "../RequestDetail";
import {
  useGetPendingApprovalsQuery,
  useGetApprovalCountsQuery,
  useGetCategoriesQuery,
  useGetRequestTypesQuery,
} from "@/store/api/srmApi";

const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;

// Statuses a ticket in this queue can hold. Fixed rather than derived from the
// current page — see the note where the dropdown options are built.
const STATUS_VALUES = [
  "submitted",
  "pending_approval",
  "pending_assignment",
  "assigned",
  "in_progress",
  "resolved",
  "closed",
  "rejected",
  "withdrawn",
] as const;

function titleCaseStatus(s: string) {
  return s
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

type DateRangeId = "all" | "today" | "7d" | "30d";
const DATE_RANGE_OPTIONS: { id: DateRangeId; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

function startOfRange(id: DateRangeId): Date | null {
  if (id === "all") return null;
  const now = new Date();
  if (id === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const days = id === "7d" ? 7 : 30;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

type CardId = "all" | "awaiting" | "team" | "approved" | "escalated" | "urgent";

/**
 * Each card is a server-side query, not a client-side predicate. The endpoint
 * resolves `scope` / `my_decision` / `is_escalated` / `priority` in Mongo, so a
 * card's count and its page slice always describe the same set.
 */
type CardDef = {
  id: CardId;
  label: string;
  icon: typeof FileText;
  scope?: "awaiting_me" | "my_team";
  my_decision?: string;
  is_escalated?: boolean;
  priority?: string;
};

const CARD_DEFS: CardDef[] = [
  {
    id: "all",
    label: "All",
    icon: FileText,
  },
  {
    // Actionable now: caller is the approver at the ticket's CURRENT level and
    // hasn't decided at that level. Level-aware server-side, so an L1 approver
    // who is also the L2 approver still sees the ticket when it reaches L2.
    id: "awaiting",
    label: "Awaiting my approval",
    icon: Clock,
    scope: "awaiting_me",
  },
  // Hidden: redundant in practice. `awaiting_me` is a subset of `my_team`, so
  // for a manager the union (`all`) and `my_team` return the same rows — the
  // card always mirrored All. Kept for the day a persona exists where the two
  // diverge; the `scope=my_team` query and its count still work as-is.
  // {
  //   id: "team",
  //   label: "My team's tickets",
  //   icon: FileText,
  //   scope: "my_team",
  // },
  {
    id: "approved",
    label: "Approved",
    icon: CheckCircle2,
    my_decision: "approved",
  },
  {
    id: "escalated",
    label: "Escalated",
    icon: AlertTriangle,
    is_escalated: true,
  },
  {
    id: "urgent",
    label: "Urgent",
    icon: AlertOctagon,
    priority: "urgent",
  },
];

/**
 * The card the page opens on, and the one "Clear filters" returns to.
 *
 * "Awaiting my approval" rather than "All". `all` is a union of three unrelated
 * things — rows awaiting the caller, rows they have already decided, and
 * everything raised by anyone reporting to them (service_list.py's
 * `_approvals_universe`, whose reporting-tree clause carries no level or status
 * condition). That last clause is the problem: an L2 manager sees a ticket
 * still sitting at L1, which reads as "waiting for me" on a page that looks
 * like an approval queue. On a real org the volume is the giveaway — one VP is
 * L2 for 31 of 55 employees, so `all` was showing her two thirds of the
 * company's tickets, almost none of them hers to action.
 *
 * `awaiting_me` is resolved server-side against `current_level_index`, so it
 * lists only what the caller can actually decide right now. "All" is still one
 * click away for anyone who wants the wider view.
 *
 * Declared once because three places have to agree: the initial state, the
 * `hasActiveFilters` test, and `resetFilters`. Changing only the first would
 * light up "Clear filters" on a page nobody has touched, and reset would then
 * dump the user on a card that is no longer the default.
 */
const DEFAULT_CARD: CardId = "awaiting";

/**
 * Where the caller sits relative to this ticket's requester — L1 or L2 manager.
 *
 * This is a relationship, not an approval state: the decision lives in
 * `my_decision` and the ticket's own position in `current_level_index`, both
 * surfaced elsewhere. Level only.
 *
 * `null` means the caller isn't an approver on this ticket at all — normal for
 * reporting-tree rows, so it renders as a plain dash, not an error.
 */
function MyLevelCell({ myLevel }: { myLevel?: number | null }) {
  if (myLevel == null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  return (
    <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      L{myLevel}
    </span>
  );
}

export const ApprovalQueue = () => {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [priorityValue, setPriorityValue] = useState<string>("all");
  const [statusValue, setStatusValue] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRangeId>("all");
  const [requestTypeFilter, setRequestTypeFilter] = useState<string>("all");
  const [activeCard, setActiveCard] = useState<CardId>(DEFAULT_CARD);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Deep link from the "Review Request" button in approval-pending emails:
  // `?request=<id>` opens that ticket's detail overlay. Read once on mount, then
  // strip the param so a refresh or back doesn't reopen it.
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as Record<
    string,
    string | undefined
  >;
  useEffect(() => {
    const requestId = searchParams?.request;
    if (!requestId) return;
    setSelectedId(requestId);
    navigate({
      to: "/service-request/approval-queue/list",
      search: {},
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const activeCardDef =
    CARD_DEFS.find((c) => c.id === activeCard) ?? CARD_DEFS[0];
  const dateFloor = startOfRange(dateRange);

  // Every filter is resolved server-side now, so `total` and the page slice
  // describe the same set. This used to pull 200 rows and filter/slice
  // client-side, which meant an actionable ticket sitting past position 200 of
  // the submitted_on-ordered union was simply invisible.
  //
  // Shared with the export below so the spreadsheet always matches the screen.
  const filterParams = {
    ...(activeCardDef.scope ? { scope: activeCardDef.scope } : {}),
    ...(activeCardDef.my_decision
      ? { my_decision: activeCardDef.my_decision }
      : {}),
    ...(activeCardDef.is_escalated ? { is_escalated: true } : {}),
    ...(debouncedSearch ? { q: debouncedSearch } : {}),
    ...(categoryId !== "all" ? { category_id: categoryId } : {}),
    ...(requestTypeFilter !== "all"
      ? { request_type_id: requestTypeFilter }
      : {}),
    // The Urgent card is a priority shortcut and wins over the dropdown, the
    // same precedence the export params already used.
    ...((activeCardDef.priority ?? priorityValue) !== "all"
      ? { priority: activeCardDef.priority ?? priorityValue }
      : {}),
    ...(statusValue !== "all" ? { status: statusValue } : {}),
    ...(dateFloor ? { created_from: dateFloor.toISOString() } : {}),
  };

  const { data, isLoading } = useGetPendingApprovalsQuery({
    ...filterParams,
    page: currentPage,
    page_size: pageSize,
  });
  const items = data?.items ?? [];

  // All six totals in ONE request. Each key is asserted server-side to equal the
  // total of its equivalent list query, so a badge can't disagree with the table
  // it opens. Deliberately unfiltered — the numbers describe each queue and stay
  // put while the toolbar narrows the table.
  const { data: counts } = useGetApprovalCountsQuery();
  const cardCounts: Record<CardId, number> = {
    all: counts?.all ?? 0,
    awaiting: counts?.awaiting_me ?? 0,
    team: counts?.my_team ?? 0,
    approved: counts?.approved ?? 0,
    escalated: counts?.escalated ?? 0,
    urgent: counts?.urgent ?? 0,
  };

  // Dynamic dropdown sources.
  const { data: categoriesData } = useGetCategoriesQuery({ page_size: 200 });
  const categories = (categoriesData?.items ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const categoryMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.name);
    return m;
  }, [categories]);
  const selectedCategoryLabel =
    categoryId === "all"
      ? "All Categories"
      : (categories.find((c) => c.id === categoryId)?.name ?? "Category");

  const { data: requestTypesData } = useGetRequestTypesQuery({ page_size: 200 });
  const requestTypeRows = requestTypesData?.items ?? [];
  const requestTypes = Array.from(
    new Map(
      requestTypeRows.map((r) => [
        r.request_type_id,
        { id: r.request_type_id, name: r.request_type_name },
      ]),
    ).values(),
  );
  const selectedRequestTypeLabel =
    requestTypeFilter === "all"
      ? "All Ticket Types"
      : (requestTypes.find((r) => r.id === requestTypeFilter)?.name ??
        "Ticket Type");

  // Fixed option lists. These used to be derived from the loaded rows, which
  // worked while the whole set was in memory — now `items` is a single page, so
  // deriving would offer only the handful of values on screen and hide the rest.
  const statusValuesPresent = [...STATUS_VALUES];
  const selectedStatusLabel =
    statusValue === "all" ? "All Status" : titleCaseStatus(statusValue);

  const priorityOptions = [...PRIORITY_VALUES];
  const selectedPriorityLabel =
    priorityValue === "all"
      ? "All Priorities"
      : priorityValue.charAt(0).toUpperCase() + priorityValue.slice(1);

  const selectedDateLabel =
    DATE_RANGE_OPTIONS.find((d) => d.id === dateRange)?.label ?? "All time";

  const hasActiveFilters =
    search !== "" ||
    categoryId !== "all" ||
    requestTypeFilter !== "all" ||
    priorityValue !== "all" ||
    statusValue !== "all" ||
    dateRange !== "all" ||
    activeCard !== DEFAULT_CARD;
  const resetFilters = () => {
    setSearch("");
    setCategoryId("all");
    setRequestTypeFilter("all");
    setPriorityValue("all");
    setStatusValue("all");
    setDateRange("all");
    setActiveCard(DEFAULT_CARD);
    setCurrentPage(1);
  };

  // `total` is the full server-side count for the active card + filters, so it
  // is the only correct basis for the page count. `items` is already the slice.
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);
  const startIndex = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, total);

  const handleExport = async () => {
    if (total === 0) {
      toast.info("Nothing to export");
      return;
    }
    setIsExporting(true);
    try {
      const token = store.getState().auth.accessToken;
      // Exactly the params driving the table — the export resolves scope
      // through the same _approvals_universe() the list does, so the
      // spreadsheet matches what's on screen (including the team card, which
      // previously had no export at all). No page/page_size: exports are whole.
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filterParams)) {
        params.set(k, String(v));
      }
      const url = `${import.meta.env.VITE_SRM_API_BASE_URL}/requests/approvals-export${
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
      a.download = `approvals_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err, "Failed to export approvals");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team Tickets"
        subtitle="Tickets raised by your team, and those awaiting your approval"
      />

      {/* Stat cards — clicking acts as the primary filter. Column count tracks
          CARD_DEFS; bump it if the team card is uncommented. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {CARD_DEFS.map((card) => {
          const Icon = card.icon;
          const isActive = activeCard === card.id;
          return (
            <div
              key={card.id}
              onClick={() => {
                setActiveCard(card.id);
                setCurrentPage(1);
              }}
              className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${
                isActive
                  ? "bg-primary/5 border-primary/20"
                  : "bg-card hover:bg-muted/50"
              }`}
              role="button"
              aria-pressed={isActive}
              aria-label={`Filter to ${card.label} (${cardCounts[card.id]})`}
            >
              <div>
                <p className="text-xs text-muted-foreground font-medium">
                  {card.label}
                </p>
                <p className="text-2xl font-bold text-foreground tabular-nums">
                  {cardCounts[card.id]}
                </p>
              </div>
              <Icon className="size-8 shrink-0 text-muted-foreground" />
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card min-w-0">
        {/* Single toolbar — search + filters + export */}
        <div className="flex items-center gap-3 border-b px-4 py-3 flex-wrap">
          <div className="relative min-w-0 max-w-xs flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by ticket, title, type, or requester..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9"
            />
          </div>

          {/* Date range */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9"
              >
                <CalendarDays className="size-4" />
                {selectedDateLabel}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {DATE_RANGE_OPTIONS.map((d) => (
                <DropdownMenuItem
                  key={d.id}
                  onClick={() => {
                    setDateRange(d.id);
                    setCurrentPage(1);
                  }}
                >
                  {d.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Category — dynamic */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[200px]"
              >
                <span className="truncate">{selectedCategoryLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                onClick={() => {
                  setCategoryId("all");
                  setCurrentPage(1);
                }}
              >
                All Categories
              </DropdownMenuItem>
              {categories.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  onClick={() => {
                    setCategoryId(c.id);
                    setCurrentPage(1);
                  }}
                >
                  {c.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Priority — derived */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9"
              >
                {selectedPriorityLabel}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onClick={() => {
                  setPriorityValue("all");
                  setCurrentPage(1);
                }}
              >
                All Priorities
              </DropdownMenuItem>
              {priorityOptions.map((p) => (
                <DropdownMenuItem
                  key={p}
                  onClick={() => {
                    setPriorityValue(p);
                    setCurrentPage(1);
                  }}
                  className="capitalize"
                >
                  {p}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Status — derived */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9"
              >
                {selectedStatusLabel}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                onClick={() => {
                  setStatusValue("all");
                  setCurrentPage(1);
                }}
              >
                All Status
              </DropdownMenuItem>
              {statusValuesPresent.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => {
                    setStatusValue(s);
                    setCurrentPage(1);
                  }}
                >
                  {titleCaseStatus(s)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Ticket Type — from API */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[220px]"
              >
                <span className="truncate">{selectedRequestTypeLabel}</span>
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

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="gap-1.5 text-muted-foreground h-9"
              aria-label="Reset all filters"
              title="Reset all filters"
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          )}

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

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Ticket ID
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Title
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Ticket Type
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Requester
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Category
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Priority
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Created Date
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      My Level
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow
                      key={item.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <TableCell className="text-muted-foreground font-medium">
                        {item.ticket_no}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-medium max-w-[280px] truncate">
                        {item.title}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[200px] truncate">
                        {item.request_type_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.requester_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.category_name || categoryMap.get(item.category_id) || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <PriorityCell priority={item.priority} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(item.created_on)
                          .toLocaleDateString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            timeZone: "Asia/Kolkata",
                          })
                          .replace(/ /g, "-")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <MyLevelCell myLevel={item.my_approval_level} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* `current_level_index` = where the TICKET is, which is
                            what the status label should say. The caller's own
                            level lives in the My Level column. */}
                        <StatusCell
                          status={item.status}
                          levelIndex={item.current_level_index}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {total === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="p-0">
                        <EmptyState
                          icon={items.length === 0 ? ClipboardCheck : Inbox}
                          title={
                            items.length === 0
                              ? "No pending approvals"
                              : "No results found"
                          }
                          description={
                            items.length === 0
                              ? "There are no service tickets pending your approval."
                              : "No approval tickets match your search."
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
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

      <RequestDetail id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
};
