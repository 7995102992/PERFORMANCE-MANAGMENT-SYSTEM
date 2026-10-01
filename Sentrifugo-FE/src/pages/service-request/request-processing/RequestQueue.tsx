import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { RequestDetail } from "../RequestDetail";
import {
  Search,
  Inbox,
  FileText,
  Clock,
  AlertTriangle,
  CircleCheck,
  FileSpreadsheet,
  Loader2,
  CalendarDays,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TablePagination } from "@/components/shared/TablePagination";
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
import { Button } from "@/components/ui/button";
import { StatusCell, PriorityCell } from "../MyRequestList";
import { useAppSelector } from "@/store";
import { useGetRequestsQuery } from "@/store/api/srmApi";

const PRIORITIES = ["All Priorities", "Urgent", "High", "Medium", "Low"];
const STATUSES = [
  "All Status",
  "Assigned",
  "In Progress",
  "Resolved",
  "Closed",
];

type CardId = "all" | "active" | "escalated" | "resolved";

const formatDate = (s?: string | null) =>
  s
    ? new Date(s)
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        })
        .replace(/ /g, "-")
    : "—";

export const RequestQueue = () => {
  const currentUserId = useAppSelector((s) => s.auth.user?.id ?? "");
  const isSuperAdmin = useAppSelector(
    (s) => s.auth.user?.is_super_admin ?? false,
  );
  // Read off the store rather than store.getState() — this page already takes
  // its session through the hook, and the export needs the bearer token to hit
  // /requests/department-export outside RTK Query (it returns a blob, not JSON).
  const accessToken = useAppSelector((s) => s.auth.accessToken);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("All Priorities");
  const [categoryFilter, setCategoryFilter] = useState("All Category");
  const [activeCard, setActiveCard] = useState<CardId>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [isExporting, setIsExporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep link from assignment / escalation / SLA-breach emails: `?request=<id>`
  // opens that ticket's detail overlay. A single request has no route of its
  // own, so the mail links here and names the id. Read once on mount, then
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
    navigate({ to: "/service-request/queue/list", search: {}, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real backend call — "tickets where the logged-in user is the executor".
  // Super admins see everything when no executor filter is sent (handled by
  // _scoped_filter on the backend); regular users pass their own id.
  const { data, isLoading, isError } = useGetRequestsQuery(
    {
      executor_user_id: isSuperAdmin ? undefined : currentUserId,
      page_size: 200,
    },
    { skip: !currentUserId },
  );
  // `auth.user` is not persisted (only the tokens are), so on a hard refresh or
  // a deep link `currentUserId` is "" for the first render and BOTH queries are
  // skipped. RTK Query then reports isLoading === false, which without this
  // would fall through to "No Tickets Assigned" — telling an executor they have
  // nothing before /me has even resolved. Now that this page is a sidebar
  // destination rather than a dashboard link, that flash is on the main path.
  const awaitingSession = !currentUserId;
  // The open pool: unassigned tickets the caller could pick up.
  //
  // Roster-scoped, despite the parameter name. `for_my_department` resolves
  // server-side through `_roster_visible_category_ids`, which returns the
  // categories the caller is named on as primary or secondary — wherever those
  // categories live, since a roster can draw from several departments and a
  // rostered executor may sit outside all of them. Categories with no roster
  // still fall back to the caller's department, which is the only place
  // "department" still enters into it.
  //
  // So this is NOT "anyone in the department can pick these up" any more. The
  // parameter kept its name for API compatibility; the meaning moved.
  //
  // Super admins see these through the primary query already.
  const { data: openDeptData } = useGetRequestsQuery(
    {
      for_my_department: true,
      status: "pending_assignment",
      page_size: 200,
    },
    { skip: !currentUserId || isSuperAdmin },
  );
  // Merge + dedupe by id. A pool ticket the caller is somehow already the
  // executor of would otherwise appear twice.
  const queueItems = useMemo(() => {
    const merged = [...(data?.items ?? []), ...(openDeptData?.items ?? [])];
    const seen = new Set<string>();
    return merged.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }, [data, openDeptData]);

  // Tickets the caller escalated away. Neither query above can reach these:
  // escalating reassigns `executor_user_id` to the target, so the ticket leaves
  // the escalator's queue the instant they hand it off — which is why the
  // Escalated card read 0 for the person who actually escalated. The backend
  // parks the old owner in `previous_executor_user_id`, and nothing else in the
  // app reads it.
  const { data: escalatedAwayData } = useGetRequestsQuery(
    {
      previous_executor_user_id: currentUserId,
      page_size: 200,
    },
    { skip: !currentUserId || isSuperAdmin },
  );

  const escalatedAway = useMemo(() => {
    const inQueue = new Set(queueItems.map((i) => i.id));
    return (escalatedAwayData?.items ?? []).filter(
      (i) =>
        // Already on screen — the caller escalated it and it came back to them.
        !inQueue.has(i.id) &&
        // A later reassign clears `is_escalated` but leaves
        // `previous_executor_user_id` set, so the query alone also returns
        // tickets whose escalation is over.
        i.is_escalated &&
        i.escalation_phase !== "approval",
    );
  }, [escalatedAwayData, queueItems]);

  // Escalations involving the caller, in both directions: escalated TO them
  // (still in their queue) and escalated BY them (gone from it). Kept apart
  // from `queueItems` on purpose — the other three cards count what the caller
  // holds, and a ticket they handed off is not that.
  const escalatedItems = useMemo(
    () => [
      ...queueItems.filter(
        (i) => i.is_escalated && i.escalation_phase !== "approval",
      ),
      ...escalatedAway,
    ],
    [queueItems, escalatedAway],
  );

  // Build "All Category" + every unique category we have rows for. Saves
  // hardcoding a dept list — what you see is what you can filter by.
  const CATEGORIES = [
    "All Category",
    ...Array.from(
      new Set(
        queueItems.map((i) => i.category_name).filter((n): n is string => !!n),
      ),
    ).sort(),
  ];

  const CARD_DEFS: Array<{
    id: CardId;
    label: string;
    icon: typeof FileText;
    cls: string;
    match: (
      status: string,
      isEscalated: boolean,
      escalationPhase?: string | null,
    ) => boolean;
  }> = [
    {
      id: "all",
      label: "Total Assigned",
      icon: FileText,
      cls: "text-muted-foreground",
      match: () => true,
    },
    {
      id: "active",
      label: "In Progress",
      icon: Clock,
      cls: "text-badge-inprogress-text",
      match: (s) => s === "in_progress" || s === "assigned",
    },
    {
      // Counted off `escalatedItems`, not `queueItems` — see `cardCounts`.
      //
      // Approval-phase escalations are excluded. `is_escalated` is set by both
      // kinds of handoff, but the approval one swaps the override approver and
      // leaves `executor_user_id` alone, so it stayed on the original
      // executor's card for a handoff that never involved them.
      id: "escalated",
      label: "Escalated",
      icon: AlertTriangle,
      cls: "text-destructive",
      match: (_s, esc, phase) => esc && phase !== "approval",
    },
    {
      id: "resolved",
      label: "Resolved",
      icon: CircleCheck,
      cls: "text-success",
      match: (s) => s === "resolved" || s === "closed",
    },
  ];

  // Each card counts the rows it is actually about. Escalated is the one that
  // reaches outside the queue, because half of what it describes has left it.
  const sourceFor = (id: CardId) =>
    id === "escalated" ? escalatedItems : queueItems;

  const cardCounts: Record<CardId, number> = CARD_DEFS.reduce(
    (acc, c) => {
      acc[c.id] = sourceFor(c.id).filter((i) =>
        c.match(
          (i.status ?? "").toLowerCase(),
          !!i.is_escalated,
          i.escalation_phase,
        ),
      ).length;
      return acc;
    },
    {} as Record<CardId, number>,
  );
  const activeCardDef =
    CARD_DEFS.find((c) => c.id === activeCard) ?? CARD_DEFS[0];

  const filtered = sourceFor(activeCard).filter((item) => {
    const matchesSearch =
      (item.ticket_no ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (item.request_type_name ?? "")
        .toLowerCase()
        .includes(search.toLowerCase()) ||
      (item.requester_name ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus =
      statusFilter === "all" ||
      (item.status ?? "").toLowerCase() ===
        statusFilter.toLowerCase().replace(/ /g, "_");
    const matchesPriority =
      priorityFilter === "All Priorities" ||
      (item.priority ?? "").toLowerCase() === priorityFilter.toLowerCase();
    const matchesCategory =
      categoryFilter === "All Category" ||
      (item.category_name ?? "") === categoryFilter;
    const matchesCard = activeCardDef.match(
      (item.status ?? "").toLowerCase(),
      !!item.is_escalated,
      item.escalation_phase,
    );
    return (
      matchesSearch &&
      matchesStatus &&
      matchesPriority &&
      matchesCategory &&
      matchesCard
    );
  });

  // Default order: newest submission first, terminal tickets at the bottom.
  // `created_on` on a list row IS the submitted-on timestamp — the backend maps
  // `"created_on": i.submitted_on` in service_list.py — which is why the column
  // header reads "Submitted". Priority now only breaks ties between two tickets
  // submitted at the same instant; it no longer floats urgent work to the top.
  const PRIORITY_RANK: Record<string, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const isTerminal = (s?: string) => {
    const v = (s ?? "").toLowerCase();
    return (
      v.includes("resolv") ||
      v.includes("closed") ||
      v.includes("withdraw") ||
      v.includes("reject")
    );
  };
  // A row with no/unparseable timestamp sorts last rather than jumping to the
  // top, which is what NaN or 0 would do under a descending compare.
  const submittedAt = (s?: string | null) => {
    const t = s ? Date.parse(s) : NaN;
    // MIN_SAFE_INTEGER, not -Infinity: two undated rows would subtract to NaN,
    // and a comparator returning NaN leaves the sort order unspecified.
    return Number.isNaN(t) ? Number.MIN_SAFE_INTEGER : t;
  };
  const sorted = [...filtered].sort((a, b) => {
    const aTerm = isTerminal(a.status) ? 1 : 0;
    const bTerm = isTerminal(b.status) ? 1 : 0;
    if (aTerm !== bTerm) return aTerm - bTerm;
    const byDate = submittedAt(b.created_on) - submittedAt(a.created_on);
    if (byDate !== 0) return byDate;
    const aRank = PRIORITY_RANK[(a.priority ?? "").toLowerCase()] ?? 999;
    const bRank = PRIORITY_RANK[(b.priority ?? "").toLowerCase()] ?? 999;
    return aRank - bRank;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = sorted.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex = sorted.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, sorted.length);

  // Server-side xlsx, moved here from the Employee Tickets page when that was
  // dropped from the nav. It replaces the client-side CSV this page used to
  // build: that could only ever emit the rows already fetched, so it silently
  // truncated at the 200-row page size. The endpoint's scope was widened to
  // match this screen — the executor half plus the roster-scoped open pool.
  //
  // It does NOT cover the escalated-away rows: those are reachable only through
  // `previous_executor_user_id`, which the export endpoint takes no parameter
  // for. Exporting while the Escalated card is active therefore omits the half
  // of that card the caller handed off. Worth closing when the endpoint next
  // gets touched; it needs a backend change, not a parameter here.
  const handleExport = async () => {
    if (sorted.length === 0) {
      toast.info("Nothing to export");
      return;
    }
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (priorityFilter !== "All Priorities")
        params.set("priority", priorityFilter.toLowerCase());
      // The endpoint accepts `status` and the dropdown already holds the
      // server's own spelling ("in_progress"), so pass it through — without
      // this, narrowing the screen to one status still exported every status.
      if (statusFilter !== "all") params.set("status", statusFilter);
      const url = `${import.meta.env.VITE_SRM_API_BASE_URL}/requests/department-export${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      const res = await fetch(url, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = `ticket-queue_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err, "Failed to export ticket queue");
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading || awaitingSession) {
    return (
      <div className="space-y-6">
        <PageHeader title="Ticket Queue" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Ticket Queue" />
        <div className="rounded-xl border bg-card overflow-x-auto">
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load your assigned tickets"
            description="Please try again."
          />
        </div>
      </div>
    );
  }

  // `escalatedAway` has to count here too. Escalating hands the ticket to
  // someone else, so `queueItems` can be empty while the caller still has
  // escalations to track — and this early return would have swallowed the whole
  // page, cards included, for exactly the person who just escalated something.
  if (queueItems.length === 0 && escalatedAway.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Ticket Queue"
          subtitle="Tickets assigned to you, plus unassigned tickets in your categories"
        />
        <div className="rounded-xl border overflow-x-auto bg-card">
          <EmptyState
            icon={Inbox}
            title="No Tickets Assigned"
            description="There are no service tickets assigned to you for execution yet."
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Ticket Queue"
          subtitle="Tickets assigned to you, plus unassigned tickets in your categories"
        />

        {/* Stat cards — click to filter */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {CARD_DEFS.map((card) => {
            const Icon = card.icon;
            const isActive = activeCard === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setActiveCard(card.id);
                  setCurrentPage(1);
                }}
                className={`flex items-center gap-4 rounded-xl border bg-card px-5 py-4 text-left w-full transition-all hover:shadow-md ${
                  isActive
                    ? "ring-2 ring-primary border-primary/30"
                    : "hover:border-primary/30"
                }`}
                aria-pressed={isActive}
                aria-label={`Filter to ${card.label} (${cardCounts[card.id]})`}
              >
                <Icon
                  className={`size-8 shrink-0 ${
                    isActive ? "text-primary" : card.cls
                  }`}
                />
                <div>
                  <p className="text-xs text-muted-foreground font-medium">
                    {card.label}
                  </p>
                  <p
                    className={`text-xl font-semibold tabular-nums ${
                      isActive ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {cardCounts[card.id]}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="rounded-xl border overflow-x-auto bg-card">
          {/* Toolbar — single row */}
          <div className="flex items-center gap-3 border-b px-4 py-3 flex-wrap">
            <div className="relative min-w-0 max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by ID, type, or requester..."
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
                  <CalendarDays className="size-4" />
                  Submitted
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem>Today</DropdownMenuItem>
                <DropdownMenuItem>Last 7 days</DropdownMenuItem>
                <DropdownMenuItem>Last 30 days</DropdownMenuItem>
                <DropdownMenuItem>Custom range</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {[
              {
                value: categoryFilter,
                setter: setCategoryFilter,
                options: CATEGORIES,
              },
              {
                value: priorityFilter,
                setter: setPriorityFilter,
                options: PRIORITIES,
              },
              {
                value: statusFilter === "all" ? "All Status" : statusFilter,
                setter: (v: string) =>
                  setStatusFilter(
                    v === "All Status"
                      ? "all"
                      : v.toLowerCase().replace(/ /g, "_"),
                  ),
                options: STATUSES,
              },
            ].map(({ value, setter, options }) => (
              <DropdownMenu key={options[0]}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 text-muted-foreground font-normal h-9 capitalize max-w-[180px]"
                  >
                    <span className="truncate">{value}</span>
                    <ChevronDown className="size-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-64 overflow-y-auto"
                >
                  {options.map((o) => (
                    <DropdownMenuItem
                      key={o}
                      onClick={() => {
                        setter(o);
                        setCurrentPage(1);
                      }}
                    >
                      {o}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}

            <div className="ml-auto">
              <Button
                variant="outline"
                className="gap-2"
                onClick={handleExport}
                disabled={isExporting}
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
                  Priority
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                  Submitted
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                  SLA Deadline
                </TableHead>
                <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((item) => (
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
                  <TableCell className="text-muted-foreground max-w-[220px] truncate">
                    {item.request_type_name ?? item.request_type_id}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.requester_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <PriorityCell priority={item.priority} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(item.created_on)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(item.resolution_due_by)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <StatusCell status={item.status} />
                  </TableCell>
                </TableRow>
              ))}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <EmptyState
                      icon={Inbox}
                      title="No tickets found"
                      description="No tickets match your current filters."
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
            total={sorted.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setCurrentPage(1);
            }}
          />
        </div>
      </div>
      <RequestDetail id={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
};
