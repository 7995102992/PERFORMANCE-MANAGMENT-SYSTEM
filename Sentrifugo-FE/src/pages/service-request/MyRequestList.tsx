import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Loader2,
  Search,
  FileSpreadsheet,
  CalendarDays,
  ChevronDown,
  CircleCheck,
  History,
  Check,
  CircleX,
  Clock,
  FileText,
  MailOpen,
  CheckCircle2,
  XCircle,
  Inbox,
  RotateCcw,
  Plus,
  ArrowDown,
  Minus,
  ArrowUp,
  Zap,
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
import { TablePagination } from "@/components/shared/TablePagination";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useGetRequestsQuery,
  useGetRequestTypesQuery,
  useGetCategoriesQuery,
} from "@/store/api/srmApi";
import { toast } from "@/lib/toast";
import { store } from "@/store";
import { RequestDetail } from "./RequestDetail";
import { RequestForm } from "./RequestForm";

type SRStatus = string;

// "pending_approval" → "Pending Approval"
function titleCaseStatus(status: string) {
  return status
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function StatusCell({
  status,
  levelIndex,
}: {
  status: SRStatus;
  levelIndex?: number | null;
}) {
  const s = (status ?? "").toLowerCase();
  const base = titleCaseStatus(status ?? "");
  // Surface the approval level (L1/L2) for pending-approval and rejected
  // tickets when known — mirrors the status-filter labels below.
  const label =
    levelIndex != null && (s === "pending_approval" || s === "rejected")
      ? `${base} (L${levelIndex})`
      : base;
  if (s.includes("resolved") || s.includes("closed")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleCheck className="size-3.5 shrink-0 text-success" />
        {label}
      </span>
    );
  }
  if (s.includes("in_progress") || s.includes("progress")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <History className="size-3.5 shrink-0 text-badge-inprogress-text" />
        {label}
      </span>
    );
  }
  if (s === "open" || s === "submitted" || s === "assigned") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Check className="size-3.5 shrink-0 text-badge-open-text" />
        {label}
      </span>
    );
  }
  if (s.includes("pending")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Clock className="size-3.5 shrink-0 text-badge-pending-text" />
        {label}
      </span>
    );
  }
  if (s.includes("reject") || s.includes("cancel")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleX className="size-3.5 shrink-0 text-destructive" />
        {label}
      </span>
    );
  }
  if (s.includes("withdraw")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CircleX className="size-3.5 shrink-0 text-muted-foreground" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
      {label}
    </span>
  );
}

const PRIORITY_CONFIG: Record<
  string,
  { icon: React.ElementType; colorClass: string; label: string }
> = {
  low: { icon: ArrowDown, colorClass: "text-success", label: "Low" },
  medium: { icon: Minus, colorClass: "text-warning", label: "Medium" },
  high: { icon: ArrowUp, colorClass: "text-destructive", label: "High" },
  urgent: { icon: Zap, colorClass: "text-destructive", label: "Urgent" },
};

export function PriorityCell({ priority }: { priority: string }) {
  const p = (priority ?? "").toLowerCase();
  const config = PRIORITY_CONFIG[p];
  if (!config) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  const Icon = config.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
      <Icon className={`size-3.5 shrink-0 ${config.colorClass}`} />
      {config.label}
    </span>
  );
}

// Stable enum from BE; safe to hardcode.
const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;

// Date-range presets used by the Date dropdown.
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

