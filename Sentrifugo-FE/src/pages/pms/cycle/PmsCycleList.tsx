import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  Download,
  Eye,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { TablePagination } from "@/components/shared/TablePagination";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { toast } from "@/lib/toast";
import {
  useExportPmsCyclesMutation,
  useGetPmsCyclesQuery,
  useGetPmsPlantsQuery,
} from "@/store/api/pmsApi";
import type {
  PmsAppraisalType,
  PmsCycleListItem,
  PmsCycleListParams,
} from "@/types/pms";
import { CycleStatCards, type CycleFilter } from "./components/CycleStatCards";
import { CycleStatusBadge } from "./components/CycleStatusBadge";
import {
  APPRAISAL_TYPE_LABEL,
  APPRAISAL_TYPE_OPTIONS,
  CYCLE_STATUS_META,
} from "./cycle.constants";
import {
  financialYearLabel,
  formatDisplayDate,
  formatMonthYear,
} from "../shared/pms.utils";

/**
 * PMS cycle list: stat cards that double as status filters, a search box and filters, the cycle table
 * with per-row actions, pagination, and export. Opens the wizard to create, edit or view a cycle.
 */
const ALL = "all";

const HEADERS = [
  "Cycle ID",
  "Cycle Name",
  "Type",
  "Appraisal Period",
  "Applicable To",
  "Created On",
  "Status",
  "",
];

// Last three financial years plus the next one.
const YEAR_OPTIONS = (() => {
  const now = new Date();
  const current = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return [current + 1, current, current - 1, current - 2, current - 3];
})();

