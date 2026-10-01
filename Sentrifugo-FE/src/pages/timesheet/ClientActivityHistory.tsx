import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Search,
  CheckCircle2,
  XCircle,
  Download,
  FileText,
  UserCircle,
  Clock,
} from "lucide-react";
import {
  useGetClientActivityHistoryQuery,
  useLazyExportActivityHistoryExcelQuery,
  useLazyExportActivityFullReportQuery,
} from "@/store/api/timesheetApi";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { TablePagination } from "@/components/shared/TablePagination";
import { formatDateTimeIST } from "@/lib/format-ist";

const formatDateTime = (d: string | null) => (d ? formatDateTimeIST(d) : "-");

const ClientActivityHistory = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchQuery, setSearchQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [actorFilter, setActorFilter] = useState<string>("all");

  const { data, isLoading } = useGetClientActivityHistoryQuery({
    page,
    page_size: pageSize,
    search: searchQuery || undefined,
    start_date: startDate || undefined,
    end_date: endDate || undefined,
    actor: actorFilter !== "all" ? actorFilter : undefined,
  });
  const [triggerExport, { isFetching: isExporting }] =
    useLazyExportActivityHistoryExcelQuery();
  const [triggerFullReport, { isFetching: isFullReporting }] =
    useLazyExportActivityFullReportQuery();

  const items = data?.items ?? [];
  const summary = data?.summary;
  const total = data?.total ?? 0;

  const uniqueActors = [...new Set(items.map((i) => i.approver_id))];

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    try {
      const result = await triggerExport({
        search: searchQuery || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        actor: actorFilter !== "all" ? actorFilter : undefined,
      }).unwrap();
      downloadBlob(result, "activity_history_export.xlsx");
    } catch (err) {
      toast.error(err, "Export failed. Please try again.");
    }
  };

  const handleFullReport = async () => {
    try {
      const result = await triggerFullReport().unwrap();
      downloadBlob(result, "activity_full_report.xlsx");
    } catch (err) {
      toast.error(err, "Report download failed. Please try again.");
    }
  };

  const handleReset = () => {
    setSearchQuery("");
    setStartDate("");
    setEndDate("");
    setActorFilter("all");
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Review Activity History"
        subtitle="Audit log of all timesheet approval and rejection decisions."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={isExporting}
            >
              {isExporting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              Export
            </Button>
            <Button
              size="sm"
              onClick={handleFullReport}
              disabled={isFullReporting}
            >
              {isFullReporting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <FileText />
              )}
              Full Report
            </Button>
          </div>
        }
      />

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">
                Total Reviews
              </p>
              <p className="text-2xl font-bold text-foreground">
                {summary.total_reviews.toLocaleString()}
              </p>
            </div>
            <Clock className="size-8 shrink-0 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">
                Approved (MTD)
              </p>
              <p className="text-2xl font-bold text-foreground">
                {summary.approved_mtd.toLocaleString()}
              </p>
            </div>
            <CheckCircle2 className="size-8 shrink-0 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">
                Rejected (MTD)
              </p>
              <p className="text-2xl font-bold text-foreground">
                {summary.rejected_mtd.toLocaleString()}
              </p>
            </div>
            <XCircle className="size-8 shrink-0 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground font-medium">
                Avg. Decision Time
              </p>
              <p className="text-2xl font-bold text-foreground">
                {summary.avg_decision_time_hours}h
              </p>
            </div>
            <UserCircle className="size-8 shrink-0 text-muted-foreground" />
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap rounded-xl border bg-card px-4 py-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by employee, project, or ID..."
            className="pl-9 h-8"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="flex items-center gap-2">
          <Input
            type="date"
            className="w-40 h-8"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setPage(1);
            }}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            className="w-40 h-8"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <Select
          value={actorFilter}
          onValueChange={(v) => {
            setActorFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All Actors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actors</SelectItem>
            {uniqueActors.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="ghost" size="sm" onClick={handleReset}>
          Reset
        </Button>
      </div>

      {/* Table */}
      {isLoading ? (
        <PageLoader message="Loading activity history..." />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No activity history found"
          description="Approval and rejection decisions will appear here."
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Decision Maker (Actor)
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Employee & Project
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-center">
                  Hours
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Action
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Client Comment
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(item.acted_at)}
                      </div>
                      <div className="flex items-center gap-2">
                        <UserCircle className="size-8 text-muted-foreground" />
                        <div>
                          <div className="text-sm font-medium">
                            {item.approver_name ?? item.approver_id}
                          </div>
                          <div className="text-xs text-muted-foreground capitalize">
                            {item.approver_role}
                          </div>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <UserCircle className="size-8 text-muted-foreground" />
                      <div>
                        <div className="text-sm font-medium">
                          {item.employee_name || item.employee_id}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.project_names.length > 0
                            ? item.project_names.join(", ")
                            : "-"}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-foreground">
                      {item.hours} hrs
                    </span>
                  </TableCell>
                  <TableCell>
                    {item.action === "approved" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                        <CheckCircle2 /> Approved
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                        <XCircle /> Rejected
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    {item.comments ? (
                      <p
                        className="text-sm text-muted-foreground italic truncate"
                        title={item.comments}
                      >
                        "{item.comments}"
                      </p>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination
            currentPage={page}
            totalPages={Math.ceil(total / pageSize)}
            startIndex={Math.min((page - 1) * pageSize + 1, total)}
            endIndex={Math.min(page * pageSize, total)}
            total={total}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}
    </div>
  );
};

export default ClientActivityHistory;