export const MyRequestList = () => {
  // Filtered, sorted and paged client-side (like the department list), so the
  // whole scope has to be in hand. Without an explicit page_size the API caps
  // the response at 25 and everything older silently disappeared from the table.
  //
  // True server-side paging isn't possible for this screen as the API stands:
  // /requests has no `request_type_id` param for the Ticket Type filter, and no
  // sort param for the open-first / priority ordering below. 200 is the API
  // ceiling; beyond that this needs those two params added server-side.
  const { data, isLoading, isError } = useGetRequestsQuery({
    my_requests: true,
    page_size: 200,
  });
  const requests = data?.items ?? [];

  // Cards are client-side: counts always come from the full ticket list and
  // clicking a card narrows the table to that group. Doesn't depend on the
  // backend summary endpoint, which can return empty.
  type CardId = "all" | "pending" | "active" | "completed" | "cancelled";
  type CardDef = {
    id: CardId;
    label: string;
    icon: typeof FileText;
    match: (status: string) => boolean;
  };
  const CARD_DEFS: CardDef[] = [
    {
      id: "all",
      label: "All",
      icon: FileText,
      match: () => true,
    },
    {
      id: "pending",
      label: "Pending",
      icon: Clock,
      match: (s) =>
        s === "submitted" ||
        s === "pending_approval" ||
        s === "pending_assignment",
    },
    {
      id: "active",
      label: "Active",
      icon: MailOpen,
      match: (s) => s === "assigned" || s === "in_progress",
    },
    {
      id: "completed",
      label: "Completed",
      icon: CheckCircle2,
      match: (s) => s === "resolved" || s === "closed",
    },
    {
      id: "cancelled",
      label: "Cancelled",
      icon: XCircle,
      match: (s) => s === "rejected" || s === "withdrawn",
    },
  ];

  const cardCounts: Record<CardId, number> = CARD_DEFS.reduce(
    (acc, c) => {
      acc[c.id] = requests.filter((r) =>
        c.match((r.status ?? "").toLowerCase()),
      ).length;
      return acc;
    },
    {} as Record<CardId, number>,
  );

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [requestTypeFilter, setRequestTypeFilter] = useState<string>("all");
  const [priorityValue, setPriorityValue] = useState<string>("all");
  const [statusValue, setStatusValue] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRangeId>("all");
  const [activeCard, setActiveCard] = useState<CardId>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Deep links from email, both read once on mount then stripped so a refresh /
  // back doesn't re-open anything:
  //   ?raise=1&category=<id>&subtype=<id>  → Raise Ticket sheet, pre-populated
  //   ?request=<id>                        → that ticket's detail overlay
  //                                          (comment-added mail)
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as Record<
    string,
    string | undefined
  >;
  const [raiseInitial, setRaiseInitial] = useState<{
    category?: string;
    subtype?: string;
  }>({});
  useEffect(() => {
    if (searchParams?.raise === "1") {
      setRaiseInitial({
        category: searchParams.category,
        subtype: searchParams.subtype,
      });
      setNewRequestOpen(true);
    } else if (searchParams?.request) {
      setSelectedId(searchParams.request);
    } else {
      return;
    }
    navigate({
      to: "/service-request/my-requests/list",
      search: {},
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Request type list for the dropdown filter. Backend returns one row per
  // (request_type x SLA-rule) so dedupe to unique RTs.
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

  // Category list — fetched live so the dropdown reflects real seeded names.
  const { data: categoriesData } = useGetCategoriesQuery({ page_size: 200 });
  const categories = (categoriesData?.items ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const selectedCategoryLabel =
    categoryId === "all"
      ? "All Categories"
      : (categories.find((c) => c.id === categoryId)?.name ?? "Category");

  // Status options — derive distinct values from the loaded requests so the
  // dropdown only shows statuses the user actually has tickets in.
  // Rejected tickets are split by the level that rejected them: a ticket
  // rejected at L1 becomes "rejected_l1", at L2 becomes "rejected_l2", etc.
  // Tickets with no level info fall back to plain "rejected".
  const statusKeyOf = (r: {
    status?: string | null;
    rejected_at_level?: number | null;
    current_level_index?: number | null;
  }) => {
    const s = (r.status ?? "").toLowerCase();
    if (s === "rejected" && r.rejected_at_level != null) {
      return `rejected_l${r.rejected_at_level}`;
    }
    if (s === "pending_approval" && r.current_level_index != null) {
      return `pending_approval_l${r.current_level_index}`;
    }
    return s;
  };
  const statusValuesPresent = Array.from(
    new Set(requests.map(statusKeyOf).filter(Boolean)),
  ).sort();
  const statusLabelOf = (key: string) => {
    const rej = key.match(/^rejected_l(\d+)$/);
    if (rej) return `Rejected (L${rej[1]})`;
    const pend = key.match(/^pending_approval_l(\d+)$/);
    if (pend) return `Pending Approval (L${pend[1]})`;
    return titleCaseStatus(key);
  };
  const selectedStatusLabel =
    statusValue === "all" ? "All Status" : statusLabelOf(statusValue);

  // Priority options — fixed enum, but restrict to those present so the
  // dropdown stays tidy. Falls back to the full enum if nothing's loaded yet.
  const priorityValuesPresent = PRIORITY_VALUES.filter((p) =>
    requests.some((r) => (r.priority ?? "").toLowerCase() === p),
  );
  const priorityOptions =
    priorityValuesPresent.length > 0
      ? priorityValuesPresent
      : [...PRIORITY_VALUES];
  const selectedPriorityLabel =
    priorityValue === "all"
      ? "All Priorities"
      : priorityValue.charAt(0).toUpperCase() + priorityValue.slice(1);

  const selectedDateLabel =
    DATE_RANGE_OPTIONS.find((d) => d.id === dateRange)?.label ?? "All time";
  const dateFloor = startOfRange(dateRange);

  const activeCardDef =
    CARD_DEFS.find((c) => c.id === activeCard) ?? CARD_DEFS[0];
  const activeCardFilter = (s: string) => activeCardDef.match(s);

  // Reset button is shown only when at least one filter has moved off its
  // default. Clicking returns every filter (cards, dropdowns, search, dates)
  // to its initial state.
  const hasActiveFilters =
    search !== "" ||
    categoryId !== "all" ||
    requestTypeFilter !== "all" ||
    priorityValue !== "all" ||
    statusValue !== "all" ||
    dateRange !== "all" ||
    activeCard !== "all";
  const resetFilters = () => {
    setSearch("");
    setCategoryId("all");
    setRequestTypeFilter("all");
    setPriorityValue("all");
    setStatusValue("all");
    setDateRange("all");
    setActiveCard("all");
    setCurrentPage(1);
  };

  const filtered = requests.filter((req) => {
    const needle = search.toLowerCase();
    const matchesSearch =
      (req.ticket_no ?? "").toLowerCase().includes(needle) ||
      (req.title ?? "").toLowerCase().includes(needle) ||
      (req.request_type_name ?? "").toLowerCase().includes(needle);
    const matchesCat = categoryId === "all" || req.category_id === categoryId;
    const matchesRt =
      requestTypeFilter === "all" || req.request_type_id === requestTypeFilter;
    const matchesPri =
      priorityValue === "all" ||
      (req.priority ?? "").toLowerCase() === priorityValue;
    const matchesSt = statusValue === "all" || statusKeyOf(req) === statusValue;
    const matchesDate =
      !dateFloor ||
      (req.created_on ? new Date(req.created_on) >= dateFloor : false);
    const matchesCard = activeCardFilter(req.status?.toLowerCase() ?? "");
    return (
      matchesSearch &&
      matchesCat &&
      matchesRt &&
      matchesPri &&
      matchesSt &&
      matchesDate &&
      matchesCard
    );
  });

  // Default ordering: open tickets first (sorted by priority urgent->low), then
  // resolved/closed tickets last (also priority-sorted within that group).
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
  const sorted = [...filtered].sort((a, b) => {
    const aTerm = isTerminal(a.status) ? 1 : 0;
    const bTerm = isTerminal(b.status) ? 1 : 0;
    if (aTerm !== bTerm) return aTerm - bTerm;
    const aRank = PRIORITY_RANK[(a.priority ?? "").toLowerCase()] ?? 999;
    const bRank = PRIORITY_RANK[(b.priority ?? "").toLowerCase()] ?? 999;
    return aRank - bRank;
  });

  const handleExport = async () => {
    if (sorted.length === 0) {
      toast.info("Nothing to export");
      return;
    }
    setIsExporting(true);
    try {
      const token = store.getState().auth.accessToken;
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (categoryId !== "all") params.set("category_id", categoryId);
      if (requestTypeFilter !== "all")
        params.set("request_type_id", requestTypeFilter);
      if (priorityValue !== "all") params.set("priority", priorityValue);
      if (statusValue !== "all") params.set("status", statusValue);
      const url = `${import.meta.env.VITE_SRM_API_BASE_URL}/requests/my-export${
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
      a.download = `my-service-tickets_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err, "Failed to export tickets");
    } finally {
      setIsExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = sorted.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex = sorted.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, sorted.length);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Tickets"
        subtitle="Track and manage your submitted service tickets"
        action={
          <Button onClick={() => setNewRequestOpen(true)}>
            <Plus />
            New Ticket
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
        {/* Toolbar — single row */}
        <div className="flex items-center gap-3 border-b px-4 py-3 flex-wrap">
          <div className="relative min-w-0 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by Ticket ID, Title, or Ticket Type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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

          {/* Category — dynamic from /categories */}
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

          {/* Priority — derived from loaded requests */}
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

          {/* Status — derived from loaded requests */}
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
                  setActiveCard("all");
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
                    setActiveCard("all");
                    setCurrentPage(1);
                  }}
                >
                  {statusLabelOf(s)}
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

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {isError && (
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load tickets"
            description="Please try again."
          />
        )}

        {!isLoading && !isError && (
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
                      Category
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Priority
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Created Date
                    </TableHead>
                    <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                      Status
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginated.map((req) => (
                    <TableRow
                      key={req.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(req.id)}
                    >
                      <TableCell className="text-muted-foreground font-medium">
                        {req.ticket_no}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-medium">
                        {(req.title ?? "").length > 15 ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default">
                                  {(req.title ?? "").slice(0, 15)}…
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{req.title}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          req.title
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[200px] truncate">
                        {req.request_type_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {req.category_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <PriorityCell priority={req.priority ?? "—"} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(req.created_on)
                          .toLocaleDateString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            timeZone: "Asia/Kolkata",
                          })
                          .replace(/ /g, "-")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <StatusCell
                          status={req.status}
                          levelIndex={
                            (req.status ?? "").toLowerCase() === "rejected"
                              ? req.rejected_at_level
                              : req.current_level_index
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {sorted.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="p-0">
                        <EmptyState
                          icon={Inbox}
                          title="No tickets found"
                          description="You haven't submitted any service tickets yet."
                          action={
                            <Button
                              onClick={() => setNewRequestOpen(true)}
                            >
                              <Plus />
                              New Ticket
                            </Button>
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
              total={filtered.length}
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
      <RequestForm
        open={newRequestOpen}
        onOpenChange={setNewRequestOpen}
        initialCategoryId={raiseInitial.category}
        initialRequestTypeId={raiseInitial.subtype}
      />
    </div>
  );
};