const PmsCycleList = () => {
  const navigate = useNavigate();

  const [status, setStatus] = useState<CycleFilter>(ALL);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [plant, setPlant] = useState(ALL);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const debouncedSearch = useDebouncedValue(search, 300);

  const params = useMemo<PmsCycleListParams>(
    () => ({
      search: debouncedSearch.trim() || undefined,
      year: year === ALL ? undefined : Number(year),
      type: type === ALL ? undefined : (type as PmsAppraisalType),
      plant_id: plant === ALL ? undefined : plant,
      status: status === ALL ? undefined : status,
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
    [debouncedSearch, year, type, plant, status, page, pageSize],
  );

  const { data, isLoading, isFetching } = useGetPmsCyclesQuery(params);
  const { data: plants = [] } = useGetPmsPlantsQuery();
  const [exportCycles, { isLoading: exporting }] = useExportPmsCyclesMutation();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters =
    search !== "" || year !== ALL || type !== ALL || plant !== ALL || status !== ALL;

  // Any filter change goes back to page 1.
  const withReset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  const resetFilters = () => {
    setStatus(ALL);
    setSearch("");
    setYear(ALL);
    setType(ALL);
    setPlant(ALL);
    setPage(1);
  };

  const openCycle = (cycle: PmsCycleListItem, edit = false) =>
    navigate({
      to: edit ? "/pms/cycle/$cycleId/edit" : "/pms/cycle/$cycleId",
      params: { cycleId: cycle.id },
    });

  const handleExport = async () => {
    try {
      const blob = await exportCycles({ ...params, skip: undefined, limit: undefined }).unwrap();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "pms-cycles.csv";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(e, "Could not export the cycles");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="PMS Cycle"
        subtitle="Create and manage appraisal cycles for your organization"
        action={
          <Button onClick={() => navigate({ to: "/pms/cycle/new" })}>
            <Plus /> Initialize New Appraisal
          </Button>
        }
      />

      <CycleStatCards
        summary={data?.summary}
        selected={status}
        onSelect={withReset(setStatus)}
        loading={isLoading}
      />

      <div className="overflow-hidden rounded-xl border bg-card">
        <Tabs
          value={status}
          onValueChange={(v) => withReset(setStatus)(v as CycleFilter)}
        >
          <TabsList className="px-3">
            <TabsTrigger value="all">All Cycles</TabsTrigger>
            {(["active", "draft", "closed", "cancelled"] as const).map((s) => (
              <TabsTrigger key={s} value={s}>
                {CYCLE_STATUS_META[s].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2.5 p-4">
          <div className="relative w-full sm:w-64">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={16}
            />
            <Input
              value={search}
              onChange={(e) => withReset(setSearch)(e.target.value)}
              placeholder="Search Cycle ID or name…"
              className="pl-9"
            />
          </div>

          <Select value={year} onValueChange={withReset(setYear)}>
            <SelectTrigger className="w-36">
              <CalendarDays className="size-4 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Years</SelectItem>
              {YEAR_OPTIONS.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {financialYearLabel(y)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={type} onValueChange={withReset(setType)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Types</SelectItem>
              {APPRAISAL_TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={plant} onValueChange={withReset(setPlant)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Plants</SelectItem>
              {plants.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={status}
            onValueChange={(v) => withReset(setStatus)(v as CycleFilter)}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Status</SelectItem>
              {(["draft", "active", "closed", "cancelled"] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {CYCLE_STATUS_META[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
            {hasFilters && (
              <Button variant="ghost" onClick={resetFilters}>
                <RotateCcw /> Reset
              </Button>
            )}
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Download /> {exporting ? "Exporting…" : "Export Data"}
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="border-y border-table-border bg-table-header hover:bg-table-header">
              {HEADERS.map((h, i) => (
                <TableHead
                  key={h || i}
                  className="h-10 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className={isFetching && !isLoading ? "opacity-60 transition-opacity" : ""}>
            {isLoading ? (
              Array.from({ length: 5 }, (_, r) => (
                <TableRow key={r}>
                  {HEADERS.map((_h, c) => (
                    <TableCell key={c}>
                      <Skeleton className="h-4 w-full max-w-[9rem]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={HEADERS.length}>
                  <EmptyState
                    icon={CalendarDays}
                    title={hasFilters ? "No cycles match your filters" : "No appraisal cycles yet"}
                    description={
                      hasFilters
                        ? "Try a different search or clear the filters."
                        : "Initialize a new appraisal to get started."
                    }
                    action={
                      hasFilters ? (
                        <Button variant="outline" onClick={resetFilters}>
                          <RotateCcw /> Reset filters
                        </Button>
                      ) : (
                        <Button onClick={() => navigate({ to: "/pms/cycle/new" })}>
                          <Plus /> Initialize New Appraisal
                        </Button>
                      )
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              items.map((cycle) => {
                const editable = cycle.status === "draft" || cycle.status === "active";
                return (
                  <TableRow
                    key={cycle.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => openCycle(cycle)}
                  >
                    <TableCell className="font-semibold text-foreground">
                      {cycle.cycle_code}
                    </TableCell>
                    <TableCell className="text-foreground">{cycle.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {APPRAISAL_TYPE_LABEL[cycle.type]}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatMonthYear(cycle.period_start)} –{" "}
                      {formatMonthYear(cycle.period_end)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {cycle.applicable_to}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDisplayDate(cycle.created_on)}
                    </TableCell>
                    <TableCell>
                      <CycleStatusBadge status={cycle.status} />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`View ${cycle.name}`}
                              onClick={() => openCycle(cycle)}
                            >
                              <Eye />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>View</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            {/* span: a disabled button swallows hover, so the tooltip needs a live wrapper */}
                            <span>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${cycle.name}`}
                                disabled={!editable}
                                onClick={() => openCycle(cycle, true)}
                              >
                                <Pencil />
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {editable ? "Edit" : `${CYCLE_STATUS_META[cycle.status].label} cycles can't be edited`}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <TablePagination
          currentPage={page}
          totalPages={totalPages}
          startIndex={(page - 1) * pageSize + 1}
          endIndex={Math.min(page * pageSize, total)}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </div>
    </div>
  );
};

export default PmsCycleList;
