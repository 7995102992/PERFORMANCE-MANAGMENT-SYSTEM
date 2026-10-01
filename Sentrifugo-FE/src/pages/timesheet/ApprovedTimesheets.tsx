import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { CheckCircle2, Eye } from "lucide-react";
import {
  useGetMyTimesheetsQuery,
  useGetProjectsQuery,
} from "@/store/api/timesheetApi";
import type { WeeklyTimesheetResponse } from "@/types/timesheet";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";

const formatDate = (d: string) => {
  const date = new Date(d);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
};

const ApprovedTimesheets = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [viewDetail, setViewDetail] = useState<WeeklyTimesheetResponse | null>(
    null,
  );

  const { data, isLoading } = useGetMyTimesheetsQuery({
    page,
    page_size: pageSize,
  });
  const { data: projects } = useGetProjectsQuery({
    page: 1,
    page_size: 100,
    status: "all",
  });

  const projectMap = new Map(
    (projects?.items ?? []).map((p) => [p.id, p.name]),
  );

  const approvedTimesheets = (data?.items ?? []).filter((ts) =>
    ["l1_approved", "client_approved"].includes(ts.timesheet_status),
  );
  const total = data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approved Timesheets"
        subtitle="View your approved timesheet history"
      />

      {isLoading ? (
        <PageLoader message="Loading timesheets…" />
      ) : approvedTimesheets.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No approved timesheets yet"
          description="Timesheets approved by your manager will appear here."
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Week
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Total Hours
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Status
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                  Approved On
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvedTimesheets.map((ts) => (
                <TableRow key={ts.id}>
                  <TableCell className="font-medium">
                    {formatDate(ts.week_start_date)} -{" "}
                    {formatDate(ts.week_end_date)}
                  </TableCell>
                  <TableCell>{ts.total_hours} hrs</TableCell>
                  <TableCell>
                    <StatusBadge
                      status={
                        ts.timesheet_status === "client_approved"
                          ? "client_approved"
                          : "l1_approved"
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {formatDate(ts.updated_on ?? ts.created_on)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => setViewDetail(ts)}
                    >
                      <Eye className="size-4" />
                    </Button>
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

      <Dialog open={!!viewDetail} onOpenChange={() => setViewDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Approved Timesheet Detail</DialogTitle>
          </DialogHeader>
          {viewDetail && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Week</p>
                  <p className="text-sm font-medium">
                    {formatDate(viewDetail.week_start_date)} -{" "}
                    {formatDate(viewDetail.week_end_date)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total Hours</p>
                  <p className="text-sm font-medium">
                    {viewDetail.total_hours}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <p className="text-sm font-medium capitalize">
                    {viewDetail.timesheet_status.replace("_", " ")}
                  </p>
                </div>
              </div>
              {(viewDetail.entries?.length ?? 0) > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Project
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Task
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Date
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                        Hours
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {viewDetail.entries?.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          {projectMap.get(entry.project_id) ?? entry.project_id}
                        </TableCell>
                        <TableCell>{entry.task_id}</TableCell>
                        <TableCell>{formatDate(entry.entry_date)}</TableCell>
                        <TableCell>{entry.hours}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ApprovedTimesheets;
