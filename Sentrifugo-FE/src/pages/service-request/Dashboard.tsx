import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "react-redux";
import {
  Search,
  Ticket,
  AlertCircle,
  Clock,
  CheckCircle2,
  Loader2,
  Inbox,
  Download,
  SlidersHorizontal,
  ChevronDown,
  CalendarDays,
  Plus,
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { TablePagination } from "@/components/shared/TablePagination";
import { StatusCell, PriorityCell } from "./MyRequestList";
import { RequestDetail } from "./RequestDetail";
import { RequestForm } from "./RequestForm";
import {
  useGetDashboardSummaryQuery,
  useGetRequestsQuery,
  useGetCategoriesQuery,
} from "@/store/api/srmApi";

const SRM_BASE_URL = import.meta.env.VITE_SRM_API_BASE_URL as string;

const cardIcons: Record<string, typeof Ticket> = {
  total: Ticket,
  open: AlertCircle,
  approved: CheckCircle2,
  rejected: Clock,
};

const exportRanges = [
  "Current Month",
  "Last Month",
  "Last 3 Months",
  "Last 6 Months",
  "Current Year",
  "Last Year",
  "Custom Range",
];

const dateRangeMap: Record<string, string> = {
  "Current Month": "current_month",
  "Last Month": "last_month",
  "Last 3 Months": "last_3_months",
  "Last 6 Months": "last_6_months",
  "Current Year": "current_year",
  "Last Year": "last_year",
};

// Stable enum from BE.
const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;

// Title-case helper for status labels (e.g. "pending_approval" → "Pending Approval").
function titleCaseStatus(s: string) {
  return s
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Date-range presets.
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

export const Dashboard = () => {
  const navigate = useNavigate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessToken = useSelector(
    (state: any) => state.auth.accessToken as string,
  );

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [priorityValue, setPriorityValue] = useState<string>("all");
  const [statusValue, setStatusValue] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRangeId>("all");
  const [activeCard, setActiveCard] = useState("total");
  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportRange, setExportRange] = useState("Custom Range");
  const [exportFormat, setExportFormat] = useState("csv");
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [exporting, setExporting] = useState(false);

  const { data: summaryData, isLoading: summaryLoading } =
    useGetDashboardSummaryQuery();
  const { data: requestsData, isLoading: requestsLoading } =
    useGetRequestsQuery();

  const cards = summaryData?.cards ?? [];
  const requests = requestsData?.items ?? [];

  // Dynamic option lists.
  const { data: categoriesData } = useGetCategoriesQuery({ page_size: 200 });
  const categories = (categoriesData?.items ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const selectedCategoryLabel =
    categoryId === "all"
      ? "All Categories"
      : (categories.find((c) => c.id === categoryId)?.name ?? "Category");

  const statusValuesPresent = Array.from(
    new Set(
      requests.map((r) => (r.status ?? "").toLowerCase()).filter(Boolean),
    ),
  ).sort();
  const selectedStatusLabel =
    statusValue === "all" ? "All Status" : titleCaseStatus(statusValue);

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

  const getCardFilter = (card: {
    id: string;
    filter: Record<string, string>;
  }) => {
    const { id, filter = {} } = card;
    if (filter.status) return (s: string) => s === filter.status;
    if (filter.status_group === "open" || id === "open")
      return (s: string) => !s.includes("resolv") && s !== "closed";
    if (id === "approved")
      return (s: string) =>
        s.includes("approv") ||
        s.includes("pending_assign") ||
        s.includes("resolv") ||
        s === "closed" ||
        s.includes("initial") ||
        s.includes("response");
    return () => true;
  };

  const filtered = requests.filter((req) => {
    const matchesSearch =
      (req.ticket_no ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (req.request_type_name ?? "")
        .toLowerCase()
        .includes(search.toLowerCase()) ||
      (req.requester_name ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesCat = categoryId === "all" || req.category_id === categoryId;
    const matchesPri =
      priorityValue === "all" ||
      (req.priority ?? "").toLowerCase() === priorityValue;
    const matchesSt =
      statusValue === "all" || (req.status ?? "").toLowerCase() === statusValue;
    const matchesDate =
      !dateFloor ||
      (req.created_on ? new Date(req.created_on) >= dateFloor : false);
    const activeCardData = cards.find((c) => c.id === activeCard);
    const cardFn = activeCardData ? getCardFilter(activeCardData) : () => true;
    const matchesCard = cardFn(req.status?.toLowerCase() ?? "");
    return (
      matchesSearch &&
      matchesCat &&
      matchesPri &&
      matchesSt &&
      matchesDate &&
      matchesCard
    );
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, filtered.length);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      params.set("format", exportFormat);
      if (exportRange !== "Custom Range") {
        params.set("date_range", dateRangeMap[exportRange]);
      } else {
        if (exportStartDate) params.set("start_date", exportStartDate);
        if (exportEndDate) params.set("end_date", exportEndDate);
      }
      const res = await fetch(`${SRM_BASE_URL}/requests/export?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const blob = await res.blob();
      const contentDisposition = res.headers.get("content-disposition");
      const filename =
        contentDisposition?.match(/filename="?(.+?)"?$/)?.[1] ??
        `export.${exportFormat}`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);
      setExportDialogOpen(false);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employee Tickets"
        subtitle="Monitor and manage all service tickets across your team"
        action={
          <Button onClick={() => setNewRequestOpen(true)}>
            <Plus />
            New Ticket
          </Button>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {summaryLoading ? (
          <div className="col-span-4 flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          cards.map((card) => {
            const Icon = cardIcons[card.id] ?? Ticket;
            const isActive = activeCard === card.id;
            return (
              <div
                key={card.id}
                onClick={() => {
                  setActiveCard(card.id);
                  setCurrentPage(1);
                }}
                className={`flex items-center justify-between rounded-xl border px-5 py-4 cursor-pointer transition-colors ${isActive ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/50"}`}
              >
                <div>
                  <p className="text-xs text-muted-foreground font-medium">
                    {card.label}
                  </p>
                  <p className="text-2xl font-bold text-foreground">
                    {card.value}
                  </p>
                </div>
                <Icon className="size-8 shrink-0 text-muted-foreground" />
              </div>
            );
          })
        )}
      </div>

      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar row 1: search + filters + export */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by Ticket ID, Type, or Requestor..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9"
            />
          </div>
          <Button variant="outline" className="gap-2">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            Apply Filters
          </Button>
          <div className="ml-auto">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setExportDialogOpen(true)}
            >
              <Download className="size-4 text-muted-foreground" />
              Export Data
            </Button>
          </div>
        </div>

        {/* Toolbar row 2: filter dropdowns */}
        <div className="flex items-center gap-3 border-b px-4 py-2">
          {/* Date range */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-8"
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
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-8 max-w-[200px]"
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
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-8"
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
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-8"
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
                  setActiveCard("total");
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
                    setActiveCard("total");
                    setCurrentPage(1);
                  }}
                >
                  {titleCaseStatus(s)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {requestsLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Ticket ID
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Ticket Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-foreground uppercase tracking-wide h-10">
                    Requestor
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
                    Resolved Date
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
                    <TableCell className="text-muted-foreground max-w-[160px] truncate">
                      {req.request_type_name ?? req.request_type_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {req.requester_name ?? req.requester_user_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {req.category_name ?? req.category_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <PriorityCell priority={req.priority ?? "�"} />
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
                      {"—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <StatusCell status={req.status} />
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <EmptyState
                        icon={Inbox}
                        title="No tickets found"
                        description="No service tickets match your search."
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

      {/* Export Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export Data</DialogTitle>
            <DialogDescription>
              Download service ticket data based on a selected date range
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm font-medium">Select Date Range</p>
            <div className="grid grid-cols-2 gap-2">
              {exportRanges.map((range) => (
                <label
                  key={range}
                  className="flex items-center gap-2 cursor-pointer text-sm"
                >
                  <input
                    type="radio"
                    name="exportRange"
                    checked={exportRange === range}
                    onChange={() => setExportRange(range)}
                    className="accent-primary cursor-pointer"
                  />
                  <span className="text-foreground">{range}</span>
                </label>
              ))}
            </div>

            {exportRange === "Custom Range" && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Start Date
                  </label>
                  <Input
                    type="date"
                    value={exportStartDate}
                    onChange={(e) => setExportStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    End Date
                  </label>
                  <Input
                    type="date"
                    value={exportEndDate}
                    onChange={(e) => setExportEndDate(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <span className="text-sm font-medium">File Format</span>
              <select
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value)}
                className="border border-border rounded-md px-2.5 py-1 text-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="csv">CSV</option>
                <option value="excel">Excel</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2.5 pt-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="soft" onClick={handleExport} disabled={exporting}>
              {exporting && <Loader2 className="animate-spin" />}
              <Download />
              {exporting ? "Downloading..." : "Download"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <RequestDetail id={selectedId} onClose={() => setSelectedId(null)} />
      <RequestForm open={newRequestOpen} onOpenChange={setNewRequestOpen} />
    </div>
  );
};
